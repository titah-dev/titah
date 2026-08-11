import assert from "node:assert/strict"
import test from "node:test"
import type { ModelMessage } from "ai"
import {
  BYTES_PER_TOKEN,
  COMPACT_SYSTEM,
  compactPrompt,
  effectiveReserved,
  estimateTokens,
  KEEP_TURNS,
  MID_TURN_KEEP,
  midTurnCut,
  overBudget,
  planAtCut,
  planCompaction,
  pruneToolOutputs,
  renderMessage,
  renderTranscript,
  reservedCollisions,
  tailStart,
  wrapSummary,
} from "../src/core/compact.ts"
import type { ModelRow } from "../src/core/storage/session.ts"
import { Config } from "../src/core/schema.ts"

const user = (text: string): ModelMessage => ({ role: "user", content: text })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text })

const rows = (messages: ModelMessage[], from = 0): ModelRow[] =>
  messages.map((message, index) => ({ seq: from + index, message }))

const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})
// Nilainya sengaja jauh lebih besar dari penanda prune (97 byte JSON): output
// tiga huruf lama membuat tiap test bytesFreed>0 lolos secara kebetulan lewat
// bug gross-count, bukan lewat perilaku yang benar. Ini memaksa pruning di
// fixture manapun untuk sungguhan menghemat, bukan cuma tampak menghemat.
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: {
        type: "text",
        value:
          "isi lengkap dari hasil tool — cukup panjang supaya pemangkasan ini sungguhan menghemat byte, bukan sekadar berpura-pura",
      },
    },
  ],
})

// ---------- batas potong ----------

test("KEEP_TURNS bawaan adalah 2", () => {
  // Dipatok di sini supaya perubahan nilai bawaan ketahuan sebagai keputusan
  // sengaja, bukan luput karena tiap pemanggil produksi sudah memberi argumen
  // eksplisit dan diam-diam membuat konstanta ini tidak pernah teruji.
  assert.equal(KEEP_TURNS, 2)
})

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

  const kosong = compactPrompt("transkrip", "   ")
  // Positif dulu: buktikan promptnya sungguh dibangun (bukan string kosong)
  // SEBELUM menegaskan apa yang tidak ada di dalamnya — tanpa ini, doesNotMatch
  // di bawah akan lolos juga kalau compactPrompt diam-diam mengembalikan "".
  assert.match(kosong, /<transcript>\ntranskrip\n<\/transcript>/)
  assert.doesNotMatch(kosong, /particular attention/)
})

test("ringkasan dibungkus supaya tidak terbaca sebagai permintaan baru user", () => {
  const wrapped = wrapSummary("Goal: bikin X")
  assert.match(wrapped, /<context-summary>/)
  assert.match(wrapped, /not a new request/)
  assert.match(wrapped, /ask — do not assume/)
  assert.match(wrapped, /Goal: bikin X/)
})

// ---------- overBudget ----------

test("overBudget menyala saat langkah terakhir mencapai window dikurangi reserved", () => {
  assert.equal(overBudget(24576, 32768, 8192), true)
  assert.equal(overBudget(24575, 32768, 8192), false)
})

test("contextWindow yang tidak dideklarasikan TIDAK PERNAH memicu", () => {
  // Positif dulu: token yang sama SUNGGUH memicu begitu window dinyatakan —
  // tanpa ini, `false` di bawah bisa saja lolos karena guard-nya hilang dan
  // `999_999 >= undefined - 8192` sudah `false` lewat NaN, bukan lewat guard.
  assert.equal(overBudget(999_999, 32768, 8192), true)
  // Tanpa batas yang dinyatakan, tidak ada ambang yang bisa dihitung. Menebak
  // di sini berarti memadatkan pada waktu yang salah dan menyembunyikan bahwa
  // fitur ini sebenarnya tidak aktif untuk model tersebut.
  assert.equal(overBudget(999_999, undefined, 8192), false)
})

test("token yang belum terukur TIDAK memicu", () => {
  // Positif dulu: window yang sama SUNGGUH memicu begitu token diketahui —
  // tanpa ini, `false` di bawah bisa saja lolos karena guard-nya hilang dan
  // `undefined >= 32768 - 8192` sudah `false` lewat NaN, bukan lewat guard.
  assert.equal(overBudget(999_999, 32768, 8192), true)
  // Sebelum langkah pertama selesai, tidak ada angka dari provider. Memadatkan
  // di titik itu berarti meringkas riwayat yang belum tentu terlalu besar.
  assert.equal(overBudget(undefined, 32768, 8192), false)
})

