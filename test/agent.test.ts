import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, before, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import type { Event } from "../src/core/event.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-agent-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "agent.db")
// prompt() memanggil buildSystemPrompt di setiap giliran, dan config di sini
// tidak mematikan skills.discover — jadi claudeSources akan membaca $HOME
// sungguhan kalau HOME tidak diisolasi juga. XDG_CONFIG_HOME tidak cukup:
// claudeSources baca <home>/.claude langsung, tidak lewat variabel XDG apa pun.
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver, abort } = await import("../src/core/agent.ts")
const { createSession, listMessages, listModelMessages } = await import(
  "../src/core/storage/session.ts"
)
const { bus } = await import("../src/core/event.ts")
const { loadedSkillIds } = await import("../src/core/tool/skill.ts")

const project = path.join(root, "proyek")
// Proyek terpisah supaya titah.json di sini tidak memengaruhi test lain yang
// tidak peduli skill sama sekali.
const skillProject = path.join(root, "proyek-skill")
let restore: (() => void) | undefined

before(() => {
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "halo.txt"), "baris satu\nbaris dua\n")

  fs.mkdirSync(path.join(skillProject, "skills", "hello"), { recursive: true })
  fs.writeFileSync(
    path.join(skillProject, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Skill demo\n---\n\nISI SKILL DEMO.\n",
  )
  fs.writeFileSync(
    path.join(skillProject, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [{ path: "skills", as: "demo" }] },
    }),
  )
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// Bentuk usage LanguageModelV4: inputTokens/outputTokens adalah OBJEK, bukan angka.
const USAGE = {
  inputTokens: { total: 11, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: undefined, reasoning: undefined },
}

/** Bentuk usage LanguageModelV4 dengan input token tertentu. */
function usageWith(inputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: undefined, reasoning: undefined },
  }
}

/**
 * Seperti `mockStreaming`, tapi MENGEMBALIKAN model-nya sehingga
 * `doStreamCalls` bisa diperiksa.
 *
 * Yang diperiksa lewat `doStreamCalls[n].prompt` adalah apa yang BENAR-BENAR
 * diterima provider. Test yang cuma membuktikan sebuah fungsi terpanggil tidak
 * membuktikan apa pun tentang isi permintaannya.
 */
function recordingModel(chunks: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = chunks[Math.min(call, chunks.length - 1)] as LanguageModelV4StreamPart[]
      call += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  restore = setModelResolver(() => model)
  return model
}

/** Proyek sementara dengan titah.json sendiri — `prompt()` memuat config dari direktori sesi. */
function projectWith(titahJson: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(root, "proyek-"))
  fs.writeFileSync(path.join(dir, "halo.txt"), "baris satu\nbaris dua\n")
  fs.writeFileSync(
    path.join(dir, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] }, ...titahJson }),
  )
  return dir
}

/** Config yang menyatakan jendela konteks untuk model yang dipakai test. */
function windowConfig(contextWindow: number, extra: Record<string, unknown> = {}) {
  return {
    model: "mock/m",
    provider: { mock: { models: { m: { contextWindow } } } },
    ...extra,
  }
}

function mockStreaming(chunks: LanguageModelV4StreamPart[][]): void {
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = chunks[Math.min(call, chunks.length - 1)] as LanguageModelV4StreamPart[]
      call += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  restore = setModelResolver(() => model)
}

