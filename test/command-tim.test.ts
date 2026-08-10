import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

// Isolasi HOME/XDG dulu, SEBELUM modul apa pun diimpor — `prompt()` membangun
// system prompt lewat discoverSkills, yang membaca <home>/.claude langsung
// (bukan lewat variabel XDG). Lihat catatan yang sama di
// test/subagent-run.test.ts dan test/tool-task.test.ts.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-command-tim-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "command-tim.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession } = await import("../src/core/storage/session.ts")

// Dua proyek terpisah: satu punya sub-agent yang dispatchable, satu tidak
// punya sama sekali — /tim harus berjalan sangat berbeda di keduanya.
const withRoster = path.join(root, "dengan-roster")
const withoutRoster = path.join(root, "tanpa-roster")

before(() => {
  fs.mkdirSync(withRoster, { recursive: true })
  fs.writeFileSync(
    path.join(withRoster, "titah.json"),
    JSON.stringify({
      agent: {
        explore: {
          mode: "subagent",
          description: "Codebase explorer — read only",
          permission: { edit: "deny", write: "deny", bash: "deny" },
        },
      },
    }),
  )

  fs.mkdirSync(withoutRoster, { recursive: true })
  fs.writeFileSync(path.join(withoutRoster, "titah.json"), JSON.stringify({}))
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// Bentuk usage LanguageModelV4: inputTokens/outputTokens adalah OBJEK, bukan angka.
const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
}

function textChunks(...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

/**
 * Model yang tidak menjawab apa-apa yang menarik — satu-satunya tugasnya
 * melaporkan system prompt yang sungguh dikirim ke provider, lewat callback.
 *
 * `options.prompt` adalah array `LanguageModelV4Message`; pesan `system`
 * selalu yang PERTAMA kalau ada, dan itulah yang dirakit `streamText` dari
 * argumen `system` di `agent.ts` — bukan sesuatu yang bisa diintip lewat jalur
 * lain tanpa memalsukan model sungguhan.
 */
function captureSystem(onSystem: (system: string) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const systemMessage = options.prompt.find((message) => message.role === "system")
      onSystem(systemMessage && "content" in systemMessage ? systemMessage.content : "")
      return { stream: simulateReadableStream({ chunks: textChunks("ok") }) }
    },
  })
}

test("/tim adalah giliran biasa dengan roster di system prompt", async () => {
  // Kalau /tim butuh mesin orkestrasi tersendiri, itu tanda `task` dirancang salah.
  const session = createSession(withRoster)
  let systemSeen = ""
  const restore = setModelResolver(() => captureSystem((s) => (systemSeen = s)))
  try {
    await prompt({ sessionID: session.id, text: "/tim perbaiki bug auth" })
    assert.match(systemSeen, /explore/, "roster disebutkan")
    assert.match(systemSeen, /split the work/i)
  } finally {
    restore()
  }
})

test("/tim tanpa sub-agent apa pun menjelaskan cara mendaftarkannya", async () => {
  const session = createSession(withoutRoster)
  const message = await prompt({ sessionID: session.id, text: "/tim kerjakan sesuatu" })
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
  assert.match(text, /mode.*subagent/i)
})

test("/tim tanpa argumen ditolak dengan pesan usage, bukan diteruskan kosong", async () => {
  const session = createSession(withRoster)
  const message = await prompt({ sessionID: session.id, text: "/tim" })
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
  assert.match(text, /usage.*\/tim/i)
})
