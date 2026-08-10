import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import type { ToolContext } from "../src/core/tool/types.ts"

// Isolasi HOME/XDG SEBELUM modul apa pun diimpor — `taskTool` menjalankan
// giliran anak lewat `prompt()`, yang membaca skill dan config dari path yang
// sama dengan proses sungguhan (lihat catatan yang sama di
// test/subagent-run.test.ts). Tanpa ini, test diam-diam membaca ~/.claude atau
// ~/.config/opencode milik user yang menjalankannya.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-tool-task-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "tool-task.db")
process.env.HOME = path.join(root, "home")

// `agent.ts` diimpor SEBELUM `task.ts`. `task.ts` -> subagent.ts -> agent.ts ->
// tool/index.ts -> task.ts adalah siklus modul yang sama seperti yang
// disebutkan di task-6-brief.md; ESM mentolerirnya karena tak satu pun modul
// MEMBACA binding sirkulernya di level atas — kecuali baris ini sendiri
// menjadi entri PERTAMA ke siklus lewat task.ts. Masuk lewat agent.ts dulu
// membuat urutan evaluasinya sama dengan jalur produksi (cli.ts memuat
// agent.ts, bukan task.ts, sebagai titik masuk), sehingga `taskTool` sudah
// terisi penuh saat `tool/index.ts` membangun array TOOLS-nya.
const { buildToolNames, setModelResolver } = await import("../src/core/agent.ts")
const { taskTool } = await import("../src/core/tool/task.ts")
const { createSession } = await import("../src/core/storage/session.ts")
const { Config } = await import("../src/core/schema.ts")

const project = path.join(root, "proyek")

before(() => {
  fs.mkdirSync(project, { recursive: true })
  // Konfigurasi di disk HARUS sejalan dengan `configWithExplore()` di bawah:
  // `taskTool` memeriksa dispatch-nya sendiri lewat config yang DIKIRIM
  // (`ctx.config`), tapi giliran anaknya berjalan lewat `prompt()`, yang
  // memuat config-nya SENDIRI dari disk lewat `loadConfig(session.directory)`
  // — dua sumber, harus cocok.
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      agent: {
        explore: {
          mode: "subagent",
          permission: { edit: "deny", write: "deny", bash: "deny" },
        },
      },
    }),
  )
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

/** Model yang langsung menjawab satu teks — untuk giliran yang selesai normal. */
function stubModel(answer: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks(answer) }) }),
  })
}

/** Config in-memory untuk pengecekan dispatch — isinya harus sama dengan titah.json di atas. */
function configWithExplore() {
  return Config.parse({
    agent: {
      explore: {
        mode: "subagent",
        permission: { edit: "deny", write: "deny", bash: "deny" },
      },
    },
  })
}

/**
 * `ToolContext` minimal untuk memanggil `taskTool.execute` langsung, di luar
 * giliran sungguhan. Bentuknya sama dengan `ctx()` di test/tool.test.ts;
 * `cwd` dipatok ke direktori proyek test (bukan direktori repo ini) karena
 * `runSubagent` meneruskannya sebagai direktori sesi anak, dan `prompt()`
 * memuat config dari SANA — kalau `cwd` menunjuk ke tempat lain, config yang
 * dibaca ulang tidak akan mendefinisikan "explore" sama sekali.
 */
function ctx(sessionID: string, config: ReturnType<typeof Config.parse>): ToolContext {
  return {
    cwd: project,
    sessionID,
    callID: "c1",
    signal: new AbortController().signal,
    config,
  }
}

test("task menjalankan sub-agent dan mengembalikan jawabannya", async () => {
  const session = createSession(project)
  const restore = setModelResolver(() => stubModel("HASIL SUB-AGENT"))
  try {
    const result = await taskTool.execute(
      { agent: "explore", instruction: "telusuri" },
      ctx(session.id, configWithExplore()),
    )
    assert.match(result.output, /HASIL SUB-AGENT/)
  } finally {
    restore()
  }
})

test("nama agent tak dikenal menyebut yang tersedia", async () => {
  const session = createSession(project)
  const result = await taskTool.execute(
    { agent: "tidakada", instruction: "x" },
    ctx(session.id, configWithExplore()),
  )
  assert.match(result.output, /explore/)
})

test("SUB-AGENT TIDAK MENDAPAT TOOL task", () => {
  // Tanpa penjaga ini, satu sub-agent bisa memanggil sub-agent lagi, dan
  // seterusnya — pohon yang melebar tanpa batas, membakar token provider user
  // sampai habis tanpa satu pun tempat untuk menghentikannya.
  const parentTools = buildToolNames({ isChild: false })
  const childTools = buildToolNames({ isChild: true })

  assert.ok(parentTools.includes("task"))
  assert.ok(!childTools.includes("task"), "kedalaman tepat satu tingkat")
})