function text(...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

/** Mengumpulkan event sesi sampai session.idle. */
function collect(sessionID: string): { events: Event[]; done: Promise<void> } {
  const events: Event[] = []
  const controller = new AbortController()
  const stream = bus.subscribe({ sessionID, signal: controller.signal })
  const done = (async () => {
    for await (const event of stream) {
      events.push(event)
      if (event.type === "session.idle") break
    }
    controller.abort()
  })()
  return { events, done }
}

test("teks dikirim sebagai delta, dan pesan akhir tersimpan utuh", async () => {
  mockStreaming([text("Halo", " dunia", "!")])
  const session = createSession(project)
  const sink = collect(session.id)

  const assistant = await prompt({ sessionID: session.id, text: "sapa aku" })
  await sink.done

  const deltas = sink.events.filter((event) => event.type === "text.delta")
  assert.deepEqual(
    deltas.map((event) => (event.type === "text.delta" ? event.text : "")),
    ["Halo", " dunia", "!"],
    "urutan delta harus persis seperti yang dikirim model",
  )

  assert.equal(assistant.parts.length, 1)
  assert.equal(assistant.parts[0]?.type === "text" && assistant.parts[0].text, "Halo dunia!")
  // Giliran satu langkah: context (input langkah terakhir) sama dengan input
  // (total penagihan), sengaja dipatok terpisah supaya perbedaannya kelak
  // kentara kalau salah satunya tidak terisi.
  assert.deepEqual(assistant.usage, { input: 11, output: 7, context: 11 })

  const stored = listMessages(session.id)
  assert.deepEqual(stored.map((message) => message.role), ["user", "assistant"])
})

test("session.idle selalu dikirim sebagai event terakhir", async () => {
  mockStreaming([text("selesai")])
  const session = createSession(project)
  const sink = collect(session.id)

  await prompt({ sessionID: session.id, text: "halo" })
  await sink.done

  assert.equal(sink.events.at(-1)?.type, "session.idle")
})

test("tool dijalankan sungguhan, dan statusnya dipublikasikan sebagai snapshot", async () => {
  mockStreaming([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read",
        input: JSON.stringify({ path: "halo.txt" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ],
    text("File itu berisi dua baris."),
  ])

  const session = createSession(project)
  const sink = collect(session.id)
  const assistant = await prompt({ sessionID: session.id, text: "baca halo.txt" })
  await sink.done

  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart && toolPart.type === "tool")
  assert.equal(toolPart.tool, "read")
  assert.equal(toolPart.state.status, "completed")
  if (toolPart.state.status === "completed") {
    assert.match(toolPart.state.output, /baris satu/, "isi file sungguhan harus masuk output")
    assert.match(toolPart.state.title, /^read halo\.txt/)
    assert.equal(toolPart.state.truncated, false)
  }

  // Snapshot, bukan delta: setiap message.updated memuat seluruh part.
  const snapshots = sink.events.filter((event) => event.type === "message.updated")
  const statuses = snapshots
    .flatMap((event) => (event.type === "message.updated" ? event.message.parts : []))
    .filter((part) => part.type === "tool")
    .map((part) => (part.type === "tool" ? part.state.status : ""))
  assert.ok(statuses.includes("running"), "harus ada snapshot saat tool berjalan")
  assert.ok(statuses.includes("completed"), "harus ada snapshot saat tool selesai")
})

test("tool yang gagal mengembalikan pesan error ke model, bukan menghentikan giliran", async () => {
  mockStreaming([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_gagal",
        toolName: "read",
        input: JSON.stringify({ path: "tidak-ada.txt" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ],
    text("File itu tidak ada."),
  ])

  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "baca file hantu" })

  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart && toolPart.type === "tool")
  assert.equal(toolPart.state.status, "error")

  // Giliran tetap selesai dengan jawaban, bukan mati di tengah.
  assert.equal(assistant.error, undefined)
  assert.ok(assistant.parts.some((part) => part.type === "text"))
})

test("path di luar direktori sesi ditolak lewat jalur agent, bukan hanya di unit tool", async () => {
  mockStreaming([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_keluar",
        toolName: "read",
        input: JSON.stringify({ path: "../../../etc/passwd" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ],
    text("Ditolak."),
  ])

  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "baca /etc/passwd" })

  const toolPart = assistant.parts.find((part) => part.type === "tool")
  assert.ok(toolPart?.type === "tool" && toolPart.state.status === "error")
  if (toolPart.state.status === "error") {
    assert.match(toolPart.state.error, /outside the session working directory/)
  }
})

test("riwayat format AI SDK bertambah tiap giliran sehingga percakapan berlanjut", async () => {
  mockStreaming([text("jawaban pertama"), text("jawaban kedua")])
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "giliran satu" })
  const afterFirst = listModelMessages(session.id)
  assert.deepEqual(afterFirst.map((message) => message.role), ["user", "assistant"])

  await prompt({ sessionID: session.id, text: "giliran dua" })
  assert.deepEqual(
    listModelMessages(session.id).map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
    "giliran kedua harus menambah riwayat, bukan menimpanya",
  )
  assert.equal(listMessages(session.id).length, 4, "2 user + 2 assistant")
})

