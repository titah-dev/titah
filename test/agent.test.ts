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
const {
  createSession,
  latestCompaction,
  listChildSessions,
  listMessages,
  listModelMessages,
  listModelRows,
} = await import("../src/core/storage/session.ts")
const { runSubagent } = await import("../src/core/subagent.ts")
const { Config } = await import("../src/core/schema.ts")
const { bus } = await import("../src/core/event.ts")
const { loadedSkillIds } = await import("../src/core/tool/skill.ts")
const { overBudget } = await import("../src/core/compact.ts")

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
 * MENGEMBALIKAN model-nya sehingga `doStreamCalls` bisa diperiksa.
 *
 * Yang diperiksa lewat `doStreamCalls[n].prompt` adalah apa yang BENAR-BENAR
 * diterima provider. Test yang cuma membuktikan sebuah fungsi terpanggil tidak
 * membuktikan apa pun tentang isi permintaannya.
 *
 * `restore?.()` dipanggil DULU, sebelum menimpa `restore` dengan resolver yang
 * baru. Tanpa ini, mock kedua dalam satu test menimpa variabel `restore` milik
 * mock pertama begitu saja — `setModelResolver` hanya tahu cara balik ke
 * resolver yang aktif tepat sebelum panggilannya sendiri, jadi mock pertama
 * hilang dari rantai restore dan tetap terpasang untuk test-test berikutnya
 * di file ini, yang lalu lolos hijau karena dilayani mock yang salah.
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
  restore?.()
  restore = setModelResolver(() => model)
  return model
}

/** Alias tanpa nilai balik, untuk test yang tidak perlu memeriksa doStreamCalls. */
function mockStreaming(chunks: LanguageModelV4StreamPart[][]): void {
  recordingModel(chunks)
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

/** Isi teks giliran, untuk test yang cuma peduli kata dalam jawabannya. */
function bodyOf(message: { parts: { type: string; text?: string }[] }): string {
  return message.parts.find((part): part is { type: "text"; text: string } => part.type === "text")
    ?.text ?? ""
}

// ---------- harness: rantai restore mock ----------

test("mock kedua dalam satu test tidak membuat mock pertama bocor ke test lain", async () => {
  // Pola turn → compaction → turn (dipakai Task 5-8) memasang mock lebih dari
  // sekali dalam satu test. Tanpa `restore?.()` SEBELUM menimpa `restore` di
  // `recordingModel`, panggilan kedua kehilangan jejak ke resolver yang aktif
  // SEBELUM mock pertama terpasang — jadi begitu test ini "beres" (restore
  // disimulasikan di bawah), resolver yang tersisa adalah mock PERTAMA, bukan
  // resolver asal. Test lain yang sama sekali tidak memasang mock lalu diam-
  // diam dilayani mock pertama itu, dan lolos hijau karena alasan yang salah.
  //
  // canary berdiri untuk "resolver yang aktif sebelum test ini dimulai" —
  // dipasang langsung lewat setModelResolver (bukan lewat recordingModel),
  // supaya test ini tidak menyentuh resolver default sungguhan (yang akan
  // mencoba provider nyata).
  const canary = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: text("respons-canary") }) }),
  })
  const restoreCanary = setModelResolver(() => canary)
  restore = undefined

  const session = createSession(project)

  recordingModel([text("respons-satu")])
  const satu = await prompt({ sessionID: session.id, text: "a" })
  // Positif dulu: mock pertama sungguh melayani, sebelum mock kedua dipasang.
  assert.match(bodyOf(satu), /respons-satu/)

  recordingModel([text("respons-dua")])
  const dua = await prompt({ sessionID: session.id, text: "b" })
  // Positif: mock kedua sungguh melayani setelah dipasang di atas mock pertama.
  assert.match(bodyOf(dua), /respons-dua/)

  // Simulasikan afterEach test INI (lihat definisi afterEach di bawah).
  restore?.()
  restore = undefined

  // Probe test LAIN yang tidak memasang mock sama sekali. Kalau rantai restore
  // di atas bocor, resolver yang tersisa adalah mock pertama ("respons-satu"),
  // bukan canary — itulah kegagalan yang mutasi di bawah harus menunjukkan.
  const probe = await prompt({ sessionID: session.id, text: "c" })
  assert.match(bodyOf(probe), /respons-canary/)

  restoreCanary()
})

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

// `tailTurns: 0` DISENGAJA di kedua test di bawah, bukan default (2). Dengan
// default, `tailStart` menolak memotong apa pun selama giliran yang tersimpan
// lebih sedikit dari `tailTurns` — dan kedua test ini cuma menumpuk SATU
// giliran sebelum giliran yang diharapkan memadatkan. `reserved` juga
// diturunkan dari default (8192): dulu, sebelum lantai `effectiveReserved`
// (Task 10) ada, default itu PERSIS sama dengan contextWindow di sini,
// ambangnya nol, dan overBudget SELALU true untuk usage berapa pun — termasuk
// usage kecil giliran susulan yang justru harus lolos di bawah ambang. Lantai
// itu sudah menutup celah nol itu (ambang default sekarang 6144, bukan nol),
// tapi 1000 dipertahankan tetap: alasannya kini sekadar jarak yang lega antara
// usage besar (7800, harus memicu) dan usage kecil pasca-ringkas (50, tidak
// boleh), sengaja dipisah jauh supaya kedua test tetap benar walau angkanya
// sedikit bergeser.
const COMPACTING_CONFIG = { auto: true, reserved: 1000, tailTurns: 0, prune: true }

/**
 * Prompt yang bulk-nya NYATA, bukan cuma angka usage yang besar.
 *
 * Pemicu pemadatan membaca angka yang dilaporkan provider — di test itu mock,
 * jadi bisa diarang. Keputusan "prune saja cukup, atau perlu diringkas juga?"
 * MENGUKUR permintaan yang akan dikirim (issue #2), dan pengukuran tidak bisa
 * diarang. Riwayat dua pesan pendek karena itu tidak akan naik ke peringkasan
 * berapa pun usage yang dilaporkan — dan itu perilaku yang benar: terukur, pada
 * hasil 28 KB dengan jendela 8192 permintaan yang sungguh dikirim cuma 490 token
 * sementara peringkas menyala di 29 dari 30 langkah.
 *
 * 30.000 byte ÷ 4 = 7.500 token, di atas anggaran 7.192 pada jendela 8192 dengan
 * reserved 1000. Test yang menguji jalur peringkasan harus punya riwayat yang
 * peringkasan sungguh dibutuhkan untuknya.
 */
const bulky = (label: string): string => `${label} ${"z".repeat(30_000)}`

/** Chunk teks lengkap dengan `text-start`/`text-end` — tanpanya AI SDK menolak `text-delta` dengan "text part … not found", dan giliran itu tersimpan sebagai error tanpa baris riwayat sama sekali. */
function textChunk(delta: string, usage: ReturnType<typeof usageWith>): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage },
  ]
}

test("giliran berikutnya memadatkan sendiri saat giliran sebelumnya mengisi konteks", async () => {
  const dir = projectWith(windowConfig(8192, { compaction: COMPACTING_CONFIG }))
  const session = createSession(dir)

  // Satu entri saja: mock mengulang entri terakhirnya, jadi giliran kedua DAN
  // panggilan peringkas sama-sama dilayani bentuk yang sama. `synthesizerFor`
  // memakai streamText, sehingga ia menghabiskan mock yang SAMA.
  recordingModel([textChunk("jawaban", usageWith(7800))])
  await prompt({ sessionID: session.id, text: bulky("giliran satu") })

  await prompt({ sessionID: session.id, text: "giliran dua" })

  const history = listModelMessages(session.id)
  // Positif dulu: pemadatan memang menghasilkan ringkasan yang terpasang, DAN
  // ekornya (giliran dua) memang ada di luar potongan yang diperiksa di bawah
  // — tanpa baris ini, `slice(2)` di bawah bisa saja memeriksa array kosong
  // dan lolos untuk alasan yang salah.
  assert.match(JSON.stringify(history), /context-summary/)
  assert.ok(history.length > 2, "harus ada sesuatu SETELAH pasangan ringkasan untuk diperiksa")
  // Baru negatif: teks giliran pertama sudah tidak dikirim apa adanya.
  assert.doesNotMatch(JSON.stringify(history.slice(2)), /giliran satu/)
})

test("ambang membaca usage.context (langkah TERAKHIR), bukan usage.input (jumlah semua langkah)", async () => {
  // Kalau baris pemicu di agent.ts diam-diam berganti ke usage.input, giliran
  // dua-langkah apa pun memicu pemadatan padahal konteks SEBENARNYA masih
  // jauh di bawah ambang — false positive yang terlihat seperti fitur yang
  // terlalu rajin, bukan seperti bug. Materinya sama dengan test di atas
  // ("usage.context adalah input langkah TERAKHIR..."): tool-call (input 100)
  // lalu teks (input 180) menghasilkan context=180 tapi input(jumlah)=280.
  //
  // Jendelanya 320, bukan 1000: lantai `effectiveReserved` (Task 10) membatasi
  // `reserved` ke paling banyak seperempat jendela, jadi pada jendela 1000
  // ambangnya tidak akan pernah turun di bawah 750 — 180 dan 280 sama-sama
  // jatuh di bawahnya, dan test ini berhenti membedakan apa pun. Pada 320,
  // reserved=750 dijinakkan lantai itu jadi 80 (seperempat dari 320), ambangnya
  // jadi 240 — persis di antara 180 dan 280, tempat perbedaan context/input
  // tadi kembali kelihatan.
  const dir = projectWith(
    windowConfig(320, { compaction: { auto: true, reserved: 750, tailTurns: 0, prune: true } }),
  )
  const session = createSession(dir)

  recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(100) },
    ],
    textChunk("selesai satu", usageWith(180)),
  ])

  const first = await prompt({ sessionID: session.id, text: "giliran satu" })
  // Positif dulu: context (langkah TERAKHIR) dan input (JUMLAH langkah)
  // sungguh berbeda di sini — 180 di bawah ambang 240, 280 di atasnya.
  assert.equal(first.usage?.context, 180)
  assert.equal(first.usage?.input, 280)

  await prompt({ sessionID: session.id, text: "giliran dua" })

  // Baru negatif: dibaca dari context (180 < 240), giliran dua tidak pernah
  // memadatkan apa pun. `tailTurns: 0` di config memastikan kalau ambangnya
  // SAMPAI terlewati, pemadatan akan benar-benar jalan (bukan diam-diam
  // gagal karena alasan lain) — jadi kalau baris pemicu diam-diam berganti ke
  // usage.input, assersi ini akan gagal, bukan lolos untuk alasan yang salah.
  assert.equal(latestCompaction(session.id), undefined)
})

