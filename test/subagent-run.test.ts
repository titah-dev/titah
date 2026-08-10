import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

// Isolasi HOME/XDG dulu, SEBELUM modul apa pun diimpor — beberapa modul
// membaca path-nya sendiri saat modul dievaluasi, jadi mengisolasi setelah
// impor sudah terlambat (lihat catatan yang sama di test/agent.test.ts).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-subagent-run-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "subagent-run.db")
// `prompt()` membangun system prompt lewat discoverSkills, yang membaca
// <home>/.claude langsung (bukan lewat variabel XDG). Tanpa mengisolasi HOME
// juga, test ini membaca skill sungguhan milik user yang menjalankannya.
process.env.HOME = path.join(root, "home")

const { runSubagent } = await import("../src/core/subagent.ts")
const { setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listChildSessions, listMessages } = await import(
  "../src/core/storage/session.ts"
)
const { Config } = await import("../src/core/schema.ts")

const project = path.join(root, "proyek")

before(() => {
  fs.mkdirSync(project, { recursive: true })
  // Konfigurasi di disk HARUS sejalan dengan `configWithExplore()` di bawah:
  // `runSubagent` memeriksa dispatch-nya sendiri lewat `options.config`, tapi
  // giliran anak berjalan lewat `prompt()`, yang memuat config-nya SENDIRI
  // dari disk lewat `loadConfig(session.directory)` — dua sumber, harus cocok.
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

/**
 * Model yang lambat — memberi jendela nyata untuk pembatalan mid-flight.
 *
 * Provider mock tidak menghormati abortSignal-nya (catatan yang sama berlaku
 * di test/agent.test.ts): `doStream` tetap menunggu penuh sampai timeout-nya
 * sendiri, lalu barulah `prompt()` melihat sinyalnya sudah aborted dan
 * melaporkan "Cancelled". Delay-nya sengaja pendek — cukup satu giliran
 * event-loop, bukan meniru latensi provider sungguhan — supaya suite tidak
 * ikut menunggu.
 */
function slowStubModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ stream: simulateReadableStream({ chunks: textChunks("terlalu lambat") }) }),
          20,
        ),
      ),
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

test("sub-agent menjalankan giliran di sesi anaknya sendiri", async () => {
  const parent = createSession(project, "induk")
  const restore = setModelResolver(() => stubModel("SUDAH DIPETAKAN"))
  try {
    const result = await runSubagent({
      parentSessionID: parent.id,
      agentID: "explore",
      instruction: "petakan auth",
      cwd: project,
      config: configWithExplore(),
      signal: new AbortController().signal,
    })

    assert.equal(result.status, "done")
    assert.match(result.answer, /SUDAH DIPETAKAN/)
    assert.deepEqual(
      listChildSessions(parent.id).map((s) => s.id),
      [result.childSessionID],
    )
  } finally {
    restore()
  }
})

test("agent ber-mode primary DITOLAK sebagai bawahan", async () => {
  // `build-auto` punya izin serba-boleh. Kalau mode tidak ditegakkan di sini,
  // deklarasi di config jadi hiasan.
  const parent = createSession(project)
  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "build",
    instruction: "apa saja",
    cwd: project,
    config: Config.parse({ agent: { build: { mode: "primary" } } }),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "failed")
  assert.match(result.answer, /not dispatchable|primary/i)
})

test("dibatalkan mengembalikan status stopped, BUKAN melempar", async () => {
  // Pembatalan adalah informasi untuk koordinator, bukan kegagalan giliran.
  // Melempar di sini akan menggugurkan giliran induk — persis yang dihindari.
  const parent = createSession(project)
  const controller = new AbortController()
  const restore = setModelResolver(() => slowStubModel())
  try {
    const running = runSubagent({
      parentSessionID: parent.id,
      agentID: "explore",
      instruction: "kerja lama",
      cwd: project,
      config: configWithExplore(),
      signal: controller.signal,
    })
    controller.abort()
    const result = await running

    assert.equal(result.status, "stopped")
    assert.match(result.answer, /STOPPED BY USER/)
  } finally {
    restore()
  }
})

test("penulis yang dibatalkan sebelum antrean-nya sempat mulai tidak pernah memanggil prompt()", async () => {
  // `withWriteLock` menunda `run`-nya lewat `.then()` bahkan saat antrean
  // kosong — itu SATU microtask, bukan nol. Test ini membuktikan pengecekan
  // `aborted` di awal `work` benar-benar menutup jendela itu: kalau tidak,
  // `prompt()` tetap terpanggil dan setidaknya menyimpan satu pesan di sesi
  // anak sebelum status "stopped" sempat dilaporkan.
  const parent = createSession(project)
  const controller = new AbortController()
  const config = Config.parse({ agent: { scribe: { mode: "subagent" } } })

  const running = runSubagent({
    parentSessionID: parent.id,
    agentID: "scribe",
    instruction: "tulis sesuatu",
    cwd: project,
    config,
    signal: controller.signal,
  })
  controller.abort()
  const result = await running

  assert.equal(result.status, "stopped")
  const children = listChildSessions(parent.id)
  assert.equal(children.length, 1)
  assert.equal(
    listMessages(children[0]!.id).length,
    0,
    "prompt() tidak boleh pernah dipanggil — kalau dipanggil, setidaknya satu pesan tersimpan",
  )
})
