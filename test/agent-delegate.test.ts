import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-del-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "del.db")

const STUB = path.join(import.meta.dirname, "fixtures", "stub-agent.js")
const project = path.join(root, "proyek")

/**
 * loadConfig SELALU menyuntikkan agent default (claude, opencode), dan keduanya
 * benar-benar terpasang di mesin ini. Tanpa mematikannya secara eksplisit, test
 * seperti /consensus akan memanggil Claude Code sungguhan dan membakar uang.
 */
const DISABLED_DEFAULTS = {
  opencode: { command: "opencode", enabled: false },
}

function writeConfig(overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      externalAgent: {
        ...DISABLED_DEFAULTS,
        claude: {
          command: process.execPath,
          args: [STUB, "{prompt}", "--session-id", "{session}"],
          resumeArgs: [STUB, "{prompt}", "--resume", "{session}"],
          sessionMode: "generate",
          format: "stream-json",
          timeout: 10_000,
        },
        hantu: { command: "titah-agent-yang-tidak-ada" },
        ...overrides,
      },
    }),
  )
}

const { prompt } = await import("../src/core/agent.ts")
const { bus } = await import("../src/core/event.ts")
const { createSession, listMessages, listModelMessages } = await import(
  "../src/core/storage/session.ts"
)
const { externalSessionFor, listExternalSessions } = await import(
  "../src/core/storage/external.ts"
)

beforeEach(() => {
  process.env.TITAH_STUB_MODE = "claude"
  fs.rmSync(project, { recursive: true, force: true })
  writeConfig()
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test("@claude menjalankan agent eksternal dan jawabannya masuk konteks", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@claude jelaskan modul X" })

  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart?.type === "tool")
  assert.equal(toolPart.tool, "@claude")
  assert.equal(toolPart.state.status, "completed")

  // Jawaban final muncul sebagai teks, bukan hanya di dalam blok tool.
  const text = assistant.parts.find((part) => part.type === "text")
  assert.ok(text?.type === "text" && text.text.includes("jelaskan modul X"))

  // Dan ia masuk riwayat model, supaya giliran Titah berikutnya tahu isinya.
  const history = listModelMessages(session.id)
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"])
  assert.match(String(history[1]?.content), /\[answer from @claude\]/)
})

test("@claude kedua melanjutkan sesi eksternal yang sama", async () => {
  const session = createSession(project)

  const pertama = await prompt({ sessionID: session.id, text: "@claude satu" })
  const external = externalSessionFor(session.id, "claude")
  assert.ok(external, "id sesi eksternal harus tersimpan setelah panggilan pertama")

  const kedua = await prompt({ sessionID: session.id, text: "@claude dua" })

  // Stub menandai panggilan resume dengan awalan "lanjutan:".
  const teksPertama = pertama.parts.find((part) => part.type === "text")
  const teksKedua = kedua.parts.find((part) => part.type === "text")
  assert.match(teksPertama?.type === "text" ? teksPertama.text : "", /^awal:/)
  assert.match(teksKedua?.type === "text" ? teksKedua.text : "", /^lanjutan:/)

  assert.equal(
    externalSessionFor(session.id, "claude"),
    external,
    "id sesi eksternal tidak boleh berubah di panggilan kedua",
  )
})

test("sesi eksternal dipisah per agent dan per sesi Titah", async () => {
  const satu = createSession(project)
  const dua = createSession(project)

  await prompt({ sessionID: satu.id, text: "@claude halo" })
  await prompt({ sessionID: dua.id, text: "@claude halo" })

  const a = externalSessionFor(satu.id, "claude")
  const b = externalSessionFor(dua.id, "claude")
  assert.ok(a && b)
  assert.notEqual(a, b, "sesi Titah berbeda tidak boleh berbagi sesi Claude")
  assert.deepEqual(listExternalSessions(satu.id).map((entry) => entry.agentID), ["claude"])
})

test("transkrip penuh disimpan ke file, bukan disuntikkan ke konteks", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@claude halo" })

  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart?.type === "tool" && toolPart.state.status === "completed")
  if (toolPart.state.status !== "completed") return

  // Yang masuk konteks hanyalah jawaban final — bukan event system/init dsb.
  assert.doesNotMatch(toolPart.state.output, /"type":"system"/)
  assert.match(toolPart.state.output, /^awal: halo$/)
})

test("token dan biaya eksternal dicatat terpisah dari usage Titah", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@claude halo" })

  assert.deepEqual(assistant.externalUsage, { input: 200, output: 11, cost: 0.0345 })
  assert.equal(assistant.usage, undefined, "usage Titah harus tetap kosong — tak ada token Titah")
})

test("agent yang tidak dikenal ditolak dan menyebut yang terdaftar", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@entah halo" })

  assert.match(assistant.error ?? "", /[Uu]nknown/)
  assert.match(assistant.error ?? "", /claude/)
  assert.equal(listModelMessages(session.id).length, 0, "delegasi gagal tidak menodai riwayat")
})

test("agent yang CLI-nya tidak terpasang memberi instruksi, bukan crash", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@hantu halo" })

  assert.match(assistant.error ?? "", /unavailable/)
  assert.match(assistant.error ?? "", /titah-agent-yang-tidak-ada/)
})

test("CLI yang gagal dilaporkan beserta path transkrip mentahnya", async () => {
  process.env.TITAH_STUB_MODE = "crash"
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@claude halo" })

  assert.match(assistant.error ?? "", /exited with code 1/)
  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart?.type === "tool" && toolPart.state.status === "error")
})