test("prompt giliran ini ikut terukur, walau belum tertulis jadi baris", async () => {
  // Review menemukan ini: `autoCompact` antar-giliran berjalan SEBELUM giliran
  // ini ditulis jadi baris, jadi pesan user-nya tidak ada di `current` sama
  // sekali. Sebuah paste berkas 30 KB sebagai prompt karena itu tidak terlihat
  // oleh keputusan "masih perlu diringkas?" yang justru diambil karenanya.
  //
  // Riwayatnya SENGAJA kecil: satu-satunya yang bisa membawa permintaan ini di
  // atas anggaran adalah prompt giliran dua. Kalau ia tidak ikut terhitung, tidak
  // ada ringkasan yang tersimpan sama sekali.
  const dir = projectWith(windowConfig(8192, { compaction: COMPACTING_CONFIG }))
  const session = createSession(dir)

  recordingModel([textChunk("jawaban", usageWith(7800))])
  await prompt({ sessionID: session.id, text: "pendek" })

  // Positif dulu: giliran satu memang tidak memadatkan apa pun — riwayatnya
  // kecil, jadi tidak ada yang bisa dituduhkan ke giliran ini nanti.
  assert.equal(latestCompaction(session.id), undefined)

  await prompt({ sessionID: session.id, text: bulky("paste berkas besar") })

  assert.ok(
    latestCompaction(session.id),
    "prompt 30 KB itu sendiri yang melewati anggaran, dan harus terhitung",
  )
})

test("giliran ketiga TIDAK meringkas lagi setelah giliran kedua memadatkan", async () => {
  // Kalau angka pra-pemadatan disimpan alih-alih dibaca ulang tiap giliran,
  // sesi akan memadatkan berulang-ulang tanpa kemajuan — terlihat seperti model
  // yang lambat, bukan seperti bug.
  const dir = projectWith(windowConfig(8192, { compaction: COMPACTING_CONFIG }))
  const session = createSession(dir)

  recordingModel([
    textChunk("besar", usageWith(7800)),
    textChunk("ringkasan", usageWith(50)),
    textChunk("kecil", usageWith(50)),
  ])

  await prompt({ sessionID: session.id, text: bulky("giliran satu") })
  await prompt({ sessionID: session.id, text: "giliran dua" })
  // `seq`, bukan `created`: dua pemadatan yang jatuh pada milidetik yang sama
  // punya `created` yang identik dan akan lolos secara kebetulan. `seq` cuma
  // berubah kalau `saveCompaction` benar-benar dipanggil lagi.
  const before = latestCompaction(session.id)?.seq

  await prompt({ sessionID: session.id, text: "giliran tiga" })
  const after = latestCompaction(session.id)?.seq

  assert.ok(before !== undefined, "giliran dua seharusnya sudah memadatkan")
  assert.equal(after, before, "giliran tiga tidak boleh memadatkan lagi")
})

test("smallModel yang salah tidak menjatuhkan giliran, dan sesi tetap menerima prompt berikutnya", async () => {
  // Reproduksi defect kritis: sebelum diperbaiki, `resolver(config,
  // config.smallModel ?? input.model)` dipanggil TANPA pengaman di setiap
  // giliran, sebelum `try` yang `finally`-nya membersihkan `running`. Kalau
  // itu melempar, sesi terkunci "sedang memproses" SELAMANYA. `smallModel`
  // tidak punya konsumen di `src/` sebelum Task 5, jadi nilai siapa pun belum
  // pernah tervalidasi — provider tak dikenal adalah kejadian yang realistis,
  // bukan yang dibuat-buat.
  const dir = projectWith(
    windowConfig(8192, { compaction: COMPACTING_CONFIG, smallModel: "rusak/kecil" }),
  )
  const session = createSession(dir)

  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunk("jawaban", usageWith(7800)) }),
    }),
  })
  // Dihitung, bukan diamati lewat bus: `session.error` TIDAK lagi dipublikasikan
  // untuk kegagalan yang tertangkap (lihat komentar di `agent.ts`), jadi bus
  // bukan sinyal yang bisa dipakai di sini. Menghitung panggilan resolver untuk
  // smallModel langsung adalah satu-satunya cara membedakan "belum pernah
  // dicoba" dari "dicoba dan gagal, lalu ditangkap" — keduanya sama-sama
  // tidak melempar ke pemanggil dan sama-sama tidak menyimpan pemadatan.
  let smallCalls = 0
  // TIDAK lewat `recordingModel`: resolver di sini harus MELEMPAR untuk
  // model kecil yang rusak, sementara model utama tetap dilayani mock —
  // persis situasi nyata (model utama valid, smallModel yang salah).
  restore?.()
  restore = setModelResolver((_config, full) => {
    if (full === "rusak/kecil") {
      smallCalls += 1
      throw new Error('Unknown provider "rusak".')
    }
    return model
  })

  // Giliran satu: belum ada apa pun untuk dipadatkan. `error === undefined` di
  // sini TIDAK cukup untuk membuktikan resolver smallModel belum dipanggil —
  // resolver yang dipanggil eager tapi tertangkap `try/catch` juga akan lolos
  // tanpa error. `smallCalls` di bawah yang membuktikan LAMBAT-nya sungguhan.
  const first = await prompt({ sessionID: session.id, text: bulky("giliran satu") })
  assert.equal(first.error, undefined)
  assert.match(bodyOf(first), /jawaban/)
  assert.equal(smallCalls, 0, "resolver smallModel tidak boleh dipanggil kalau tidak ada yang dipadatkan")

  // Giliran dua: sekarang overBudget benar-benar true dan ada satu giliran
  // untuk dipadatkan (tailTurns: 0 di COMPACTING_CONFIG memaksa itu), jadi
  // `autoCompact` sampai ke `summarise` dan resolver-nya MELEMPAR. Giliran
  // ini sendiri harus tetap SELESAI dengan jawaban, bukan gagal.
  const second = await prompt({ sessionID: session.id, text: "giliran dua" })
  assert.equal(second.error, undefined)
  assert.match(bodyOf(second), /jawaban/)
  // Positif dulu: resolver SUNGGUH dicoba dan gagal tepat sekali — bukan
  // diam-diam tidak pernah dipanggil sama sekali.
  assert.equal(smallCalls, 1, "pemadatan seharusnya sungguh dicoba dan gagal di giliran ini")

  // Baru negatif: kegagalan itu tidak tersimpan sebagai pemadatan.
  assert.equal(latestCompaction(session.id), undefined)

  // Baru buktinya: `running` sungguh terbersihkan. Sebelum perbaikan, baris
  // ini melempar "This session is already processing another turn." karena
  // `finally` di giliran dua tidak pernah tercapai.
  const third = await prompt({ sessionID: session.id, text: "giliran tiga" })
  assert.equal(third.error, undefined)
})