test("reserved yang mustahil dijinakkan lantainya, bukan dibiarkan memicu terus", () => {
  // Dulu test ini mematok `overBudget(1, 8192, 16384) === true` dengan alasan
  // salah setelan harus terlihat sebagai pemadatan agresif, bukan fitur mati.
  // Alasan itu gugur ketika ternyata reserved BAWAAN bertabrakan dengan jendela
  // 8k yang umum: yang terlihat bukan salah setelan user, melainkan Titah yang
  // memadatkan tiap giliran tanpa alasan. Lantainya menjinakkan keduanya, dan
  // `doctor` yang bicara soal setelannya.
  assert.equal(effectiveReserved(8192, 16384), 2048)
  assert.equal(overBudget(6144, 8192, 16384), true)
  assert.equal(overBudget(1, 8192, 16384), false)
})

test("reserved tidak boleh menelan lebih dari seperempat jendela", () => {
  // Default reserved (8192) sama besar dengan jendela model 8k, dan itu
  // membuat ambangnya nol — pemadatan menyala tiap giliran walau konteksnya
  // dua belas token. Itu tabrakan bawaan Titah, bukan salah setelan user.
  assert.equal(effectiveReserved(8192, 8192), 2048)
  assert.equal(overBudget(6144, 8192, 8192), true)
  assert.equal(overBudget(6143, 8192, 8192), false)
})

test("jendela besar tidak terpengaruh lantainya", () => {
  // 8192 masih di bawah seperempat dari 200k, jadi nilai yang wajar lewat
  // apa adanya. Lantai ini hanya menangkap yang mustahil.
  assert.equal(effectiveReserved(200_000, 8192), 8192)
  assert.equal(overBudget(191_808, 200_000, 8192), true)
  assert.equal(overBudget(191_807, 200_000, 8192), false)
})

test("reserved nol tetap nol — lantainya batas atas, bukan batas bawah", () => {
  // Lantai membatasi seberapa BANYAK reserved boleh mengambil. User yang
  // sengaja menyetel 0 minta pemadatan sedekat mungkin ke batas, dan itu
  // pilihannya.
  assert.equal(effectiveReserved(8192, 0), 0)
  assert.equal(overBudget(8192, 8192, 0), true)
  assert.equal(overBudget(8191, 8192, 0), false)
})

test("reservedCollisions menyebut model yang reserved-nya menelan jendelanya", () => {
  const config = Config.parse({
    compaction: { reserved: 8192 },
    provider: {
      ollama: {
        models: { "kecil": { contextWindow: 8192 }, "besar": { contextWindow: 200000 } },
      },
    },
  })
  assert.deepEqual(reservedCollisions(config), [
    { model: "ollama/kecil", reserved: 8192, contextWindow: 8192 },
  ])
})

// ---------- pruner ----------

test("BYTES_PER_TOKEN bawaan adalah 8", () => {
  // Dipatok di sini seperti KEEP_TURNS: supaya perubahan angka ini ketahuan
  // sebagai keputusan sengaja, bukan luput karena tidak ada pemanggil yang
  // membaca konstantanya langsung.
  assert.equal(BYTES_PER_TOKEN, 8)
})

test("MID_TURN_KEEP bawaan adalah 6", () => {
  assert.equal(MID_TURN_KEEP, 6)
})

test("pruner mengganti output tool dengan penanda, TIDAK menghapus pesannya", () => {
  // Menghapus pesan `tool` akan meninggalkan tool-call tanpa hasilnya, dan
  // provider menolak riwayat seperti itu. Penanda menjaga strukturnya utuh.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
  ]
  const { messages: pruned, bytesFreed } = pruneToolOutputs(messages, 3)

  assert.equal(pruned.length, messages.length)
  assert.equal(pruned[2]?.role, "tool")
  assert.ok(bytesFreed > 0)

  const first = JSON.stringify(pruned[2])
  assert.match(first, /output was dropped/)
  assert.doesNotMatch(first, /isi/)

  // Di luar batas potong tidak disentuh sama sekali.
  const last = JSON.stringify(pruned[5])
  assert.match(last, /isi/)
})

test("pruner tidak mengubah array aslinya", () => {
  const messages = [toolCall("a"), toolResult("a")]
  const before = JSON.stringify(messages)
  pruneToolOutputs(messages, 2)
  assert.equal(JSON.stringify(messages), before)
})

test("prune kedua atas hasil yang sama tidak membebaskan byte lagi", () => {
  // Tanpa ini, pemicu akan mengira prune selalu menolong dan tidak pernah
  // naik ke peringkasan — sesinya lalu mati persis seperti sebelum fitur ada.
  const messages = [toolCall("a"), toolResult("a")]
  const once = pruneToolOutputs(messages, 2)
  // Positif dulu: prune PERTAMA sungguhan menghemat byte pada data ini —
  // tanpa ini, implementasi yang tidak pernah menghemat apa pun (bytesFreed
  // selalu 0) juga lolos di assert kedua, karena 0 === 0 tidak membedakan
  // "sudah dipangkas" dari "tidak pernah menghemat sama sekali".
  assert.ok(once.bytesFreed > 0)
  const twice = pruneToolOutputs(once.messages, 2)
  assert.equal(twice.bytesFreed, 0)
})