test("riwayat menyimpan SEMUA step, termasuk tool-call dan tool-result", async () => {
  // Regresi: `result.response.messages` hanya memuat step TERAKHIR, sehingga
  // riwayat kehilangan pasangan tool-call/tool-result dan giliran berikutnya
  // mengulang pekerjaan yang sudah selesai.
  mockStreaming([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_riwayat",
        toolName: "read",
        input: JSON.stringify({ path: "halo.txt" }),
      },
      { type: "finish", finishReason: "tool-calls", usage: USAGE },
    ],
    text("Isinya dua baris."),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca halo.txt" })

  const history = listModelMessages(session.id)
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
    "user → assistant(tool-call) → tool(result) → assistant(teks)",
  )

  const serialized = JSON.stringify(history)
  assert.match(serialized, /call_riwayat/, "id tool call harus terbawa ke riwayat")
  assert.match(serialized, /baris satu/, "hasil tool harus terbawa ke riwayat")
})

test("judul sesi diisi dari prompt pertama saja", async () => {
  mockStreaming([text("ok")])
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "prompt pertama yang jadi judul" })
  const updated = (await import("../src/core/storage/session.ts")).getSession(session.id)
  assert.equal(updated?.title, "prompt pertama yang jadi judul")

  await prompt({ sessionID: session.id, text: "prompt kedua" })
  const lagi = (await import("../src/core/storage/session.ts")).getSession(session.id)
  assert.equal(lagi?.title, "prompt pertama yang jadi judul", "judul tidak boleh ditimpa")
})

test("sesi yang tidak ada ditolak dengan AgentError", async () => {
  mockStreaming([text("ok")])
  await assert.rejects(
    () => prompt({ sessionID: "ses_hantu", text: "halo" }),
    /Session not found/,
  )
})

test("dua giliran serentak pada satu sesi ditolak, bukan saling menimpa", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ stream: simulateReadableStream({ chunks: text("lambat") }) }), 60),
      ),
  })
  restore = setModelResolver(() => model)

  const session = createSession(project)
  const pertama = prompt({ sessionID: session.id, text: "satu" })
  await assert.rejects(
    () => prompt({ sessionID: session.id, text: "dua" }),
    /already processing another turn/,
  )
  await pertama
})

test("abort membatalkan giliran dan mencatatnya sebagai dibatalkan user", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ stream: simulateReadableStream({ chunks: text("terlalu lambat") }) }),
          2000,
        ),
      ),
  })
  restore = setModelResolver(() => model)

  const session = createSession(project)
  const turn = prompt({ sessionID: session.id, text: "batalkan aku" })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(abort(session.id), true)
  const assistant = await turn
  assert.match(assistant.error ?? "", /Cancelled/)

  assert.equal(abort(session.id), false, "abort setelah selesai harus mengembalikan false")
})

// Catatan: jalur "provider menutup stream dengan part 'abort'" TIDAK diuji di
// sini. Mock provider tidak menghormati abortSignal seperti koneksi HTTP nyata,
// sehingga stream-nya menggantung selamanya alih-alih menghasilkan part 'abort'.
// Penanganannya di agent.ts diverifikasi langsung terhadap 9router lewat TUI.

test("giliran yang berakhir tanpa teks tetap memberi penjelasan, bukan kosong", async () => {
  mockStreaming([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call_diam",
        toolName: "read",
        input: JSON.stringify({ path: "halo.txt" }),
      },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ],
  ])

  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "baca" })

  const text = assistant.parts.find((part) => part.type === "text")
  assert.ok(text?.type === "text")
  assert.match(text.text, /stopped without giving a text answer/)
})