test("giliran multi-langkah memadatkan DI TENGAH, dan konteks yang dikirim menyusut", async () => {
  // Ini kegagalan utama yang jadi alasan fitur ini ada: satu giliran agentic
  // yang membaca banyak berkas, tanpa satu pun pesan user di tengahnya tempat
  // pemeriksaan antar-giliran bisa menyala.
  //
  // EMPAT baca, bukan dua — dan ini bukan pilihan sembarang. `midTurnCut`
  // (`MID_TURN_KEEP` = 6) SELALU menyisakan sekurang-kurangnya enam pesan
  // terakhir apa adanya: potongnya cuma boleh mundur, tidak pernah maju
  // (lihat komentarnya di compact.ts). Dengan satu atau dua baca saja, total
  // pesan yang terkumpul sebelum ambang tersentuh (≤5: user + 2×[panggilan,
  // hasil]) masih di bawah 6, jadi `midTurnCut` mengembalikan 0 dan TIDAK ADA
  // yang dipadatkan — persis jebakan "fixture disenyapkan ambang" dari Task
  // 10, hanya pindah lokasi. Diverifikasi dengan menjalankan test ini secara
  // manual pada draf dua-baca sebelum ditulis ulang: `last` tidak pernah
  // memuat "context-summary" sama sekali.
  //
  // Dengan empat baca, totalnya sembilan pesan (user + 4×[panggilan, hasil]).
  // Memotong menyisakan tepat ENAM pesan terakhir (tiga pasangan), membuang
  // pesan user PLUS baca paling awal (halo.txt). Tiga baca susulan sengaja
  // menyasar filler.txt, yang isinya tidak memuat "baris satu" — kalau tidak,
  // ekor yang "dipertahankan apa adanya" akan diam-diam masih membawa isi
  // lama, dan assertion negatif di bawah lolos untuk alasan yang salah
  // (string itu memang tidak pernah ada, bukan karena sungguh dibuang).
  const model = recordingModel([
    // Baca pertama (halo.txt, "baris satu") — INI yang harus lenyap dari
    // `last`. Usage 2000: jauh di bawah ambang 6144 (= 8192 −
    // effectiveReserved(8192, 8192) = 8192 − min(8192, floor(8192/4)) =
    // 8192 − 2048), supaya belum memicu apa pun.
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
    ],
    // Dua baca filler.txt berikutnya, usage-nya juga di bawah 6144 — giliran
    // ini masih menumpuk pesan, belum memicu pemadatan.
    [
      { type: "tool-call", toolCallId: "c2", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(2500) },
    ],
    [
      { type: "tool-call", toolCallId: "c3", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(3000) },
    ],
    // Baca keempat: 7900 ≥ 6144, inilah yang menyalakan pemadatan SEBELUM
    // langkah teks akhir dimulai.
    [
      { type: "tool-call", toolCallId: "c4", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
    ],
    // Entri ini dikonsumsi DUA kali: sekali oleh peringkas (`synthesizerFor`
    // memakai `streamText` yang sama, jadi memakai penghitung panggilan yang
    // sama), sekali oleh langkah teks akhir sungguhan — mock mengulang entri
    // terakhirnya begitu kehabisan, jadi satu entri ini cukup untuk keduanya.
    textChunk("selesai", usageWith(130)),
  ])

  const dir = projectWith(windowConfig(8192))
  // filler.txt SENGAJA tidak memuat "baris satu" — lihat komentar panjang di
  // atas soal kenapa itu penting untuk assertion negatif di bawah.
  fs.writeFileSync(path.join(dir, "filler.txt"), "konten aman\ntanpa jejak lama\n")
  const session = createSession(dir)
  // Bulk-nya ada di PROMPT, bukan di hasil tool. Sejak issue #2 keputusan
  // naik-ke-peringkasan mengukur permintaan yang akan dikirim, dan hasil tool
  // bisa dibebaskan prune — riwayat yang bulk-nya prunable karena itu berhenti
  // di prune dan tidak pernah butuh peringkas, yang justru perilaku benar.
  // Teks user tidak terjangkau prune, jadi hanya peringkasan yang bisa
  // menghilangkannya: itu yang membuat jalur mid-turn di sini sungguh teruji.
  await prompt({ sessionID: session.id, text: bulky("baca berulang") })

  // Positif dulu: giliran ini memang menempuh beberapa langkah, DAN
  // pemadatan sungguh terpicu (bukan cuma "boleh saja tidak pernah tercapai
  // dan test tetap lolos"). Enam, bukan tiga: empat baca + satu panggilan
  // peringkas + satu langkah teks akhir.
  assert.ok(model.doStreamCalls.length >= 6)

  const first = JSON.stringify(model.doStreamCalls[0]?.prompt)
  const last = JSON.stringify(model.doStreamCalls.at(-1)?.prompt)

  // Yang membuktikan fiturnya bekerja: yang DIKIRIM ke provider memuat
  // ringkasan, bukan sekadar bahwa sebuah fungsi terpanggil.
  assert.match(last, /context-summary/)
  assert.doesNotMatch(last, /baris satu/)
  assert.match(first, /baca berulang/)
})

test("pemadatan mid-turn memotong MUNDUR dari pesan tool, bukan lewat begitu saja, dan tidak ada baris ganda", async () => {
  // Regresi Finding 2 (review ronde 1, task-6-report.md): fixture SEBELUMNYA
  // di test ini (satu baca, usage 7900 lalu 120) memberi `midTurnCut(3, 6)
  // = 0` — TIDAK ADA yang dipotong, TIDAK ADA ringkasan tersimpan. Assertion
  // `messages[0]?.role !== "tool"` lolos, tapi bukan karena jalan-mundur
  // `midTurnCut` bekerja — riwayat memang SELALU dimulai dari "user" apa pun
  // yang terjadi. Dibuktikan lewat mutasi: menghapus SELURUH
  // `while (... role === "tool") cut -= 1` di `midTurnCut` (src/core/compact.ts)
  // tetap membuat seluruh file test ini 24/24 hijau — assertion itu tidak
  // bisa mati karena alasan yang diklaim namanya.
  //
  // Fixture ini memaksa `midTurnCut` SUNGGUH menabrak pesan tool, supaya
  // jalan-mundurnya sungguh teruji:
  //
  // Giliran 1 SENGAJA diakhiri error provider setelah satu baca, sehingga
  // HANYA tiga baris tersimpan — user, assistant(panggil), tool(hasil) —
  // TANPA teks penutup (lihat catatan ledger reviewer: giliran yang error
  // setelah flush mid-turn meninggalkan baris ganjil begitu, dan itu aman,
  // giliran berikutnya tetap pulih). Backlog GANJIL (3) ini penting: giliran
  // yang selesai NORMAL selalu genap (user + pasangan panggilan/hasil +
  // teks penutup), dan pada backlog genap `midTurnCut` tidak akan PERNAH
  // menabrak tool — potongnya selalu jatuh persis di batas pasangan.
  //
  // Giliran 2 menambah SATU pesan user baru + dua baca (empat pesan). Total
  // gabungan = 3 + 1 + 4 = 8 pesan. `midTurnCut(8, MID_TURN_KEEP=6) = 2`, dan
  // pesan indeks 2 dalam gabungan itu PERSIS hasil tool dari giliran 1 —
  // posisi tidak aman. Jalan-mundur WAJIB menggesernya ke indeks 1 (pesan
  // assistant pemanggilnya), yang aman karena hasilnya menyusul tepat
  // sesudahnya. Diverifikasi dengan menjalankan gabungan ini secara manual
  // (lihat task-6-report.md, ronde 1): tanpa jalan-mundur, ringkasan
  // tersimpan dengan batas air satu lebih jauh, dan pesan tail PERTAMA
  // (setelah pasangan ringkasan) adalah "tool" — yatim.
  const dir = projectWith(windowConfig(8192))
  const session = createSession(dir)

  // Giliran 1: satu baca, lalu panggilan kedua model MELEMPAR — mensimulasikan
  // gangguan provider di tengah giliran. `prompt()` tidak boleh macet karena
  // ini (lihat catatan ledger); ia berakhir dengan `error` terisi dan tiga
  // baris yang SUDAH terflush oleh trigger mid-turn tetap tersimpan.
  let calls1 = 0
  const model1 = new MockLanguageModelV4({
    doStream: async () => {
      calls1 += 1
      if (calls1 === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "t1a",
                toolName: "read",
                input: '{"path":"halo.txt"}',
              },
              // 7900 ≥ 6144 (ambang windowConfig(8192) — lihat aritmetika di
              // test "giliran multi-langkah..." di atas): memicu flush
              // mid-turn SEBELUM langkah kedua giliran ini, menuliskan tiga
              // baris ke storage sebelum provider "mati".
              { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
            ] as LanguageModelV4StreamPart[],
          }),
        }
      }
      throw new Error("provider hiccup simulasi")
    },
  })
  restore?.()
  restore = setModelResolver(() => model1)
  const turn1 = await prompt({ sessionID: session.id, text: "baca sekali" })
  // Positif dulu: giliran 1 memang berakhir lewat jalur error yang
  // dimaksud, bukan diam-diam sukses (yang akan mengubah backlognya jadi
  // genap dan meniadakan seluruh premis fixture ini).
  assert.match(turn1.error ?? "", /provider hiccup simulasi/)
  assert.equal(
    listModelRows(session.id).length,
    3,
    "giliran 1 harus berhenti di tiga baris (user, panggilan, hasil), tanpa teks penutup",
  )

  // Giliran 2: user baru + dua baca. Baca kedua yang menyalakan pemadatan.
  const model2 = recordingModel([
    [
      { type: "tool-call", toolCallId: "t2a", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
    ],
    [
      { type: "tool-call", toolCallId: "t2b", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
    ],
    // `textChunk`, bukan `text-delta` telanjang — lihat komentar di test di atas.
    textChunk("selesai", usageWith(130)),
  ])
  // Bulk di PROMPT, bukan di hasil tool: hasil tool bisa dibebaskan prune,
  // dan sejak issue #2 keputusan naik-ke-peringkasan mengukur permintaan yang
  // akan dikirim — jadi riwayat yang bulk-nya prunable berhenti di prune dan
  // tidak pernah butuh peringkas. Teks user tidak terjangkau prune.
  await prompt({ sessionID: session.id, text: bulky("baca lagi") })
  assert.ok(model2.doStreamCalls.length >= 2)

  // Positif: pemadatan SUNGGUH menyimpan ringkasan kali ini (cut=1, bukan
  // 0) — beda dari fixture lama yang tidak pernah mencapai titik ini sama
  // sekali.
  const compaction = latestCompaction(session.id)
  assert.ok(compaction, "gabungan delapan pesan ini harus melewati ambang dan benar-benar memadatkan")

  // Baru negatif, dan BUKAN lewat `listModelMessages()[0]` — itu SELALU
  // "user" begitu ada ringkasan tersimpan (pasangan user+assistant yang
  // dipasang `listModelMessages`, storage/session.ts), jadi memeriksanya
  // tidak pernah bisa membuktikan apa pun soal jalan-mundur `midTurnCut`.
  // Yang membuktikannya adalah baris MENTAH persis di atas batas air —
  // itulah yang `cut` dan jalan-mundurnya benar-benar tentukan.
  const tail = listModelRows(session.id).filter((row) => row.seq > compaction.seq)
  assert.ok(tail.length > 0, "harus ada baris SETELAH batas air untuk diperiksa")
  assert.notEqual(tail[0]?.message.role, "tool", "baris pertama ekor tidak boleh hasil tool yatim")

  const seen = listModelRows(session.id).map((row) => JSON.stringify(row.message))
  assert.equal(new Set(seen).size, seen.length, "ada baris riwayat yang tertulis dua kali")
})