test("banyak output kecil tidak membesarkan riwayat — prune yang tak menghemat dilewati", () => {
  // Bug yang ditemukan review: bytesFreed lama menghitung KOTOR (byte yang
  // dibuang), bukan BERSIH (dikurangi ukuran penanda). Pada satu giliran hasil
  // edit/confirm pendek — kasus nyata, bukan pengecualian — itu membuat
  // bytesFreed positif padahal riwayat SERIALISASINYA justru membesar, karena
  // penanda (97 byte) lebih besar dari tiap output kecil yang digantikannya.
  // Arah kesalahan ini yang dilarang: melebih-lebihkan penghematan membuat
  // pemanggil melewatkan peringkasan yang justru dibutuhkan.
  const messages: ModelMessage[] = []
  for (let i = 0; i < 40; i += 1) {
    messages.push(toolCall(`t${i}`))
    messages.push({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: `t${i}`, toolName: "read", output: { type: "text", value: "ok" } },
      ],
    })
  }
  const before = JSON.stringify(messages)

  const { messages: pruned, bytesFreed } = pruneToolOutputs(messages, messages.length)

  assert.equal(bytesFreed, 0, "output sekecil ini tidak pantas dipangkas — menggantinya tidak menghemat apa pun")
  assert.equal(JSON.stringify(pruned), before, "riwayat dibiarkan apa adanya, bukan malah dibesarkan")
})

test("estimateTokens MEREMEHKAN penghematan, tidak melebih-lebihkannya", () => {
  // Dua arah kesalahan tidak setara: meremehkan berarti satu panggilan
  // smallModel yang mubazir; melebih-lebihkan berarti melewatkan peringkasan
  // yang dibutuhkan lalu mengirim permintaan kebesaran — kegagalan yang jadi
  // alasan seluruh fitur ini dibangun.
  const realistic = 4 // byte per token pada teks nyata
  const bytes = 40_000
  assert.ok(estimateTokens(bytes) < bytes / realistic)
})

test("potong mid-turn tidak pernah jatuh di pesan tool", () => {
  // Di tengah giliran tidak ada pesan user setelah giliran dimulai, jadi aturan
  // tailStart tidak berlaku. Memotong di pesan `tool` meninggalkan hasil tanpa
  // panggilannya, dan provider menolaknya dengan error yang tidak menyebut
  // pemadatan sama sekali.
  const messages = [
    user("kerjakan"),
    toolCall("a"),
    toolResult("a"),
    toolCall("b"),
    toolResult("b"),
    toolCall("c"),
    toolResult("c"),
  ]
  for (let keep = 1; keep <= messages.length; keep += 1) {
    const cut = midTurnCut(messages, keep)
    // Buktikan dulu ADA pesan di indeks itu — tanpa ini, `cut` yang berjalan
    // sampai lewat ujung larik membuat `messages[cut]` `undefined`, dan
    // `undefined?.role !== "tool"` lolos begitu saja tanpa memeriksa apa pun.
    assert.ok(messages[cut], `keep=${keep} cut=${cut} di luar riwayat`)
    assert.notEqual(messages[cut]?.role, "tool", `keep=${keep} memotong di pesan tool`)
  }
})

test("potong mid-turn mundur ke indeks aman terdekat, tidak maju", () => {
  // Maju berarti membuang lebih banyak dari yang diminta — termasuk hasil tool
  // terbaru yang justru paling dibutuhkan model untuk melanjutkan.
  const messages = [user("kerjakan"), toolCall("a"), toolResult("a"), toolCall("b"), toolResult("b")]
  const cut = midTurnCut(messages, 2)
  assert.equal(cut, 3)
  assert.equal(messages[cut]?.role, "assistant")

  // keep=2 di atas kebetulan sudah mendarat di indeks aman (loop tidak pernah
  // jalan), jadi tidak membedakan mundur dari maju. keep=3 mendarat di pesan
  // `tool`: mundur berhenti di 1, maju akan lanjut ke 3 — di sinilah arahnya
  // sungguh diuji.
  assert.equal(midTurnCut(messages, 3), 1, "harus mundur ke pesan assistant sebelumnya, bukan maju")
})

test("potong mid-turn nol saat tidak ada indeks aman", () => {
  const messages = [toolResult("a"), toolResult("b")]
  assert.equal(midTurnCut(messages, 1), 0)
})

test("planAtCut dan planCompaction sepakat soal batas air", () => {
  // Satu aturan batas air, bukan dua. Kalau keduanya menyimpang, jalur
  // mid-turn dan antar-giliran akan menandai titik berbeda sebagai "sudah
  // diringkas", dan sebagian riwayat terkirim dua kali atau hilang.
  const messages = [user("satu"), assistant("a"), user("dua"), assistant("b")]
  const list = rows(messages, 10)
  assert.deepEqual(planCompaction(list, 1), planAtCut(list, tailStart(messages, 1)))
})
