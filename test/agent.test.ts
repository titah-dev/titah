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
const { createSession, latestCompaction, listMessages, listModelMessages, listModelRows } =
  await import("../src/core/storage/session.ts")
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
  await prompt({ sessionID: session.id, text: "giliran satu" })

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

  await prompt({ sessionID: session.id, text: "giliran satu" })
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
  const first = await prompt({ sessionID: session.id, text: "giliran satu" })
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
  await prompt({ sessionID: session.id, text: "baca berulang" })

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
  await prompt({ sessionID: session.id, text: "baca lagi" })
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

  const result = await prompt({ sessionID: session.id, text: "baca berulang lagi" })

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
  // menaikkan usage sampai memicu (7900 ≥ 6144, ambang yang sama dengan
  // test "giliran multi-langkah..." di atas). `midTurnCut(9, 6) = 3`
  // memotong PERSIS di pasangan baca besar itu (indeks sama seperti test
  // "giliran multi-langkah..."), dan prune membebaskan sekitar 20.000 byte
  // — jauh di atas ~14.048 byte (1.756 token × 8) yang dibutuhkan agar
  // `remaining` jatuh di bawah 6144 — sehingga `autoCompact` pulang di
  // jalur PRUNE-SAJA (src/core/auto-compact.ts:83-85) tanpa PERNAH
  // memanggil `summarise`. Diverifikasi lewat probe manual sebelum ditulis
  // ke sini (lihat task-6-report.md ronde 2): dengan closure lambat,
  // `smallCalls` tetap 0 dan baris baca besar berubah jadi penanda PRUNED;
  // dengan resolusi eager, `smallCalls` jadi 1 dan penandanya tidak pernah
  // muncul — isi 20 KB tetap utuh di storage.
  const dir = projectWith(windowConfig(8192, { smallModel: "rusak/kecil" }))
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
          { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
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
  // Giliran 1: satu baca berkas besar dengan usage RENDAH (2000, di bawah
  // 6144 — sengaja supaya mid-turn TIDAK memicu apa pun di giliran ini
  // sendiri, dan isi besarnya tetap UTUH tersimpan sampai giliran 2
  // memeriksanya), lalu teks penutup dengan usage TINGGI (7900). Usage
  // langkah TERAKHIR itulah yang jadi `usage.context` yang dibaca giliran
  // berikutnya (lihat test "usage.context adalah input langkah TERAKHIR..."
  // di atas untuk mekanismenya).
  //
  // Giliran 2: giliran SEDERHANA tanpa tool sama sekali. Pemicunya adalah
  // pengecekan ANTAR-giliran di AWAL prompt() — BUKAN apa pun di dalam
  // giliran ini sendiri. `tailTurns: 0` memaksa `tailStart` meringkas
  // SEMUA baris giliran 1 (satu-satunya giliran yang ada; default
  // `tailTurns: 2` akan membiarkan cut=0 karena baru ada satu giliran,
  // lihat komentar `tailStart` di compact.ts), sehingga prune menyasar baca
  // besar itu dan membebaskan cukup byte untuk lolos ambang TANPA pernah
  // memanggil peringkas.
  const dir = projectWith(
    windowConfig(8192, {
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
        textChunk("jawaban1", usageWith(7900)),
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
  assert.equal(turn1.usage?.context, 7900)

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