test("smallModel yang salah tidak menjatuhkan giliran walau pemicunya di TENGAH giliran", async () => {
  // Regresi Finding 1 (review ronde 1, task-6-report.md, CRITICAL): sebelum
  // perbaikan, `summarise` di `prepareStep` diresolusi EAGER sebagai
  // argumen ke `autoCompact({...})`, dan `prepareStep` tidak punya
  // try/catch sama sekali. Bandingkan dengan jalur ANTAR-giliran tepat di
  // atas (komentar ":335-336" dan tangkapan ":346-355" di kode) — closure
  // LAMBAT plus `catch {}`, persis bug yang Task 5 sudah perbaiki di sana.
  // Task 6 mewarisi kode SEBELUM perbaikan itu ada untuk jalur mid-turn.
  //
  // EMPAT baca dipakai, bukan satu atau dua. Dengan cut=0 (backlog < enam
  // pesan, seperti fixture "smallModel yang salah..." antar-giliran di
  // atas kalau ditempatkan mid-turn), `autoCompact` pulang lebih dulu lewat
  // `if (plan.dropped.length === 0) return {...}` SEBELUM pernah memanggil
  // `summarise` — closure LAMBAT saja sudah cukup melindungi, dan blok
  // try/catch tidak pernah tersentuh sama sekali. Itu tidak membuktikan
  // apa-apa soal catch itu sendiri. Dengan empat baca (persis fixture
  // "giliran multi-langkah..." di atas: cut=3, ada yang benar-benar
  // dibuang), `summarise` SUNGGUH terpanggil — resolver smallModel yang
  // rusak SUNGGUH dicoba dan SUNGGUH melempar, dan hanya `catch` di
  // `prepareStep` yang mencegah itu menjatuhkan giliran.
  const dir = projectWith(windowConfig(8192, { smallModel: "rusak/kecil" }))
  fs.writeFileSync(path.join(dir, "filler.txt"), "konten lain, bukan baris satu\n")
  const session = createSession(dir)

  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const sequences: LanguageModelV4StreamPart[][] = [
        [
          { type: "tool-call", toolCallId: "e1", toolName: "read", input: '{"path":"halo.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
        ],
        [
          { type: "tool-call", toolCallId: "e2", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(2500) },
        ],
        [
          { type: "tool-call", toolCallId: "e3", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(3000) },
        ],
        [
          { type: "tool-call", toolCallId: "e4", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
        ],
        textChunk("jawaban", usageWith(130)),
      ]
      const parts = sequences[Math.min(calls, sequences.length - 1)] as LanguageModelV4StreamPart[]
      calls += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })

  // TIDAK lewat `recordingModel`: resolver di sini harus melempar UNTUK
  // smallModel secara khusus, sementara model utama tetap dilayani mock —
  // pola yang sama dengan "smallModel yang salah..." antar-giliran di atas.
  let smallCalls = 0
  restore?.()
  restore = setModelResolver((_config, full) => {
    if (full === "rusak/kecil") {
      smallCalls += 1
      throw new Error('Unknown provider "rusak".')
    }
    return model
  })

  // Bulk di PROMPT, bukan di hasil tool: hasil tool bisa dibebaskan prune,
  // dan sejak issue #2 keputusan naik-ke-peringkasan mengukur permintaan yang
  // akan dikirim — jadi riwayat yang bulk-nya prunable berhenti di prune dan
  // tidak pernah butuh peringkas. Teks user tidak terjangkau prune.
  const result = await prompt({ sessionID: session.id, text: bulky("baca berulang lagi") })

  // Positif dulu: resolver smallModel SUNGGUH dicoba tepat sekali — bukan
  // diam-diam tidak pernah tercapai (yang akan membuat assertion di bawah
  // lolos tanpa membuktikan apa pun soal try/catch).
  assert.equal(smallCalls, 1, "pemadatan mid-turn seharusnya sungguh mencoba meringkas dan gagal")

  // Ini yang dulu gagal: giliran berakhir error dan jawabannya kosong,
  // padahal empat tool sudah berhasil jalan sebelum peringkas melempar.
  assert.equal(result.error, undefined)
  assert.match(bodyOf(result), /jawaban/)
  assert.equal(
    latestCompaction(session.id),
    undefined,
    "peringkas yang gagal tidak boleh tersimpan sebagai pemadatan",
  )
})

test("smallModel yang salah TIDAK menghalangi prune mid-turn, dan resolvernya tidak disentuh sama sekali saat prune saja sudah cukup", async () => {
  // Regresi Finding 1 ronde 2 (review): closure LAMBAT + try/catch dari
  // ronde 1 hanya membuktikan giliran tidak MATI kalau smallModel dipaksa
  // dipanggil. Reviewer menunjukkan itu belum cukup — laziness harus berarti
  // resolvernya TIDAK PERNAH dicoba sama sekali ketika prune SAJA sudah
  // memadamkan ambang, bukan sekadar "kalaupun dicoba, errornya tertangkap".
  // Mutasi yang membedakan keduanya: mengganti acuan `summarise` (closure)
  // dengan `synthesizerFor(resolver(...))` yang dievaluasi LANGSUNG sebagai
  // argumen — masih di DALAM try/catch yang sama. Resolver lalu melempar
  // SAAT argumen `autoCompact({...})` dikonstruksi, SEBELUM badan
  // `autoCompact` (tempat prune hidup, src/core/auto-compact.ts:68-78)
  // sempat jalan sama sekali. `catch` menelan lemparan itu diam-diam,
  // `turn.error` tetap `undefined`, dan byte yang seharusnya terpangkas
  // tetap utuh terkirim ke provider — overflow yang fitur ini ada untuk
  // dicegah, gagal TANPA jejak apa pun yang terlihat dari luar.
  //
  // Fixture: baca pertama sebuah berkas ~20 KB (di bawah INLINE_LIMIT 32 KB
  // di storage/blob.ts, supaya isinya tersimpan UTUH, tidak dipotong lebih
  // dulu oleh mekanisme lain — kalau tidak, angka byte yang dibebaskan
  // prune jadi tidak bisa dihitung tangan). Tiga baca kecil susulan
  // menaikkan usage sampai memicu. `midTurnCut(9, 6, anggaran) = 3` memotong
  // PERSIS di pasangan baca besar itu (indeks sama seperti test "giliran
  // multi-langkah..."), dan prune membebaskan sekitar 20.000 byte —
  // sehingga `autoCompact` pulang di jalur PRUNE-SAJA tanpa PERNAH memanggil
  // `summarise`. Diverifikasi lewat probe manual sebelum ditulis ke sini:
  // dengan closure lambat, `smallCalls` tetap 0 dan baris baca besar berubah
  // jadi penanda PRUNED; dengan resolusi eager, `smallCalls` jadi 1 dan
  // penandanya tidak pernah muncul — isi 20 KB tetap utuh di storage.
  //
  // Jendelanya 32768 dan pemicunya 20000 — versi pertama fixture ini memakai
  // 8192/7900, versi kedua 8192/5000. Klaim yang dijaga TIDAK pernah berubah
  // ("prune saja cukup ⇒ resolver smallModel tidak pernah disentuh"); yang
  // berubah hanya aritmetika ambang di sekelilingnya, dua kali, dan keduanya
  // karena perbaikan yang memang mengubah kapan pemadatan menyala.
  //
  // Terakhir: pemicu kini menjumlahkan hasil tool yang BARU TIBA ke ukuran
  // konteks (residu F1). Pada jendela 8192, baca 20 KB itu sendiri ≈5.000
  // token, jadi begitu ia tiba konteks proyeksinya 7.000 — di atas ambang —
  // dan pemadatan menyala di langkah PERTAMA, saat belum ada apa pun di luar
  // potongan untuk diprune. Satu-satunya obat yang tersisa di situ adalah
  // peringkas, jadi premis "prune saja cukup" tidak bisa lagi dibangun pada
  // jendela sekecil itu dengan berkas sebesar itu: 20 KB adalah sepertiga
  // jendela 8192.
  //
  // Pada 32768 proporsinya kembali realistis (≈5.000 token dari anggaran
  // 24.576, ambang 24.576 − min(5.000, 6.144) = 19.576). Tiga usage di
  // depannya (2000/2500/3000, masing-masing ditambah hasil tool langkahnya)
  // tetap jauh di bawah ambang, pemicunya tetap satu kali di langkah yang
  // sama, dan 20000 − 2500 (≈20.000 byte terbebas ÷ 8) = 17.500 sudah di
  // bawah 19.576 — peringkas memang tidak pernah dibutuhkan.
  const dir = projectWith(windowConfig(32768, { smallModel: "rusak/kecil" }))
  const lines = Array.from(
    { length: 400 },
    (_, i) => `konten pruning baris nomor ${i} diisi supaya panjang`,
  )
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n"))
  fs.writeFileSync(path.join(dir, "filler.txt"), "konten kecil, bukan bagian yang dipangkas\n")
  const session = createSession(dir)

  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const sequences: LanguageModelV4StreamPart[][] = [
        [
          { type: "tool-call", toolCallId: "b1", toolName: "read", input: '{"path":"big.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
        ],
        [
          { type: "tool-call", toolCallId: "b2", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(2500) },
        ],
        [
          { type: "tool-call", toolCallId: "b3", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(3000) },
        ],
        [
          { type: "tool-call", toolCallId: "b4", toolName: "read", input: '{"path":"filler.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(20000) },
        ],
        textChunk("jawaban", usageWith(130)),
      ]
      const parts = sequences[Math.min(calls, sequences.length - 1)] as LanguageModelV4StreamPart[]
      calls += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })

  // TIDAK lewat `recordingModel`: resolvernya harus melempar KHUSUS untuk
  // smallModel, sementara model utama tetap melayani baca/teks biasa —
  // pola yang sama dengan "smallModel yang salah..." di atas.
  let smallCalls = 0
  restore?.()
  restore = setModelResolver((_config, full) => {
    if (full === "rusak/kecil") {
      smallCalls += 1
      throw new Error('Unknown provider "rusak".')
    }
    return model
  })

  const result = await prompt({ sessionID: session.id, text: "baca berkas besar" })

  // Positif dulu: giliran selesai NORMAL, DAN resolver smallModel tidak
  // pernah disentuh — itu inti klaim Finding 1: laziness berarti "tidak
  // pernah mencoba sama sekali" saat prune saja sudah cukup, bukan cuma
  // "kalaupun mencoba, amannya ditangkap".
  assert.equal(result.error, undefined)
  assert.match(bodyOf(result), /jawaban/)
  assert.equal(
    smallCalls,
    0,
    "prune saja sudah cukup — resolver smallModel semestinya tidak pernah dicoba",
  )
  assert.equal(latestCompaction(session.id), undefined, "prune-saja tidak menyimpan ringkasan")

  // Baru pembuktian utamanya: penanda PRUNE sungguh mendarat di storage.
  // Tanpa ini, "tidak melempar" bisa lolos karena prune-nya diam-diam TIDAK
  // PERNAH jalan (persis yang terjadi di bawah mutasi) — bukan karena ia
  // sungguh membebaskan byte seperti yang diklaim.
  const rows = listModelRows(session.id)
  const pruned = rows.some((row) =>
    JSON.stringify(row.message).includes("output was dropped to free context"),
  )
  assert.ok(pruned, "hasil baca berkas besar semestinya sudah dipangkas jadi penanda PRUNED")
})