test("/namespace:skill memuat isi skill ke model, transkrip tetap tampilkan yang diketik", async () => {
  mockStreaming([text("sudah dikerjakan")])
  const session = createSession(skillProject)

  const assistant = await prompt({
    sessionID: session.id,
    text: "/demo:hello lakukan sesuatu",
  })
  assert.equal(assistant.parts[0]?.type === "text" && assistant.parts[0].text, "sudah dikerjakan")

  // Isi skill sampai ke model...
  const sentToModel = JSON.stringify(listModelMessages(session.id))
  assert.match(sentToModel, /ISI SKILL DEMO/)
  assert.match(sentToModel, /lakukan sesuatu/)

  // ...tapi transkrip yang terlihat user tetap menampilkan command apa adanya,
  // bukan 9 KB isi skill.
  const stored = listMessages(session.id)
  const userText = stored[0]?.parts.find((part) => part.type === "text")
  assert.ok(userText?.type === "text")
  assert.equal(userText.text, "/demo:hello lakukan sesuatu")
  assert.doesNotMatch(userText.text, /ISI SKILL DEMO/)

  // Pemuatan lewat command harus terbaca oleh pagar tool — dan terbaca dari
  // PENANDA pesannya, bukan dari tulisan di dalamnya. Tanpa penanda yang ikut
  // tersimpan, model bisa memuat ulang skill yang barusan diberikan user.
  assert.ok(loadedSkillIds(session.id).has("demo:hello"))
})

test("skill yang tidak dikenal menyarankan skill lain di namespace yang sama", async () => {
  const session = createSession(skillProject)
  const assistant = await prompt({ sessionID: session.id, text: "/demo:tidak-ada" })

  assert.match(assistant.error ?? "", /Unknown skill "demo:tidak-ada"/)
  const body = assistant.parts.find((part) => part.type === "text")
  assert.ok(body?.type === "text")
  assert.match(body.text, /Available in that namespace/)
  assert.match(body.text, /\/demo:hello/)
})

test("/skills menampilkan ringkasan skill DI ATAS daftar, bukan di bawahnya", async () => {
  // renderSkills merangkai [report, "", daftar]; test ini memaku URUTAN itu,
  // bukan cuma keberadaan kedua bagiannya — reorder atau hapus salah satu
  // panggilan renderSkillReport di sana harus membuat test ini gagal, karena
  // tanpa test ini keduanya lolos hijau begitu saja.
  const session = createSession(skillProject)
  const assistant = await prompt({ sessionID: session.id, text: "/skills" })

  const body = assistant.parts.find((part) => part.type === "text")
  assert.ok(body?.type === "text")
  const reportAt = body.text.indexOf("Skills:")
  const listAt = body.text.indexOf("skills found:")
  assert.ok(reportAt >= 0, "ringkasan report harus muncul")
  assert.ok(listAt > reportAt, "daftar skill harus di BAWAH report")
  assert.match(body.text, /demo\s+1 skill/)

  // Id lengkap, bukan nama telanjang: `/skills` adalah satu-satunya tempat user
  // membaca apa yang bisa diketik, dan `hello` saja dijawab "Unknown command".
  assert.match(body.text, /\/demo:hello/)
})

test("skill dengan namespace yang tidak dikenal sama sekali diarahkan ke /skills", async () => {
  const session = createSession(skillProject)
  const assistant = await prompt({ sessionID: session.id, text: "/lain:apa-saja" })

  assert.match(assistant.error ?? "", /Unknown skill "lain:apa-saja"/)
  const body = assistant.parts.find((part) => part.type === "text")
  assert.ok(body?.type === "text")
  assert.match(body.text, /Run \/skills to see what is available/)
})

test("usage.context adalah input langkah TERAKHIR, bukan jumlah seluruh langkah", async () => {
  // totalUsage MENJUMLAHKAN tiap langkah. Giliran 20 langkah dengan konteks
  // tetap 15k melaporkan input ~300k — memakainya sebagai ambang berarti
  // memadatkan terus-menerus sambil terlihat seperti fitur yang bekerja.
  mockStreaming([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(100) },
    ],
    [
      { type: "text-delta", id: "t", delta: "selesai" },
      { type: "finish", finishReason: "stop", usage: usageWith(180) },
    ],
  ])

  const session = createSession(project)
  const message = await prompt({ sessionID: session.id, text: "baca halo.txt" })

  assert.equal(message.usage?.context, 180)
  assert.equal(message.usage?.input, 280)
  assert.notEqual(message.usage?.context, message.usage?.input)
})
