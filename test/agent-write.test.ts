import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import type { Event } from "../src/core/event.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-aw-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "aw.db")
// prompt() memanggil buildSystemPrompt di setiap giliran, dan config di sini
// tidak mematikan skills.discover — jadi claudeSources akan membaca $HOME
// sungguhan kalau HOME tidak diisolasi juga. XDG_CONFIG_HOME tidak cukup:
// claudeSources baca <home>/.claude langsung, tidak lewat variabel XDG apa pun.
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")
const { bus } = await import("../src/core/event.ts")
const { respond, clearSession } = await import("../src/core/permission.ts")
const { undo } = await import("../src/core/undo.ts")
const { gitAvailable } = await import("../src/core/snapshot.ts")

const project = path.join(root, "proyek")
const skip = gitAvailable() ? false : "git tidak tersedia"
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "kode.ts"), "export const nilai = 1\n")
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

function text(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: body },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

function call(toolName: string, input: unknown, id = "call_1"): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]
}

function mock(steps: LanguageModelV4StreamPart[][]): void {
  let index = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(index, steps.length - 1)] as LanguageModelV4StreamPart[]
      index += 1
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore = setModelResolver(() => model)
}

/** Pelanggan bus tiruan — keberadaannya yang membuat izin ditanyakan, bukan ditolak. */
function attachClient(sessionID: string, answer: "once" | "always" | "reject" | null) {
  const controller = new AbortController()
  const events: Event[] = []
  const stream = bus.subscribe({ sessionID, signal: controller.signal })
  const pump = (async () => {
    for await (const event of stream) {
      events.push(event)
      if (event.type === "permission.request" && answer !== null) {
        respond(event.request.id, answer)
      }
      if (event.type === "session.idle") break
    }
  })()
  return { events, controller, done: pump }
}

const read = (rel: string) => fs.readFileSync(path.join(project, rel), "utf8")

test("tanpa klien terhubung, tool tulis ditolak dan file tidak berubah", async () => {
  mock([call("write", { path: "baru.txt", content: "seharusnya tidak ada\n" }), text("Ditolak.")])
  const session = createSession(project)

  const assistant = await prompt({ sessionID: session.id, text: "buat baru.txt" })

  const part = assistant.parts.find((p) => p.type === "tool")
  assert.ok(part?.type === "tool")
  assert.equal(part.state.status, "denied")
  if (part.state.status === "denied") assert.match(part.state.reason, /no client/i)

  assert.equal(fs.existsSync(path.join(project, "baru.txt")), false)
  clearSession(session.id)
})

test("izin yang ditolak user membuat tool tidak jalan, dan model diberi tahu", async () => {
  mock([call("write", { path: "baru.txt", content: "x\n" }), text("Baik, tidak jadi.")])
  const session = createSession(project)
  const client = attachClient(session.id, "reject")

  const assistant = await prompt({ sessionID: session.id, text: "buat baru.txt" })
  await client.done

  const part = assistant.parts.find((p) => p.type === "tool")
  assert.ok(part?.type === "tool" && part.state.status === "denied")
  assert.equal(fs.existsSync(path.join(project, "baru.txt")), false)

  // Giliran tetap selesai dengan jawaban, bukan mati.
  assert.equal(assistant.error, undefined)
  client.controller.abort()
  clearSession(session.id)
})

test("izin yang disetujui menjalankan tool dan benar-benar menulis file", async () => {
  mock([call("write", { path: "baru.txt", content: "isi baru\n" }), text("Sudah dibuat.")])
  const session = createSession(project)
  const client = attachClient(session.id, "once")

  const assistant = await prompt({ sessionID: session.id, text: "buat baru.txt" })
  await client.done

  const part = assistant.parts.find((p) => p.type === "tool")
  assert.ok(part?.type === "tool" && part.state.status === "completed")
  assert.equal(read("baru.txt"), "isi baru\n")

  const requests = client.events.filter((event) => event.type === "permission.request")
  assert.equal(requests.length, 1, "harus persis satu dialog izin")
  client.controller.abort()
  clearSession(session.id)
})

test("mode --auto melewati dialog izin sepenuhnya", async () => {
  mock([call("write", { path: "otomatis.txt", content: "auto\n" }), text("Selesai.")])
  const session = createSession(project)
  const client = attachClient(session.id, null)

  await prompt({ sessionID: session.id, text: "buat file", auto: true })
  await client.done

  assert.equal(read("otomatis.txt"), "auto\n")
  assert.equal(
    client.events.filter((event) => event.type === "permission.request").length,
    0,
    "--auto tidak boleh memunculkan dialog",
  )
  client.controller.abort()
  clearSession(session.id)
})

test("snapshot dicatat pada pesan, dan undo mengembalikan perubahan", { skip }, async () => {
  mock([
    call("edit", { path: "kode.ts", oldString: "nilai = 1", newString: "nilai = 999" }),
    text("Sudah diubah."),
  ])
  const session = createSession(project)
  const client = attachClient(session.id, "once")

  const assistant = await prompt({ sessionID: session.id, text: "ubah nilai jadi 999" })
  await client.done

  assert.match(read("kode.ts"), /nilai = 999/)
  assert.ok(assistant.snapshot, "pesan harus membawa commit snapshot")

  const result = await undo(session.id)
  assert.equal(read("kode.ts"), "export const nilai = 1\n", "undo harus mengembalikan persis")
  assert.deepEqual(result.files, ["kode.ts"])

  client.controller.abort()
  clearSession(session.id)
})

test("satu undo membatalkan SELURUH giliran, bukan satu tool", { skip }, async () => {
  mock([
    call("write", { path: "satu.txt", content: "a\n" }, "c1"),
    call("write", { path: "dua.txt", content: "b\n" }, "c2"),
    text("Dua file dibuat."),
  ])
  const session = createSession(project)
  const client = attachClient(session.id, "always")

  const assistant = await prompt({ sessionID: session.id, text: "buat dua file" })
  await client.done

  assert.equal(read("satu.txt"), "a\n")
  assert.equal(read("dua.txt"), "b\n")
  assert.equal(
    assistant.parts.filter((p) => p.type === "tool").length,
    2,
    "kedua tool harus jalan; jawaban 'always' mencegah dialog kedua",
  )

  await undo(session.id)
  assert.equal(fs.existsSync(path.join(project, "satu.txt")), false)
  assert.equal(fs.existsSync(path.join(project, "dua.txt")), false)

  client.controller.abort()
  clearSession(session.id)
})

test("tool baca tidak pernah meminta izin dan tidak mengambil snapshot", async () => {
  mock([call("read", { path: "kode.ts" }), text("Isinya satu baris.")])
  const session = createSession(project)
  const client = attachClient(session.id, "reject")

  const assistant = await prompt({ sessionID: session.id, text: "baca kode.ts" })
  await client.done

  const part = assistant.parts.find((p) => p.type === "tool")
  assert.ok(part?.type === "tool" && part.state.status === "completed")
  assert.equal(assistant.snapshot, undefined, "membaca tidak mengubah apa pun")
  assert.equal(client.events.filter((event) => event.type === "permission.request").length, 0)

  client.controller.abort()
  clearSession(session.id)
})

test("undo tanpa perubahan apa pun melapor jelas", async () => {
  const session = createSession(project)
  await assert.rejects(() => undo(session.id), /nothing to undo/)
  assert.equal(listMessages(session.id).length, 0)
})