test("smallModel yang salah TIDAK menghalangi prune ANTAR-giliran, dan resolvernya tidak disentuh sama sekali saat prune saja sudah cukup", async () => {
  // Celah yang SAMA dengan test mid-turn di atas, tapi di titik panggil
  // yang BEDA: jalur antar-giliran (agent.ts, closure `summarise` di sekitar
  // ":335-336" dan pemanggilan `autoCompact` tepat di bawahnya). Reviewer
  // secara eksplisit meminta ini dibuktikan terpisah — kedua titik panggil
  // memakai closure yang SAMA, tapi memperbaiki satu tanpa yang lain akan
  // lolos tanpa terdeteksi kalau cuma ada satu test.
  //
  // Giliran 1: satu baca berkas besar dengan usage RENDAH (2000 — sengaja
  // supaya mid-turn TIDAK memicu apa pun di giliran ini sendiri, bahkan
  // setelah hasil 20 KB itu ikut dihitung: 2000 + ≈5.000 = 7.000, jauh di
  // bawah ambang mid-turn 19.576 pada jendela ini; isi besarnya lalu tetap
  // UTUH tersimpan sampai giliran 2 memeriksanya), lalu teks penutup dengan
  // usage TINGGI (25000). Usage langkah TERAKHIR itulah yang jadi
  // `usage.context` yang dibaca giliran berikutnya (lihat test "usage.context
  // adalah input langkah TERAKHIR..." di atas untuk mekanismenya).
  //
  // Giliran 2: giliran SEDERHANA tanpa tool sama sekali. Pemicunya adalah
  // pengecekan ANTAR-giliran di AWAL prompt() — BUKAN apa pun di dalam
  // giliran ini sendiri. `tailTurns: 0` memaksa `tailStart` meringkas
  // SEMUA baris giliran 1 (satu-satunya giliran yang ada; default
  // `tailTurns: 2` akan membiarkan cut=0 karena baru ada satu giliran,
  // lihat komentar `tailStart` di compact.ts), sehingga prune menyasar baca
  // besar itu dan membebaskan cukup byte untuk lolos ambang TANPA pernah
  // memanggil peringkas.
  // 32768, bukan 8192, dan angka giliran satu ikut naik — alasannya identik
  // dengan fixture mid-turn tepat di atas: dengan hasil tool yang baru tiba
  // ikut dihitung, baca 20 KB pada jendela 8192 menyalakan pemadatan MID-TURN
  // di giliran satu, dan giliran itu lalu menyentuh resolver smallModel
  // sebelum pemeriksaan ANTAR-giliran yang justru diuji di sini sempat
  // berjalan. Pada 32768 giliran satu tetap tenang, dan pemicunya kembali
  // murni pemeriksaan antar-giliran di awal giliran dua.
  const dir = projectWith(
    windowConfig(32768, {
      compaction: { auto: true, reserved: 8192, tailTurns: 0, prune: true },
      smallModel: "rusak/kecil",
    }),
  )
  const lines = Array.from(
    { length: 400 },
    (_, i) => `konten pruning baris nomor ${i} diisi supaya panjang`,
  )
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n"))
  const session = createSession(dir)

  let model1Calls = 0
  const model1 = new MockLanguageModelV4({
    doStream: async () => {
      const sequences: LanguageModelV4StreamPart[][] = [
        [
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"big.txt"}' },
          { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
        ],
        textChunk("jawaban1", usageWith(25000)),
      ]
      const parts = sequences[Math.min(model1Calls, sequences.length - 1)] as LanguageModelV4StreamPart[]
      model1Calls += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  const model2 = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunk("jawaban2", usageWith(120)) }),
    }),
  })

  // Resolver TUNGGAL untuk seluruh test, yang model AKTIF-nya ditukar lewat
  // `currentModel` di antara dua giliran — sengaja bukan dua kali
  // `setModelResolver`, supaya `smallCalls` menghitung KEDUA giliran tanpa
  // rantai restore yang perlu disambung manual.
  let currentModel = model1
  let smallCalls = 0
  restore?.()
  restore = setModelResolver((_config, full) => {
    if (full === "rusak/kecil") {
      smallCalls += 1
      throw new Error('Unknown provider "rusak".')
    }
    return currentModel
  })

  const turn1 = await prompt({ sessionID: session.id, text: "baca berkas besar" })
  // Positif dulu: giliran 1 memang mengukur usage.context tinggi yang
  // dibutuhkan test ini — tanpa ini, giliran 2 tidak akan pernah memicu
  // pengecekan antar-giliran sama sekali, dan seluruh assertion di bawah
  // lolos karena tidak ada apa pun yang diperiksa.
  assert.equal(turn1.error, undefined)
  assert.equal(turn1.usage?.context, 25000)

  currentModel = model2
  const turn2 = await prompt({ sessionID: session.id, text: "lanjutkan" })

  // Sama seperti test mid-turn: giliran selesai normal, resolver smallModel
  // tidak pernah tersentuh, tidak ada ringkasan tersimpan (prune saja
  // cukup), dan penanda PRUNE sungguh mendarat di storage.
  assert.equal(turn2.error, undefined)
  assert.match(bodyOf(turn2), /jawaban2/)
  assert.equal(
    smallCalls,
    0,
    "prune saja sudah cukup — resolver smallModel semestinya tidak pernah dicoba di giliran mana pun",
  )
  assert.equal(latestCompaction(session.id), undefined, "prune-saja tidak menyimpan ringkasan")

  const rows = listModelRows(session.id)
  const pruned = rows.some((row) =>
    JSON.stringify(row.message).includes("output was dropped to free context"),
  )
  assert.ok(pruned, "hasil baca berkas besar semestinya sudah dipangkas jadi penanda PRUNED")
})

// `timeout` eksplisit: tanpa sinyal batal yang diteruskan, kegagalan yang
// dijaga test ini berbentuk GANTUNG SELAMANYA, bukan assertion yang merah.
// Suite yang menggantung tanpa batas tidak bisa dibaca siapa pun sebagai
// kegagalan; dua puluh detik mengubahnya jadi kegagalan yang jelas.
test("smallModel yang MENGGANTUNG tidak mengunci sesi: Esc mengakhiri giliran dan prompt berikutnya diterima", { timeout: 20_000 }, async () => {
  // Defect kritis: `synthesizerFor` tidak menerima `abortSignal` sama sekali,
  // jadi `controller.signal` tidak pernah sampai ke peringkas. Diprobe:
  // `abort()` mengembalikan true — UI percaya giliran sudah dibatalkan —
  // sementara `prompt()` masih menggantung beberapa detik kemudian, dan setiap
  // `prompt()` sesudahnya melempar "This session is already processing another
  // turn." untuk sisa umur proses.
  //
  // Ini BUKAN masalah lama yang kebetulan terbawa: sebelum pemadatan otomatis,
  // `summarise` hanya jalan ketika user mengetik `/compact` — ia yang memilih
  // menunggunya. Sekarang ia jalan tanpa diminta.
  const dir = projectWith(
    windowConfig(8192, { compaction: COMPACTING_CONFIG, smallModel: "gantung/kecil" }),
  )
  const session = createSession(dir)

  const main = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunk("jawaban", usageWith(7800)) }),
    }),
  })
  // TIDAK PERNAH selesai sendiri. Satu-satunya jalan keluarnya adalah
  // `abortSignal` — persis provider sungguhan yang menggantung, dan persis
  // sinyal yang dulu tidak pernah diteruskan.
  const hung = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      }),
  })
  restore?.()
  restore = setModelResolver((_config, full) => (full === "gantung/kecil" ? hung : main))

  // Giliran satu mengisi konteks (7800 ≥ ambang), sehingga giliran dua
  // benar-benar sampai ke peringkas antar-giliran.
  // Bulk di giliran SATU, bukan dua: pemadatan antar-giliran mengukur riwayat
  // yang SUDAH ada, dan prompt giliran dua baru menempel sesudah pemadatan
  // memutuskan. Teks user pula, bukan hasil tool — hasil tool bisa dibebaskan
  // prune, dan peringkas tidak akan pernah dibutuhkan.
  const first = await prompt({ sessionID: session.id, text: bulky("giliran satu") })
  assert.equal(first.error, undefined)
  assert.equal(first.usage?.context, 7800)

  const pending = prompt({ sessionID: session.id, text: "giliran dua" })
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Positif dulu: giliran dua memang SEDANG berjalan dan sungguh menggantung
  // di peringkas — kalau ia sudah selesai duluan, seluruh test ini tidak
  // menguji apa pun.
  assert.equal(abort(session.id), true, "giliran dua harus masih berjalan saat dibatalkan")

  // Inti klaimnya: `prompt()` SELESAI. Sebelum perbaikan, baris ini
  // menggantung selamanya.
  const second = await pending
  assert.match(second.error ?? "", /Cancelled by user/)

  // Dan sesinya menerima giliran berikutnya. Kalau `running` bocor, baris ini
  // melempar AgentError alih-alih berjalan.
  const thirdPending = prompt({ sessionID: session.id, text: "giliran tiga" })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(
    abort(session.id),
    true,
    "giliran tiga harus benar-benar BERJALAN — sesi yang terkunci tidak punya apa pun untuk dibatalkan",
  )
  const third = await thirdPending
  assert.match(third.error ?? "", /Cancelled by user/)
})

