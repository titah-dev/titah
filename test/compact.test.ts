import assert from "node:assert/strict"
import test from "node:test"
import type { ModelMessage } from "ai"
import {
  COMPACT_SYSTEM,
  compactPrompt,
  planCompaction,
  renderMessage,
  renderTranscript,
  tailStart,
  wrapSummary,
} from "../src/core/compact.ts"
import type { ModelRow } from "../src/core/storage/session.ts"

const user = (text: string): ModelMessage => ({ role: "user", content: text })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text })

const rows = (messages: ModelMessage[], from = 0): ModelRow[] =>
  messages.map((message, index) => ({ seq: from + index, message }))

const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "isi" } },
  ],
})

// ---------- batas potong ----------

test("keepTurns menghitung GILIRAN user, bukan pesan", () => {
  // KEEP_TAIL lama menghitung pesan, dan satu giliran agentic bisa 20 pesan —
  // sehingga "4 pesan terakhir" bisa berisi empat hasil tool dari tengah
  // giliran, tanpa satu pun pertukaran yang utuh.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    assistant("jawab satu"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
    assistant("jawab dua"),
    user("tiga"),
    assistant("jawab tiga"),
  ]
  const cut = tailStart(messages, 2)
  assert.equal(messages[cut]?.role, "user")
  // Dua giliran terakhir dimulai di "dua" (indeks 4).
  assert.equal(cut, 4)
})

test("keepTurns lebih besar dari jumlah giliran mempertahankan semuanya", () => {
  const messages = [user("satu"), assistant("jawab")]
  assert.equal(tailStart(messages, 5), 0)
})

test("keepTurns 0 memadatkan seluruh riwayat", () => {
  const messages = [user("satu"), assistant("jawab"), user("dua"), assistant("jawab")]
  assert.equal(tailStart(messages, 0), messages.length)
})

test("batas potong SELALU jatuh di pesan user", () => {
  // Memotong di tengah pasangan tool-call/tool-result meninggalkan tool-result
  // yatim di awal riwayat, dan provider menolaknya dengan error yang tidak
  // menyebut pemadatan sama sekali.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
  ]
  const cut = tailStart(messages, 1)
  assert.equal(messages[cut]?.role, "user")
})

// ---------- rencana ----------

test("rencana memisahkan yang diringkas dari yang dikirim apa adanya", () => {
  // keepTurns=1 di sini menyisakan giliran terakhir saja ("3"), sehingga dua
  // giliran pertama ("1", "2") — empat pesan — masuk ke ringkasan.
  const plan = planCompaction(
    rows([user("1"), assistant("1"), user("2"), assistant("2"), user("3"), assistant("3")]),
    1,
  )

  assert.equal(plan.dropped.length, 4)
  assert.equal(plan.kept, 2)
  assert.equal(plan.watermark, 3, "seq terakhir yang diwakili ringkasan")
})

test("batas air memakai seq SUNGGUHAN, bukan indeks larik", () => {
  // Pemadatan kedua bekerja pada baris yang seq-nya tidak mulai dari nol.
  // Menyamakan indeks dengan seq akan menyimpan batas air yang jauh terlalu
  // rendah, dan pesan yang sudah diringkas ikut terkirim lagi.
  const plan = planCompaction(
    rows(
      [user("1"), assistant("1"), user("2"), assistant("2"), user("3"), assistant("3")],
      40,
    ),
    2,
  )
  assert.equal(plan.watermark, 41)
})

test("tidak ada yang bisa dipadatkan menghasilkan rencana kosong", () => {
  const plan = planCompaction(rows([user("a"), assistant("b")]), 10)
  assert.equal(plan.dropped.length, 0)
})

// ---------- perataan transkrip ----------

test("panggilan dan hasil tool ikut teringkas, dipotong supaya tidak menelan prompt", () => {
  const call: ModelMessage = {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c", toolName: "bash", input: { command: "ls" } }],
  }
  const result: ModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c",
        toolName: "bash",
        output: { type: "text", value: "x".repeat(2000) },
      },
    ],
  }

  assert.match(renderMessage(call), /calls bash .*"command":"ls"/)
  const rendered = renderMessage(result)
  assert.match(rendered, /result of bash/)
  assert.ok(rendered.length < 500, "hasil panjang dipotong")
})

test("penalaran dibuang — ia proses menuju keputusan, bukan keputusannya", () => {
  const message: ModelMessage = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "panjang sekali bertele-tele" },
      { type: "text", text: "kesimpulannya begini" },
    ],
  }
  const rendered = renderMessage(message)
  assert.match(rendered, /kesimpulannya begini/)
  assert.doesNotMatch(rendered, /bertele-tele/)
})

test("transkrip memisahkan pesan dengan jelas", () => {
  assert.equal(renderTranscript([user("a"), assistant("b")]), "user: a\n\nassistant: b")
})

// ---------- instruksi peringkas ----------

test("instruksi peringkas melarang mengarang, dan itu aturan pertamanya", () => {
  // Ringkasan yang meleset lebih berbahaya daripada tidak ada ringkasan: ia
  // terbaca sebagai catatan yang sudah disepakati, dan model tidak punya cara
  // memeriksanya. Karena itu larangan mengarang harus berada di urutan teratas.
  assert.match(COMPACT_SYSTEM, /^You compress/m)
  assert.match(COMPACT_SYSTEM, /1\. Never invent/)
  assert.match(COMPACT_SYSTEM, /verbatim/)
  assert.match(COMPACT_SYSTEM, /unresolved/)
})

test("peringkas diminta mencatat skill, bukan menyalin ulang isinya", () => {
  // Sebuah skill 9 KB yang disalin utuh ke ringkasan membatalkan seluruh gunanya
  // memadatkan konteks.
  assert.match(COMPACT_SYSTEM, /<skill/)
  assert.match(COMPACT_SYSTEM, /which skills were loaded/i)
})

test("fokus dari user menajamkan ringkasan tanpa membuang sisanya", () => {
  const dengan = compactPrompt("transkrip", "keputusan soal skema")
  assert.match(dengan, /keputusan soal skema/)
  assert.match(dengan, /do not drop it/i, "sisanya diringkas, bukan dihapus")

  assert.doesNotMatch(compactPrompt("transkrip", "   "), /particular attention/)
})

test("ringkasan dibungkus supaya tidak terbaca sebagai permintaan baru user", () => {
  const wrapped = wrapSummary("Goal: bikin X")
  assert.match(wrapped, /<context-summary>/)
  assert.match(wrapped, /not a new request/)
  assert.match(wrapped, /ask — do not assume/)
  assert.match(wrapped, /Goal: bikin X/)
})