test("delegasi tidak menyentuh model Titah sama sekali", async () => {
  // Tidak ada `model` di config dan tidak ada provider — kalau jalur delegasi
  // menyentuh resolveModel, giliran ini akan gagal.
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "@claude halo" })

  assert.equal(assistant.error, undefined)
  assert.equal(assistant.model, "@claude")
})

test("pesan biasa tidak ikut terdelegasi", async () => {
  const session = createSession(project)
  // Tanpa model terkonfigurasi, prompt biasa harus gagal di resolveModel —
  // bukti bahwa ia menempuh jalur LLM, bukan jalur delegasi.
  await assert.rejects(
    () => prompt({ sessionID: session.id, text: "email saya akil@gmail.com" }),
    /model/i,
  )
  assert.equal(listMessages(session.id).length, 0)
})

test("jawaban delegasi juga dikirim sebagai text.delta, bukan hanya snapshot", async () => {
  // Klien yang hanya mendengarkan text.delta (mis. `titah run`) akan
  // menampilkan metrik delegasi tapi tidak pernah menampilkan jawabannya.
  const session = createSession(project)
  const controller = new AbortController()
  const deltas: string[] = []

  const pump = (async () => {
    for await (const event of bus.subscribe({ sessionID: session.id, signal: controller.signal })) {
      if (event.type === "text.delta") deltas.push(event.text)
      if (event.type === "session.idle") break
    }
  })()

  await prompt({ sessionID: session.id, text: "@claude halo" })
  await pump
  controller.abort()

  assert.equal(deltas.length, 1)
  assert.match(deltas[0] ?? "", /^awal: halo$/)
})

test("/agents mendaftar agent internal dan eksternal tanpa memanggil model", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "/agents" })

  const text = assistant.parts.find((part) => part.type === "text")
  assert.ok(text?.type === "text")
  assert.match(text.text, /External agents/)
  assert.match(text.text, /claude/)
  assert.match(text.text, /hantu\s+unavailable/)
  assert.equal(assistant.error, undefined)
})

test("/commands mendaftar bawaan dan custom", async () => {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      externalAgent: {
        ...DISABLED_DEFAULTS,
        claude: { command: process.execPath, args: [STUB, "{prompt}"] },
      },
      command: { review: { template: "Review {{.Input}}", description: "Review cepat" } },
    }),
  )
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "/commands" })

  const text = assistant.parts.find((part) => part.type === "text")
  assert.match(text?.type === "text" ? text.text : "", /\/consensus/)
  assert.match(text?.type === "text" ? text.text : "", /Review cepat/)
})

test("command yang tidak dikenal menampilkan daftar, bukan error mentah", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "/entahlah halo" })

  assert.match(assistant.error ?? "", /[Uu]nknown/)
  const text = assistant.parts.find((part) => part.type === "text")
  assert.match(text?.type === "text" ? text.text : "", /Available commands/)
})

test("/consensus tanpa pertanyaan memberi petunjuk penggunaan", async () => {
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "/consensus" })
  assert.match(assistant.error ?? "", /Usage/)
})

test("/consensus menyebar ke agent eksternal dan menyimpan hasilnya", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      externalAgent: {
        ...DISABLED_DEFAULTS,
        claude: { command: "claude", enabled: false },
        satu: { command: process.execPath, args: [STUB, "{prompt}"], format: "stream-json" },
        dua: { command: process.execPath, args: [STUB, "{prompt}"], format: "stream-json" },
      },
    }),
  )
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "/consensus apa ibu kotanya?" })

  const tools = assistant.parts.filter((part) => part.type === "tool")
  assert.equal(tools.length, 2, "kedua agent harus muncul sebagai blok terpisah")
  assert.ok(tools.every((part) => part.type === "tool" && part.state.status === "completed"))

  // Tanpa model Titah, sintesis dilewati tapi jawaban mentah tetap tersimpan.
  const text = assistant.parts.find((part) => part.type === "text")
  assert.ok(text?.type === "text" && text.text.length > 0)
  assert.equal(assistant.model, "consensus")
  assert.ok((assistant.externalUsage?.input ?? 0) > 0, "token eksternal terkumpul")
})

test("konsensus menampilkan waktu berjalan tiap agent, bukan status yang membeku", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      externalAgent: {
        ...DISABLED_DEFAULTS,
        claude: { command: "claude", enabled: false },
        satu: { command: process.execPath, args: [STUB, "{prompt}"], format: "stream-json" },
        dua: { command: process.execPath, args: [STUB, "{prompt}"], format: "stream-json" },
      },
    }),
  )

  const session = createSession(project)
  const controller = new AbortController()
  const titles: string[] = []
  const pump = (async () => {
    for await (const event of bus.subscribe({ sessionID: session.id, signal: controller.signal })) {
      if (event.type === "message.updated") {
        for (const part of event.message.parts) {
          if (part.type === "tool" && part.state.status === "running" && part.state.title) {
            titles.push(part.state.title)
          }
        }
      }
      if (event.type === "session.idle") break
    }
  })()

  await prompt({ sessionID: session.id, text: "/consensus halo" })
  await pump
  controller.abort()

  // Judul harus memuat detik berjalan, bukan sekadar "mulai".
  assert.ok(
    titles.some((title) => /@\w+ · \d+s · /.test(title)),
    `judul harus menyertakan waktu berjalan, dapat: ${titles.slice(0, 3).join(" | ")}`,
  )
})