test("compaction.auto: false mematikan pemadatan mid-turn DI TITIK PANGGILNYA, bukan cuma di dalam autoCompact", async () => {
  // Dua penjaga, dua titik panggil, dan sebelumnya tidak satu pun terpatok:
  // menghapus penjaga di auto-compact.ts, atau yang di agent.ts, atau keduanya,
  // meninggalkan 572/572 hijau. Penjaga di agent.ts punya efek yang TIDAK
  // dimiliki penjaga di dalam autoCompact: ia mencegah flush mid-turn menulis
  // baris lebih awal.
  //
  // Jumlah baris di AKHIR giliran tidak bisa membedakannya — baris yang sama
  // toh ditulis di akhir giliran oleh jalur biasa. Yang membedakan adalah
  // KAPAN: flush mid-turn menuliskannya SEBELUM langkah kedua dimulai. Jadi
  // yang diperiksa di sini adalah isi storage pada saat langkah kedua berjalan,
  // dibaca dari dalam `doStream` langkah itu sendiri.
  const run = async (auto: boolean): Promise<number> => {
    const dir = projectWith(windowConfig(8192, { compaction: { ...COMPACTING_CONFIG, auto } }))
    const session = createSession(dir)
    let calls = 0
    let rowsAtSecondStep = -1
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "g1",
                  toolName: "read",
                  input: '{"path":"halo.txt"}',
                },
                // 7900 melewati ambang, jadi flush mid-turn semestinya jalan
                // tepat sebelum langkah kedua ini.
                { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
              ] as LanguageModelV4StreamPart[],
            }),
          }
        }
        if (rowsAtSecondStep === -1) rowsAtSecondStep = listModelRows(session.id).length
        return { stream: simulateReadableStream({ chunks: textChunk("jawaban", usageWith(120)) }) }
      },
    })
    restore?.()
    restore = setModelResolver(() => model)
    const turn = await prompt({ sessionID: session.id, text: "baca sekali" })
    assert.equal(turn.error, undefined)
    assert.ok(calls >= 2, "giliran harus menempuh dua langkah supaya ada yang bisa diamati")
    return rowsAtSecondStep
  }

  // Positif dulu: dengan auto: true, flush mid-turn SUNGGUH sudah menuliskan
  // tiga baris (user, panggilan, hasil) saat langkah kedua dimulai.
  assert.equal(await run(true), 3, "auto: true harus memflush mid-turn")

  // Baru negatif, dengan fixture yang persis sama: auto: false berarti storage
  // masih kosong saat langkah kedua berjalan — perilakunya persis seperti
  // sebelum fitur ini ada.
  assert.equal(await run(false), 0, "auto: false tidak boleh menulis apa pun mid-turn")
})

test("focus giliran diteruskan ke peringkas di KEDUA jalur, antar-giliran maupun mid-turn", async () => {
  // `test/auto-compact.test.ts` cuma memastikan runner meneruskan focus yang
  // DIBERIKAN padanya; tidak ada yang memastikan agent.ts sungguh memberinya.
  // Membuang `focus: text` dari salah satu (atau kedua) pemanggilan di
  // agent.ts meninggalkan suite hijau, dan ringkasan diam-diam berhenti
  // menghormati apa yang sedang dikerjakan user.

  // --- jalur antar-giliran ---
  const dirBetween = projectWith(windowConfig(8192, { compaction: COMPACTING_CONFIG }))
  const between = createSession(dirBetween)
  const modelBetween = recordingModel([textChunk("jawaban", usageWith(7800))])
  // Bulk di PROMPT, bukan di hasil tool: hasil tool bisa dibebaskan prune,
  // dan sejak issue #2 keputusan naik-ke-peringkasan mengukur permintaan yang
  // akan dikirim — jadi riwayat yang bulk-nya prunable berhenti di prune dan
  // tidak pernah butuh peringkas. Teks user tidak terjangkau prune.
  await prompt({ sessionID: between.id, text: bulky("giliran satu") })
  await prompt({ sessionID: between.id, text: "periksa modul autentikasi" })

  // Positif dulu: peringkas SUNGGUH dipanggil di giliran dua — tanpa ini,
  // pencarian di bawah bisa gagal karena tidak ada panggilan peringkas sama
  // sekali, bukan karena focus-nya hilang.
  assert.ok(latestCompaction(between.id), "giliran dua seharusnya memadatkan")
  assert.match(
    JSON.stringify(modelBetween.doStreamCalls.map((call) => call.prompt)),
    /pay particular attention to: periksa modul autentikasi/,
  )

  // --- jalur mid-turn ---
  // Fixture empat baca yang sama dengan test "giliran multi-langkah..." di
  // atas: cut=3, ada yang benar-benar dibuang, jadi peringkas sungguh dipanggil.
  const dirMid = projectWith(windowConfig(8192))
  fs.writeFileSync(path.join(dirMid, "filler.txt"), "konten aman\n")
  const mid = createSession(dirMid)
  const modelMid = recordingModel([
    [
      { type: "tool-call", toolCallId: "f1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(2000) },
    ],
    [
      { type: "tool-call", toolCallId: "f2", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(2500) },
    ],
    [
      { type: "tool-call", toolCallId: "f3", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(3000) },
    ],
    [
      { type: "tool-call", toolCallId: "f4", toolName: "read", input: '{"path":"filler.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
    ],
    textChunk("selesai", usageWith(130)),
  ])
  // Bulk di PROMPT, bukan di hasil tool: hasil tool bisa dibebaskan prune,
  // dan sejak issue #2 keputusan naik-ke-peringkasan mengukur permintaan yang
  // akan dikirim — jadi riwayat yang bulk-nya prunable berhenti di prune dan
  // tidak pernah butuh peringkas. Teks user tidak terjangkau prune.
  await prompt({ sessionID: mid.id, text: bulky("telusuri berkas konfigurasi") })

  assert.ok(latestCompaction(mid.id), "pemadatan mid-turn seharusnya menyimpan ringkasan")
  assert.match(
    JSON.stringify(modelMid.doStreamCalls.map((call) => call.prompt)),
    /pay particular attention to: telusuri berkas konfigurasi/,
  )
})

/**
 * Model palsu yang melaporkan inputTokens DARI UKURAN PROMPT SUNGGUHAN.
 *
 * Dengan angka usage tetap, pemadatan yang tidak bekerja tetap terlihat rapi —
 * itu sebabnya residu F1 lolos dari seluruh suite. Bentuk ini sama dengan
 * harness pengukuran yang menemukannya. Mengembalikan seri konteks per langkah.
 */
function sizedModel(
  file: string,
  steps: number,
  marker = "",
): { series: number[]; delivered: boolean[] } {
  const series: number[] = []
  // Berapa permintaan yang SUNGGUH membawa isi berkasnya — bukan sekadar
  // permintaan yang besar. Ditandai lewat satu baris khas dari dalam berkas:
  // ukuran saja tidak bisa membedakan "isi berkas sampai" dari "riwayat lain
  // yang kebetulan menumpuk".
  const delivered: boolean[] = []
  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const serialised = JSON.stringify(options.prompt)
      const tokens = Math.round(Buffer.byteLength(serialised) / 4)

      // Peringkas dilayani mock yang SAMA. Menjawabnya dengan teks kosong akan
      // diam-diam membuat setiap peringkasan jadi no-op, dan testnya lalu
      // mengukur sistem yang berbeda dari yang dikira.
      if (serialised.includes("You compress a coding session")) {
        return {
          stream: simulateReadableStream({ chunks: textChunk("Ringkasan.", usageWith(tokens)) }),
        }
      }

      series.push(tokens)
      delivered.push(marker !== "" && serialised.includes(marker))
      calls += 1
      return {
        stream: simulateReadableStream({
          chunks:
            calls >= steps
              ? textChunk("selesai", usageWith(tokens))
              : ([
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: `r${calls}`,
                    toolName: "read",
                    input: JSON.stringify({ path: file }),
                  },
                  { type: "finish", finishReason: "tool-calls", usage: usageWith(tokens) },
                ] as LanguageModelV4StreamPart[]),
        }),
      }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)
  return { series, delivered }
}

/**
 * Berkas berisi baris-baris yang terasa nyata, sebesar `kb` kilobyte.
 * Mengembalikan satu baris dari TENGAHNYA, sebagai penanda "isi ini sampai".
 */
function bigFile(dir: string, name: string, kb: number): string {
  const line = "baris berkas besar nomor xxxx yang cukup panjang untuk terasa nyata"
  const lines: string[] = []
  for (let i = 0, acc = 0; acc < kb * 1024; i += 1) {
    lines.push(`${i} ${line}`)
    acc += line.length + 6
  }
  fs.writeFileSync(path.join(dir, name), lines.join("\n"))
  return lines[Math.floor(lines.length / 2)] as string
}

const WINDOW = 8192

test("satu hasil tool yang jauh lebih besar dari anggaran tidak pernah membuat permintaan melewati jendela", async () => {
  // Residu F1, sumbu yang tidak pernah diukur: UKURAN satu hasil tool. Batas
  // ekor menutup sumbu "berapa langkah"; sumbu ini terbuka lebar. Terukur pada
  // jendela 8192 dengan default penuh: 22 KB aman, 24 KB aman, 26 KB meluap di
  // 11 dari 30 langkah, 28 KB di 29 dari 30, dan 30-32 KB memuncak di 8.998
  // token — 110% jendela. Fixture lama duduk persis di bawah batas itu.
  //
  // Mekanismenya dua lapis. Saat hasil besar BARU TIBA, `used` masih angka
  // langkah sebelumnya yang kecil, dan margin pertumbuhan dijepit seperempat
  // anggaran (1.536) melawan hasil ~7.500 token — jadi pemicu diam, dan
  // permintaan berikutnya sudah di atas jendela. Sesudah itu, satu-satunya obat
  // yang bisa menjangkau hasil itu (memangkas ekor) bergantung pada pertanyaan
  // "masih kelebihan?" yang MENGKREDITKAN byte yang terbebas tanpa pernah
  // MENDEBIT hasil yang baru tiba — jawabannya "sudah muat", dan ekornya tidak
  // pernah tersentuh.
  //
  // 28 KB, bukan 30: ini pita yang PALING sempit dan karena itu yang paling
  // perlu dijaga. Ekornya ~8.000 token, tepat DI BAWAH jendela 8192, jadi
  // tidak ada pintasan apa pun yang menolongnya lebih awal — satu-satunya yang
  // mencegah luapan adalah pemangkasan ekor sebagai upaya TERAKHIR. Terukur
  // tanpa baris itu: 29 dari 30 langkah meluap di 8.304 token.
  const dir = projectWith(windowConfig(WINDOW, { agent: { pembaca: { steps: 8 } } }))
  const marker = bigFile(dir, "raksasa.txt", 28)
  const session = createSession(dir)
  const { series } = sizedModel("raksasa.txt", 8, marker)

  const turn = await prompt({ sessionID: session.id, text: "baca raksasa berulang", agent: "pembaca" })
  assert.equal(turn.error, undefined)

  // Positif dulu, tiga-tiganya perlu sebelum assertion negatif berarti apa pun:
  //  1. gilirannya sungguh menempuh beberapa langkah;
  //  2. bahannya sungguh lebih besar dari anggaran (6144) — kalau tidak, tidak
  //     ada tekanan sama sekali dan "tidak meluap" tidak membuktikan apa pun;
  //  3. ekornya sungguh dipangkas — jadi luapannya dicegah oleh obat yang
  //     dimaksud, bukan karena hasil besarnya kebetulan tidak pernah tiba.
  assert.ok(series.length >= 4, `hanya ${series.length} langkah — fixture tidak menekan apa pun`)
  const isiTokens = Math.ceil(fs.statSync(path.join(dir, "raksasa.txt")).size / 4)
  assert.ok(isiTokens > 6144, `bahan cuma ${isiTokens} token, tidak melebihi anggaran`)
  assert.ok(
    listModelRows(session.id).some((row) =>
      JSON.stringify(row.message).includes("output was dropped to free context"),
    ),
    "ekor semestinya sungguh dipangkas",
  )

  // Baru klaimnya: TIDAK SATU PUN permintaan melewati jendela.
  const over = series.filter((tokens) => tokens > WINDOW)
  assert.deepEqual(
    over,
    [],
    `permintaan melewati jendela ${WINDOW}: ${over.join(", ")} (seri: ${series.join(", ")})`,
  )
})

test("hasil tool yang MASIH MUAT tetap sampai ke model — obatnya tidak boleh kebablasan", async () => {
  // Pasangan wajib test di atas. Obat untuk luapan adalah membuang isi ekor,
  // dan itu tindakan paling mahal yang punya: model kehilangan hasil yang baru
  // saja ia minta. Karena itu ambangnya diukur terhadap JENDELA, bukan
  // anggaran — `reserved` adalah kelapangan untuk jawaban, bukan dinding.
  //
  // Terukur, dan inilah kenapa bedanya penting: baca 22 KB menghasilkan ekor
  // ~6.300 token, DI ATAS anggaran 6.144 tapi DI BAWAH jendela 8.192. Diukur
  // terhadap anggaran, berkas yang sebenarnya muat itu dibuang di setiap
  // langkah (puncak konteks jatuh ke ~1.200) dan model tidak pernah melihat
  // isi berkas yang ia baca sendiri.
  const dir = projectWith(windowConfig(WINDOW, { agent: { pembaca: { steps: 6 } } }))
  const marker = bigFile(dir, "sedang.txt", 22)
  const session = createSession(dir)
  const { series, delivered } = sizedModel("sedang.txt", 6, marker)

  const turn = await prompt({ sessionID: session.id, text: "baca sedang berulang", agent: "pembaca" })
  assert.equal(turn.error, undefined)
  assert.ok(series.length >= 4, `hanya ${series.length} langkah`)

  // Klaimnya diukur sebagai LAJU, bukan "ada satu langkah di suatu tempat".
  // Versi pertama test ini memakai `series.some(t => t > 6144)`, dan itu tidak
  // bisa mendeteksi apa yang namanya janjikan: pola berselang-seling
  // (kirim, penanda, kirim, penanda) memenuhinya sambil membuang isi berkas di
  // separuh langkah. Terukur pada pola itu — 15 dari 30 — dan testnya hijau.
  //
  // Langkah pertama tidak pernah bisa membawa isi berkas (belum ada yang
  // dibaca), jadi yang dituntut adalah SELURUH sisanya.
  const hit = delivered.filter(Boolean).length
  assert.equal(
    hit,
    series.length - 1,
    `isi berkas cuma sampai di ${hit}/${series.length} permintaan — obatnya kebablasan (seri: ${series.join(", ")})`,
  )

  // Dan tetap tanpa luapan.
  const over = series.filter((tokens) => tokens > WINDOW)
  assert.deepEqual(over, [], `permintaan melewati jendela: ${over.join(", ")}`)
})

test("margin pertumbuhan satu langkah memicu pemadatan SEBELUM hasil tool berikutnya meluap, dan tidak bocor ke giliran lain", async () => {
  // Pemicu membaca usage langkah SEBELUMNYA, jadi ia bisa lolos di ambang−1
  // sementara langkah berikutnya tetap menempelkan satu hasil tool utuh.
  // Terukur: jendela 8192, margin 2048, satu baca 6 KB memakan 1.923 token
  // darinya, dan konteksnya mendarat 178 token dari bibir jendela.
  const dir = projectWith(windowConfig(8192, { agent: { pembaca: { steps: 4 } } }))
  const lines = Array.from({ length: 400 }, (_, i) => `baris berkas besar nomor ${i}`)
  fs.writeFileSync(path.join(dir, "besar.txt"), lines.join("\n"))
  fs.writeFileSync(path.join(dir, "kecil.txt"), "sedikit saja\n")
  const session = createSession(dir)

  // Positif dulu, dan inilah yang membuat test ini sungguh menguji marginnya:
  // 5000 memang di BAWAH ambang polos (8192 − 2048 = 6144). Kalau ambangnya
  // dihitung tanpa margin, giliran ini tidak akan memadatkan apa pun.
  assert.equal(overBudget(5000, 8192, 8192), false)

  recordingModel([
    [
      { type: "tool-call", toolCallId: "m1", toolName: "read", input: '{"path":"besar.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(5000) },
    ],
    textChunk("selesai", usageWith(120)),
  ])
  await prompt({ sessionID: session.id, text: bulky("baca besar"), agent: "pembaca" })

  const compaction = latestCompaction(session.id)
  assert.ok(compaction, "margin pertumbuhan seharusnya menyalakan pemadatan di 5000")

  // Giliran kedua: hasil tool KECIL saja. Kalau `largestToolResult` bocor dari
  // giliran sebelumnya, ambangnya tetap tertarik ke 4608 dan giliran ini ikut
  // memadatkan padahal tidak ada yang besar di dalamnya.
  //
  // Yang diperiksa adalah FLUSH mid-turn, bukan batas air pemadatan. Versi
  // pertama test ini menegaskan batas airnya tidak bergerak — dan itu VAKUM:
  // di giliran dua tidak ada apa pun untuk diringkas, jadi `autoCompact`
  // pulang dengan `{ran: true, changed: false}` dan batas airnya memang tidak
  // bisa bergerak, bocor atau tidak. Dibuktikan: menjadikan
  // `largestToolResult` variabel module-level yang tidak pernah direset —
  // kebocoran yang sungguhan, lintas giliran DAN lintas induk/anak —
  // meninggalkan berkas test ini hijau seluruhnya.
  //
  // Flush bergerak: ia jalan tepat ketika ambang terlewati, sebelum
  // `autoCompact` sempat memutuskan apa pun. Dibaca dari DALAM langkah kedua,
  // pola yang sama dengan test `compaction.auto: false` di atas.
  const baris = listModelRows(session.id).length
  let rowsAtStep2 = -1
  let calls2 = 0
  const model2 = new MockLanguageModelV4({
    doStream: async () => {
      calls2 += 1
      if (calls2 === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "m2", toolName: "read", input: '{"path":"kecil.txt"}' },
              // 5000: di bawah ambang giliran ini (6144 − hasil kecil ≈ 6100),
              // tapi di ATAS ambang bocoran (6144 − 1536 = 4608).
              { type: "finish", finishReason: "tool-calls", usage: usageWith(5000) },
            ] as LanguageModelV4StreamPart[],
          }),
        }
      }
      if (rowsAtStep2 === -1) rowsAtStep2 = listModelRows(session.id).length
      return { stream: simulateReadableStream({ chunks: textChunk("selesai dua", usageWith(120)) }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model2)
  await prompt({ sessionID: session.id, text: "baca kecil", agent: "pembaca" })

  // Positif dulu: giliran dua memang menempuh dua langkah, jadi `prepareStep`
  // sungguh dievaluasi di sana dan probe-nya sungguh terisi.
  assert.ok(calls2 >= 2, "giliran dua harus menempuh dua langkah")
  assert.notEqual(rowsAtStep2, -1, "probe di langkah kedua harus benar-benar terbaca")
  assert.equal(
    rowsAtStep2,
    baris,
    "margin giliran sebelumnya tidak boleh ikut menurunkan ambang giliran ini — " +
      "tidak ada yang boleh diflush di tengah giliran dua",
  )
})

test("margin pertumbuhan tidak bocor dari sesi INDUK ke sesi anaknya", async () => {
  // Sisi kedua klaim "per giliran", dan sebelumnya tidak punya test sama
  // sekali. Sub-agent punya riwayat, model, dan jendela sendiri; hasil tool
  // raksasa yang dibaca INDUK tidak boleh menarik ambang anaknya ke bawah dan
  // membuat anak itu memadatkan konteksnya sendiri yang masih lapang.
  //
  // Diuji lewat `runSubagent` sungguhan — jalur yang sama yang dipakai tool
  // `task` — bukan lewat `prompt()` pada sesi anak yang dirakit tangan, supaya
  // yang teruji adalah rakitan yang benar-benar dipakai produksi.
  const dir = projectWith(windowConfig(8192, { agent: { anak: { mode: "subagent", steps: 4 } } }))
  const lines = Array.from({ length: 400 }, (_, i) => `baris berkas besar nomor ${i}`)
  fs.writeFileSync(path.join(dir, "besar.txt"), lines.join("\n"))
  fs.writeFileSync(path.join(dir, "kecil.txt"), "sedikit saja\n")
  const parent = createSession(dir)

  let main = 0
  let parentRowsAtStep2 = -1
  let childRowsAtStep2 = -1
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      // Peringkas dilayani mock yang sama; ia tidak boleh ikut menggeser
      // urutan langkah di bawah.
      if (JSON.stringify(options.prompt).includes("You compress a coding session")) {
        return { stream: simulateReadableStream({ chunks: textChunk("Ringkasan.", usageWith(20)) }) }
      }
      main += 1
      const read = (id: string, file: string, used: number): LanguageModelV4StreamPart[] => [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: id, toolName: "read", input: JSON.stringify({ path: file }) },
        { type: "finish", finishReason: "tool-calls", usage: usageWith(used) },
      ]

      if (main === 1) return { stream: simulateReadableStream({ chunks: read("p1", "besar.txt", 2000) }) }
      if (main === 2) {
        parentRowsAtStep2 = listModelRows(parent.id).length
        return { stream: simulateReadableStream({ chunks: textChunk("induk selesai", usageWith(120)) }) }
      }
      if (main === 3) return { stream: simulateReadableStream({ chunks: read("a1", "kecil.txt", 5000) }) }
      const child = listChildSessions(parent.id)[0]
      if (child && childRowsAtStep2 === -1) childRowsAtStep2 = listModelRows(child.id).length
      return { stream: simulateReadableStream({ chunks: textChunk("anak selesai", usageWith(120)) }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)

  await prompt({ sessionID: parent.id, text: "baca besar dulu" })

  // Positif dulu, di INDUK: hasil 20 KB itu sungguh menurunkan ambang dan
  // membuat induk memflush di tengah gilirannya. Tanpa ini, `0` pada anak di
  // bawah bisa berarti "marginnya memang tidak pernah bekerja di mana pun".
  assert.equal(parentRowsAtStep2, 3, "induk semestinya memflush mid-turn karena hasil 20 KB itu")

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "anak",
    instruction: "baca berkas kecil",
    cwd: dir,
    config: Config.parse({
      model: "mock/m",
      provider: { mock: { models: { m: { contextWindow: 8192 } } } },
      agent: { anak: { mode: "subagent", steps: 4 } },
    }),
    signal: new AbortController().signal,
  })
  assert.equal(result.status, "done", `sesi anak harus selesai: ${result.answer}`)

  // Baru klaimnya: di anak, ambangnya kembali penuh (6144 dikurangi hasil
  // KECIL-nya sendiri), jadi 5000 tidak memicu apa pun dan tidak ada baris
  // yang diflush di tengah giliran anak.
  assert.notEqual(childRowsAtStep2, -1, "probe di langkah kedua anak harus terbaca")
  assert.equal(
    childRowsAtStep2,
    0,
    "hasil tool raksasa milik induk tidak boleh menurunkan ambang sesi anaknya",
  )
})

test("model tanpa contextWindow mengabarkannya SEKALI per sesi, lewat kanal yang bukan error", async () => {
  // Spesifikasinya menjanjikan tiga hal berbicara saat jendela tidak
  // dideklarasikan: `titah doctor`, peringatan sekali per sesi di TUI, dan
  // `/compact` yang tetap jalan. Hanya doctor yang pernah dibangun, sehingga
  // yang tersisa adalah "mati diam-diam" — persis yang tabel keputusan
  // spesifikasi itu tolak.
  //
  // `session.error` SENGAJA tidak dipakai: di seluruh Titah ia berarti giliran
  // GAGAL, dan giliran ini justru berhasil. Ronde sebelumnya sudah pernah
  // mencabut kekeliruan itu sekali.
  const collectAll = (sessionID: string) => {
    const events: Event[] = []
    const controller = new AbortController()
    const stream = bus.subscribe({ sessionID, signal: controller.signal })
    void (async () => {
      for await (const event of stream) events.push(event)
    })()
    return { events, stop: () => controller.abort() }
  }

  // Tanpa `contextWindow` di mana pun: model dideklarasikan, batasnya tidak.
  const dir = projectWith({
    model: "mock/m",
    provider: { mock: { models: { m: {} } } },
  })
  const session = createSession(dir)
  const seen = collectAll(session.id)
  recordingModel([textChunk("jawaban", usageWith(10))])

  await prompt({ sessionID: session.id, text: "giliran satu" })
  await prompt({ sessionID: session.id, text: "giliran dua" })
  seen.stop()

  const notices = seen.events.filter((event) => event.type === "session.notice")
  assert.equal(notices.length, 1, "sekali per SESI, bukan sekali per giliran")
  assert.match(notices[0]?.type === "session.notice" ? notices[0].message : "", /contextWindow/)
  assert.match(notices[0]?.type === "session.notice" ? notices[0].message : "", /compaction is off/)
  // Baru negatif: ia tidak menyamar sebagai kegagalan giliran.
  assert.equal(seen.events.filter((event) => event.type === "session.error").length, 0)

  // Dan sesi yang modelnya MENYATAKAN batasnya tidak diberi kabar apa pun.
  const declared = createSession(projectWith(windowConfig(32768)))
  const quiet = collectAll(declared.id)
  recordingModel([textChunk("jawaban", usageWith(10))])
  await prompt({ sessionID: declared.id, text: "giliran satu" })
  quiet.stop()
  assert.equal(quiet.events.filter((event) => event.type === "session.notice").length, 0)
})

test("steps agent membatasi jumlah langkah giliran", async () => {
  // Tiap langkah memanggil tool lagi; tanpa batas, mock ini berputar sampai
  // MAX_STEPS. Dengan steps: 2, giliran berhenti setelah dua langkah.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
  ])

  // Jendela sengaja besar supaya pemadatan tidak ikut campur — yang diuji di
  // sini murni batas langkah.
  const dir = projectWith(windowConfig(1_000_000, { agent: { scout: { steps: 2 } } }))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "baca terus", agent: "scout" })

  assert.equal(model.doStreamCalls.length, 2)
})

test("agent tanpa steps tetap memakai batas bawaan", async () => {
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
  ])

  const dir = projectWith(windowConfig(1_000_000, { agent: { plain: {} } }))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "baca terus", agent: "plain" })

  assert.equal(model.doStreamCalls.length, 20)
})

test("langkah terakhir dijalankan tanpa tool, sehingga model WAJIB menjawab teks", async () => {
  // Sebelum ini, giliran yang kehabisan langkah berakhir pada tool call dan
  // user dikirimi "try a different model" — nasihat yang menyalahkan pihak
  // yang keliru, karena modelnya baik-baik saja dan cuma kehabisan langkah.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
    // `textChunk`, bukan `text-delta` telanjang — lihat komentar di test lain.
    textChunk("sejauh ini saya menemukan X", usageWith(10)),
  ])

  const dir = projectWith(windowConfig(1_000_000, { agent: { scout: { steps: 2 } } }))
  const session = createSession(dir)
  const message = await prompt({ sessionID: session.id, text: "baca terus", agent: "scout" })

  assert.equal(model.doStreamCalls.length, 2)

  // Positif: langkah pertama memang punya tool.
  const firstTools = model.doStreamCalls[0]?.tools ?? []
  assert.ok(firstTools.length > 0)
  // Baru negatif: langkah terakhir tidak punya satu pun.
  const lastTools = model.doStreamCalls[1]?.tools ?? []
  assert.equal(lastTools.length, 0)

  // Dan hasilnya jawaban teks, bukan pesan "ganti model".
  const text = message.parts.find((part) => part.type === "text")
  assert.match(JSON.stringify(text), /sejauh ini saya menemukan X/)
  assert.doesNotMatch(JSON.stringify(message.parts), /different model/)
})
