import assert from "node:assert/strict"
import test from "node:test"
import type { ModelMessage } from "ai"
import {
  budgetTokens,
  COMPACT_SYSTEM,
  compactPrompt,
  effectiveGrowth,
  effectiveReserved,
  growthTokens,
  KEEP_TURNS,
  messageBytes,
  MID_TURN_KEEP,
  midTurnCut,
  overBudget,
  packChunks,
  planAtCut,
  planCompaction,
  projectedContext,
  pruneToolOutputs,
  REAL_BYTES_PER_TOKEN,
  renderMessage,
  requestTokens,
  summariseInChunks,
  summariserChunkBytes,
  renderTranscript,
  reservedCollisions,
  tailBudgetBytes,
  TAIL_FRACTION,
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
        models: {
          "kecil": { contextWindow: 8192 },
          "besar": { contextWindow: 200000 },
          // reserved (8192) PERSIS sama dengan floor(32768/4) — batasnya sendiri,
          // bukan di sisi manapun darinya. `<=` di reservedCollisions harus
          // menganggap ini AMAN (tidak dilaporkan): dua model di atas jauh dari
          // batas dan lolos untuk alasan yang salah kalau `<=` diam-diam jadi
          // `<`. Tanpa model ini, test lain di seluruh berkas juga tidak
          // menguji batasnya — satu-satunya yang menguji itu adalah test doctor
          // di berkas lain, secara kebetulan.
          "pas": { contextWindow: 32768 },
        },
      },
    },
  })
  assert.deepEqual(reservedCollisions(config), [
    { model: "ollama/kecil", reserved: 8192, contextWindow: 8192 },
  ])
})

test("REAL_BYTES_PER_TOKEN adalah 4, dan ia satu-satunya rasio yang tersisa", () => {
  // Dulu ada dua rasio: 4 untuk BATAS, dan 8 khusus untuk menaksir penghematan
  // prune supaya keputusan "masih perlu diringkas?" condong ke arah meringkas.
  // Asimetri itu hilang bersama alasannya — penghematan tidak ditaksir lagi,
  // permintaannya DIUKUR. Satu perbandingan dengan dua penggaris adalah
  // kesalahan yang lebih halus daripada rasio yang keliru.
  assert.equal(REAL_BYTES_PER_TOKEN, 4)
  assert.equal(growthTokens(40_000), 10_000)
})

test("requestTokens mengukur pesan yang SUNGGUH akan dikirim, plus system prompt", () => {
  // Inti issue #2. Yang membuat angka ini benar bukan rasionya, melainkan bahwa
  // objeknya nyata: pesan-pesan ini persis yang berangkat. Pendahulunya
  // mengurangi taksiran byte dari `inputTokens` yang dilaporkan provider untuk
  // permintaan LAIN satu langkah sebelumnya.
  const messages = [user("satu"), assistant("dua")]
  const bytes = messages.reduce((total, message) => total + messageBytes(message), 0)

  assert.equal(requestTokens(messages), growthTokens(bytes))
  // System prompt ikut memakan jendela yang sama. Mengabaikannya berarti
  // meremehkan permintaan, dan meremehkan ukuran permintaan berarti mengirim
  // yang kebesaran — arah kesalahan yang paling mahal dari semuanya.
  assert.equal(requestTokens(messages, 4_000), growthTokens(bytes + 4_000))
  assert.ok(requestTokens(messages, 4_000) > requestTokens(messages))
})

test("requestTokens tumbuh bersama isinya, bukan bersama jumlah pesannya", () => {
  // Penjaga arah: satu hasil `read` 28 KB dan tujuh pesan pendek adalah dua
  // situasi yang sangat berbeda ukurannya, dan pengukuran yang menghitung pesan
  // akan menyamakan keduanya.
  const banyakPendek = Array.from({ length: 7 }, (_, index) => user(`pesan ${index}`))
  const satuBesar = [user("x".repeat(28_000))]

  assert.ok(requestTokens(satuBesar) > requestTokens(banyakPendek) * 10)
})

// ---------- peringkas berpotong ----------

test("anggaran prompt peringkas adalah SELURUH prompt, bukan cuma transkripnya", () => {
  // Inti issue #1: prompt peringkas TIDAK dibatasi apa pun. Terukur, dengan
  // smallModel yang menyatakan contextWindow 4096, prompt yang dikirim 78.964
  // token lewat `/compact` dan 79.662 lewat jalur otomatis — 19,3x dan 19,4x.
  //
  // Kontraknya: `summariserChunkBytes` memulangkan anggaran SELURUH prompt, dan
  // `summariseInChunks` yang menguranginya dengan instruksi, pembungkus, dan
  // teks fokus. Pembagian itu penting — pada versi sebelumnya sebagian
  // pengurangan dilakukan di sini dan sebagian tidak dilakukan siapa pun, dan
  // teks fokus lolos dari hitungan sama sekali (42.515 byte pada jendela 4096).
  assert.equal(summariserChunkBytes(4096, 1000), budgetTokens(4096, 1000) * REAL_BYTES_PER_TOKEN)
  assert.ok(summariserChunkBytes(4096, 1000) > 0)
  // Dan yang dijaga adalah prompt yang SUNGGUH dikirim, bukan angka perantara:
  // itu dipatok oleh test "tidak satu pun prompt melewati anggaran" di bawah.
})


test("jendela yang lebih kecil memberi potongan yang lebih kecil, dan tidak pernah negatif", () => {
  assert.ok(summariserChunkBytes(32_768, 1000) > summariserChunkBytes(8192, 1000))
  // Jendela yang lebih kecil dari instruksinya sendiri tidak boleh menghasilkan
  // angka negatif atau nol: potongan nol berarti pemotongan tidak pernah maju
  // dan giliran menggantung selamanya.
  assert.ok(summariserChunkBytes(64, 0) > 0)
})

test("transkrip yang lebih besar dari jendela peringkas diringkas BERPOTONG, tidak dipotong provider", async () => {
  // Acceptance pertama issue #1: transkrip yang lebih besar dari jendela
  // smallModel tidak menghasilkan ringkasan yang terpotong diam-diam.
  const parts = Array.from({ length: 12 }, (_, index) => `user: bagian ${index} ${"a".repeat(900)}`)
  const prompts: string[] = []
  const summarise = async (_system: string, prompt: string): Promise<string> => {
    prompts.push(prompt)
    return `ringkasan dari ${prompt.length} byte`
  }

  const chunkBytes = 2_000
  const summary = await summariseInChunks(summarise, parts, chunkBytes)

  // Positif dulu: bahannya memang jauh lebih besar dari satu potongan, jadi
  // test ini sungguh menguji pemotongan dan bukan jalur satu-panggilan.
  assert.ok(parts.join("\n\n").length > chunkBytes * 4)
  assert.ok(prompts.length > 1, "harus lebih dari satu panggilan")

  // INTI KLAIMNYA: tidak satu pun prompt yang melewati anggaran potongan.
  // Inilah yang membuat pemotongan diam-diam oleh provider tidak mungkin lagi.
  for (const prompt of prompts) {
    assert.ok(
      Buffer.byteLength(prompt) <= chunkBytes + Buffer.byteLength(COMPACT_SYSTEM),
      `prompt ${Buffer.byteLength(prompt)} byte melewati anggaran ${chunkBytes}`,
    )
  }
  assert.match(summary, /ringkasan dari/)
})

test("satu pesan yang sendirian lebih besar dari potongan dipotong EKSPLISIT, dengan penanda", async () => {
  // Tanpa ini, pemotongan tetap terjadi — hanya saja di sisi provider, tanpa
  // satu pun jejak. Penanda membuat model tahu ada yang hilang.
  const parts = [`user: raksasa ${"b".repeat(20_000)}`]
  const prompts: string[] = []
  const summarise = async (_system: string, prompt: string): Promise<string> => {
    prompts.push(prompt)
    return "ringkasan"
  }

  await summariseInChunks(summarise, parts, 2_000)

  assert.equal(prompts.length, 1)
  assert.ok(Buffer.byteLength(prompts[0] ?? "") <= 2_000 + Buffer.byteLength(COMPACT_SYSTEM))
  assert.match(prompts[0] ?? "", /truncated/i)
})

test("transkrip yang muat tetap satu panggilan, dan fokus user ikut terbawa", async () => {
  // Jalur umum tidak boleh berubah perilakunya: satu potongan berarti satu
  // panggilan, persis seperti sebelum pemotongan ada.
  const prompts: string[] = []
  const summarise = async (_system: string, prompt: string): Promise<string> => {
    prompts.push(prompt)
    return "ringkasan"
  }

  const summary = await summariseInChunks(summarise, ["user: pendek"], 100_000, "modul autentikasi")

  assert.equal(prompts.length, 1)
  assert.equal(summary, "ringkasan")
  assert.match(prompts[0] ?? "", /modul autentikasi/)
})

test("fokus user dipakai di panggilan TERAKHIR, bukan cuma per potongan", async () => {
  // Yang dibaca model adalah ringkasan akhir. Fokus yang cuma dipasang di
  // potongan-potongan bisa hilang saat ringkasan-ringkasan itu diringkas lagi.
  const parts = Array.from({ length: 8 }, (_, index) => `user: bagian ${index} ${"c".repeat(900)}`)
  const prompts: string[] = []
  const summarise = async (_system: string, prompt: string): Promise<string> => {
    prompts.push(prompt)
    return "ringkasan potongan"
  }

  await summariseInChunks(summarise, parts, 2_000, "skema basis data")

  assert.ok(prompts.length > 1)
  assert.match(prompts.at(-1) ?? "", /skema basis data/)
})

test("SATU potongan yang gagal menghentikan semuanya dan menghasilkan kosong", async () => {
  // Melewati potongan yang gagal akan menghasilkan ringkasan yang diam-diam
  // kehilangan satu bagian transkrip, lalu menyimpannya seolah utuh — persis
  // kegagalan yang seluruh fitur ini ada untuk mencegah. Kosong jauh lebih baik:
  // pemanggilnya lalu membiarkan riwayat lama apa adanya.
  //
  // Ada alasan kedua yang lebih keras: `synthesizerFor` mengembalikan string
  // kosong (bukan melempar) baik saat model gagal MAUPUN saat dibatalkan.
  // Melanjutkan sesudah pembatalan berarti memanggil model dengan signal yang
  // sudah abort, dan panggilan itu menggantung selamanya — terukur, satu giliran
  // tergantung 20 detik sampai test-nya menyerah.
  const parts = Array.from({ length: 8 }, (_, index) => `user: bagian ${index} ${"d".repeat(900)}`)

  let calls = 0
  const gagalDiPotonganKedua = async (): Promise<string> => {
    calls += 1
    return calls === 2 ? "" : "ringkasan"
  }
  const summary = await summariseInChunks(gagalDiPotonganKedua, parts, 2_000)

  assert.equal(summary.trim(), "", "hasilnya kosong, bukan ringkasan yang bolong")
  assert.equal(calls, 2, "berhenti di potongan yang gagal, tidak memanggil sisanya")

  // Dan seluruhnya kosong tetap kosong.
  assert.equal((await summariseInChunks(async () => "", parts, 2_000)).trim(), "")
})

test("pemotongan selalu maju: peringkas yang membalas sepanjang bahannya tidak membuat giliran menggantung", async () => {
  // Rekursi "ringkas ringkasannya" hanya menyelesaikan sesuatu kalau hasilnya
  // MENYUSUT. Peringkas yang mengembalikan teks sepanjang masukannya adalah
  // kasus nyata pada model kecil yang bingung, dan tanpa batas kedalaman ia
  // menggantung giliran selamanya — di jalur yang user tidak pernah minta.
  let calls = 0
  const summarise = async (_system: string, prompt: string): Promise<string> => {
    calls += 1
    return "e".repeat(Buffer.byteLength(prompt))
  }
  const parts = Array.from({ length: 10 }, (_, index) => `user: bagian ${index} ${"f".repeat(900)}`)

  const summary = await summariseInChunks(summarise, parts, 2_000)

  assert.ok(calls > 1, "harus sungguh mencoba memotong")
  assert.ok(calls < 40, `berhenti sendiri, bukan menggantung — ${calls} panggilan`)
  assert.ok(summary.length > 0)
})

test("teks fokus ikut dihitung, dan dibatasi — bukan dikirim utuh tiap potongan", async () => {
  // Ronde review kedua menemukan ini, dan ia mengalahkan seluruh batas issue #1:
  // `focus` adalah teks prompt user (`focus: text`), tidak dibatasi apa pun, dan
  // `compactPrompt` menempelkannya ke SETIAP potongan. Terukur pada versi itu:
  // anggaran potongan 11.047 byte, prompt nyata 42.515 byte ≈ 10.629 token pada
  // jendela 4096 — 2,6x, dan transkripnya duduk di DEPAN prompt, jadi yang
  // dipotong provider justru bahan yang sedang diringkas.
  const focus = "spesifikasi ".repeat(2_500) // ~30 KB, seperti paste berkas
  const parts = Array.from({ length: 12 }, (_, index) => `user: bagian ${index} ${"a".repeat(900)}`)
  const budget = 6_000

  const prompts: string[] = []
  await summariseInChunks(
    async (system, prompt) => {
      prompts.push(system + prompt)
      return "RINGKASAN"
    },
    parts,
    budget,
    focus,
  )

  assert.ok(prompts.length > 1, "harus sungguh memotong, kalau tidak test ini kosong")
  for (const whole of prompts) {
    assert.ok(
      Buffer.byteLength(whole) <= budget,
      `prompt ${Buffer.byteLength(whole)} byte melewati anggaran ${budget}`,
    )
  }
  // Fokusnya tetap sampai — dipotong, bukan dibuang: ia tetap menajamkan
  // ringkasan, hanya tidak lagi boleh menelan seluruh jendela.
  assert.match(prompts[0] ?? "", /spesifikasi/)
})

test("batas kedalaman menyatukan SEMUA ringkasan, dan menandai kalau harus memotong", async () => {
  // Review menemukan ini, dan ia sama beratnya dengan issue #1 sendiri:
  // fallback batas kedalaman mengambil `packChunks(...)[0]` — potongan PERTAMA —
  // dan menjatuhkan sisanya tanpa penanda apa pun. Terukur pada versi itu: bahan
  // 15.908 byte jadi ringkasan 506 byte, `truncated` tidak ada di mana pun, lalu
  // disimpan dan batas air maju. ~97% riwayat hilang permanen, senyap.
  //
  // Peringkas di sini SENGAJA tidak menyusutkan apa pun (balas sepanjang
  // masukannya), supaya rekursinya pasti mencapai batas kedalaman.
  const parts = Array.from({ length: 40 }, (_, index) => `user: bagian ${index} ${"a".repeat(380)}`)
  const summary = await summariseInChunks(
    async (_system, prompt) => "R".repeat(Math.floor(Buffer.byteLength(prompt) / 2)),
    parts,
    1_000,
  )

  // Yang dijamin: kalau ada yang hilang, penandanya ADA. Itu seluruh perbedaan
  // antara "model tahu ada yang hilang" dan "model menjawab yakin seolah tidak".
  assert.match(summary, /truncated/i)
  // Dan hasilnya tetap dibatasi anggaran, karena ringkasan ini akan ikut di
  // SETIAP permintaan berikutnya.
  assert.ok(
    Buffer.byteLength(summary) <= 1_000,
    `ringkasan ${Buffer.byteLength(summary)} byte melewati anggaran 1.000`,
  )
})

test("jendela peringkas yang TIDAK diketahui berarti jangan dipotong, bukan potongan terkecil", async () => {
  // Regresi yang review temukan: `summariserWindowFor` mengembalikan 0 kalau
  // tidak ada satu pun jendela dideklarasikan, `budgetTokens(0, …)` jadi nol,
  // hasilnya negatif, dan lantai MIN_CHUNK_BYTES memberi 512 byte. Transkrip
  // 200 KB lalu jadi ~400 panggilan smallModel berurutan — padahal sebelum
  // pemotongan ada, `/compact` cuma satu panggilan.
  //
  // Aturan Titah sendiri yang berlaku di sini: jendela yang tidak dideklarasikan
  // berarti MATI, bukan ditebak. Untuk pemotongan, "mati" berarti tidak memotong.
  assert.equal(summariserChunkBytes(undefined, 8192), Number.POSITIVE_INFINITY)

  const parts = Array.from({ length: 200 }, (_, index) => `user: bagian ${index} ${"b".repeat(900)}`)
  let calls = 0
  await summariseInChunks(
    async () => {
      calls += 1
      return "RINGKASAN"
    },
    parts,
    summariserChunkBytes(undefined, 8192),
  )
  assert.equal(calls, 1, "satu panggilan, persis seperti sebelum pemotongan ada")

  // Jendela yang dideklarasikan tapi mungil tetap dapat lantai, karena potongan
  // nol berarti pemotongan tidak pernah maju.
  assert.ok(summariserChunkBytes(64, 0) > 0)
  assert.ok(summariserChunkBytes(64, 0) < Number.POSITIVE_INFINITY)
})

test("pemotongan dihitung per BYTE, bukan per karakter", async () => {
  // Review menemukan `String.prototype.slice` dipakai terhadap anggaran byte.
  // Terukur: satu bagian 2.000 karakter CJK dengan anggaran 1.000 byte
  // menghasilkan potongan 2.834 byte — 2,8x. Untuk transkrip non-ASCII prompt
  // peringkas tetap melewati jendelanya, yaitu luapan yang mau dicegah.
  const cjk = `user: ${"。".repeat(2_000)}`
  const [chunk] = packChunks([cjk], 1_000)

  assert.ok(chunk !== undefined)
  assert.ok(
    Buffer.byteLength(chunk) <= 1_000,
    `potongan ${Buffer.byteLength(chunk)} byte melewati anggaran 1.000`,
  )
  assert.match(chunk, /truncated/i)
  // Dan tidak memotong di tengah karakter: tanpa penjagaan itu ujungnya jadi
  // U+FFFD, yang masuk ke prompt sebagai sampah.
  assert.doesNotMatch(chunk, /�/)
})

test("pemisah antar-bagian ikut dihitung, jadi potongan tidak melewati batasnya", () => {
  // Ronde review ketiga: `bytes` hanya menjumlahkan `byteLength(part)`, sementara
  // `flush()` menyatukannya dengan "\n\n". Satu potongan karena itu bisa
  // sebesar `limit + 2×(jumlah−1)`. Untuk giliran agentic panjang dengan puluhan
  // pesan pendek per potongan, itu beberapa persen di atas anggaran peringkas —
  // kecil, tapi satu-satunya tugas fungsi ini adalah "tiap potongan muat".
  // Di ATAS lantai MIN_CHUNK_BYTES (512): di bawahnya lantai itu yang berlaku dan
  // test ini akan mengukur angka yang bukan miliknya.
  const parts = Array.from({ length: 60 }, (_, index) => `user: pesan nomor ${index} di sini`)
  const limit = 1_000

  const chunks = packChunks(parts, limit)

  assert.ok(chunks.length > 1, "harus sungguh memotong, kalau tidak test ini kosong")
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk) <= limit,
      `potongan ${Buffer.byteLength(chunk)} byte melewati anggaran ${limit}`,
    )
  }
  // Dan tidak ada bagian yang hilang gara-gara akuntansi yang lebih ketat.
  for (const part of parts) assert.ok(chunks.some((chunk) => chunk.includes(part)))
})

test("potongan multibyte tetap utuh saat ukurannya tepat di batas", async () => {
  // Penjaga arah untuk pemotongan per byte: memotong satu byte terlalu jauh
  // membelah karakter, memotong satu byte terlalu sedikit membuang karakter yang
  // sebenarnya masih muat.
  const teks = "。".repeat(10)
  const utuh = Buffer.byteLength(teks) // 30 byte
  const [pas] = packChunks([teks], utuh)
  assert.equal(pas, teks, "yang tepat muat tidak boleh disentuh sama sekali")
})

// ---------- pruner ----------

test("MID_TURN_KEEP bawaan adalah 6", () => {
  assert.equal(MID_TURN_KEEP, 6)
})

test("TAIL_FRACTION bawaan adalah 4, dan anggaran ekor dihitung darinya", () => {
  // Dipatok seperti KEEP_TURNS: angka ini yang menentukan
  // seberapa gemuk ekor mid-turn boleh jadi, dan tanpa patokan ia bisa bergeser
  // tanpa ada yang menyadarinya sebagai keputusan.
  assert.equal(TAIL_FRACTION, 4)
  // Anggaran = seperempat token yang tersedia, dikonversi ke byte lewat rasio
  // teks NYATA. Pada jendela 8192 dengan reserved bawaan 8192: anggaran token
  // 8192 − min(8192, 2048) = 6144, seperempatnya 1536, dikali 4 byte = 6144.
  assert.equal(budgetTokens(8192, 8192), 6144)
  assert.equal(tailBudgetBytes(8192, 8192), 6144)
})

test("ekor mid-turn dibatasi UKURAN, bukan cuma jumlah pesan", () => {
  // Ini kegagalan yang terukur: satu berkas 22 KB dibaca berulang pada jendela
  // 8192 membuat konteks yang dikirim memuncak di 19.407 token — 2,4x
  // jendelanya — karena "enam pesan terakhir" tidak membatasi apa pun ketika
  // satu pesan saja berisi 22 KB.
  const big = (id: string): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "read",
        output: { type: "text", value: "x".repeat(5_000) },
      },
    ],
  })
  const messages = [
    user("kerjakan"),
    toolCall("a"),
    big("a"),
    toolCall("b"),
    big("b"),
    toolCall("c"),
    big("c"),
  ]

  // Positif dulu: dengan anggaran yang longgar, batas JUMLAH yang berlaku —
  // tujuh pesan, MID_TURN_KEEP enam, jadi potongnya di indeks 1. Tanpa baris
  // ini, assertion di bawah tidak bisa membedakan "dibatasi ukuran" dari
  // "fungsinya memang selalu memotong di dekat ujung".
  assert.equal(midTurnCut(messages, MID_TURN_KEEP, 1_000_000), 1)

  // Baru batas ukurannya: satu hasil 5 KB saja sudah melewati anggaran 6 KB
  // begitu ditemani pasangannya, jadi ekornya menyusut ke pasangan terakhir.
  const cut = midTurnCut(messages, MID_TURN_KEEP, 6_144)
  assert.equal(cut, 5)
  assert.notEqual(messages[cut]?.role, "tool")

  // Dan ekornya memang muat: itu klaim yang sesungguhnya dijaga.
  const tailBytes = messages.slice(cut).reduce((sum, message) => sum + messageBytes(message), 0)
  assert.ok(tailBytes <= 6_144 * 2, `ekor ${tailBytes} byte masih jauh melampaui anggaran`)
})

test("ekor mid-turn SELALU menyisakan sekurang-kurangnya satu pesan", () => {
  // Tanpa jaminan ini, satu hasil tool yang lebih besar dari seluruh anggaran
  // membuat ekornya kosong — dan model tidak punya apa pun untuk melanjutkan.
  const huge: ModelMessage = {
    role: "assistant",
    content: "y".repeat(50_000),
  }
  const messages = [user("kerjakan"), toolCall("a"), toolResult("a"), huge]

  // Positif dulu: pesan itu memang jauh lebih besar dari anggarannya.
  assert.ok(messageBytes(huge) > 100)
  assert.equal(midTurnCut(messages, MID_TURN_KEEP, 100), 3)
})

test("jumlah pesan tetap BATAS ATAS — ekor kecil tidak tumbuh cuma karena murah", () => {
  // Anggaran raksasa tidak boleh membuat ekor menelan seluruh riwayat: hanya
  // sepuluh pesan terakhir yang relevan untuk langkah berikutnya, sisanya
  // adalah persis yang seharusnya diringkas.
  const messages = Array.from({ length: 20 }, (_, i) => assistant(`langkah ${i}`))
  assert.equal(midTurnCut(messages, MID_TURN_KEEP, Number.MAX_SAFE_INTEGER), 14)
})

test("potong mid-turn mundur melewati DUA pesan tool berurutan", () => {
  // Jalan-mundurnya `while`, bukan `if`. Tidak ada fixture ujung-ke-ujung yang
  // membangun dua pesan `tool` bersebelahan, jadi arah ini hanya bisa dijaga
  // dari input sintetis — dan `if` diam-diam mendarat di pesan tool kedua,
  // meninggalkan hasil yatim yang ditolak provider.
  const messages = [user("kerjakan"), toolCall("a"), toolResult("a"), toolResult("b")]

  // Positif dulu: dua pesan terakhir memang sama-sama `tool`, kalau tidak
  // seluruh premis test ini kosong.
  assert.equal(messages[2]?.role, "tool")
  assert.equal(messages[3]?.role, "tool")

  const cut = midTurnCut(messages, 1)
  assert.equal(cut, 1, "harus mundur DUA kali, sampai pesan assistant pemanggilnya")
  assert.notEqual(messages[cut]?.role, "tool")
})

test("projectedContext menjumlahkan yang baru tiba, dan MEMPERTAHANKAN 'belum terukur'", () => {
  // Cabang `undefined` bukan hiasan: ia yang membedakan "belum ada giliran yang
  // sempat mengukur apa pun" dari "konteksnya nol". Meratakannya jadi
  // `(lastStepTokens ?? 0) + arrivedTokens` mengubah sesi yang belum pernah
  // terukur menjadi angka yang bisa dibandingkan dengan ambang — dan pada hasil
  // tool yang cukup besar, angka itu langsung melewati ambang, sehingga
  // pemadatan menyala di giliran yang belum punya apa pun untuk dipadatkan.
  //
  // Positif dulu: penjumlahannya sungguh terjadi.
  assert.equal(projectedContext(6142, 1500), 7642)
  assert.equal(projectedContext(0, 0), 0)
  // Baru negatif: yang belum terukur tetap belum terukur, berapa pun yang tiba.
  assert.equal(projectedContext(undefined, 0), undefined)
  assert.equal(projectedContext(undefined, 9_999), undefined)
  // Dan itu berarti `overBudget` tetap diam untuknya — akibat yang sebenarnya
  // dijaga, bukan sekadar bentuk nilainya.
  assert.equal(overBudget(projectedContext(undefined, 9_999), 8192, 8192), false)
})

test("margin pertumbuhan menurunkan ambang, dan dijepit seperempat anggaran", () => {
  // Pemicunya membaca angka langkah SEBELUMNYA, jadi tanpa margin ia lolos di
  // ambang−1 lalu langkah berikutnya menempelkan satu hasil tool utuh.
  // Terukur: jendela 8192, ambang 6144, langkah berhenti di 6142, satu baca
  // 6 KB menyusul, konteks berikutnya mendarat 257 token dari bibir jendela.

  // Positif dulu: tanpa margin, 6142 memang LOLOS ambang 6144.
  assert.equal(overBudget(6142, 8192, 8192), false)
  // Baru dengan margin: satu hasil 6 KB (≈1.500 token) menariknya ke bawah.
  assert.equal(overBudget(6142, 8192, 8192, 1_500), true)

  // Jepitannya: margin tidak pernah lebih dari seperempat anggaran, kalau
  // tidak satu hasil raksasa menarik ambang sampai hampir nol dan pemadatan
  // menyala di tiap langkah walau konteksnya masih lapang.
  assert.equal(effectiveGrowth(6144, 999_999), 1536)
  assert.equal(effectiveGrowth(6144, 500), 500)
  // 6144 − 1536 = 4608 adalah ambang terendah yang mungkin pada jendela ini.
  assert.equal(overBudget(4607, 8192, 8192, 999_999), false)
  assert.equal(overBudget(4608, 8192, 8192, 999_999), true)
})

test("prune bisa menjangkau ke DALAM ekor lewat `from`", () => {
  // Upaya terakhir: hasil tool yang lebih besar dari seluruh anggaran tidak
  // bisa ditolong pemotongan mana pun, dan prune aman di sana karena ia tidak
  // pernah MENGHAPUS pesan — tidak ada hasil yang jadi yatim.
  const messages = [user("satu"), toolCall("a"), toolResult("a"), toolCall("b"), toolResult("b")]

  // Positif dulu: rentang bawaan (0..2) memang menyentuh hasil PERTAMA saja.
  const outside = pruneToolOutputs(messages, 3)
  assert.match(JSON.stringify(outside.messages[2]), /output was dropped/)
  assert.doesNotMatch(JSON.stringify(outside.messages[4]), /output was dropped/)

  // Baru ke dalam ekor: `from: 3` melewati hasil pertama dan menyasar yang di
  // dalam ekor.
  const inside = pruneToolOutputs(messages, messages.length, 3)
  assert.ok(inside.bytesFreed > 0)
  assert.match(JSON.stringify(inside.messages[4]), /output was dropped/)
  assert.doesNotMatch(JSON.stringify(inside.messages[2]), /output was dropped/)
})

/** Hasil `task`: jawaban sub-agent, seukuran hasil `read` di fixture lain. */
const taskResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "task",
      output: { type: "text", value: "jawaban sub-agent ".repeat(40) },
    },
  ],
})

test("prune biasa MELEWATI hasil task, dan tetap membuang hasil read di pesan yang sama", () => {
  // Penanda prune menyuruh model menjalankan ulang tool-nya. Untuk `read` itu
  // nasihat yang benar; untuk `task` ia menyuruh mendispatch ulang satu giliran
  // bersarang penuh — model call sendiri, tool call sendiri, mungkin CLI
  // eksternal terdelegasi. Harga memulihkannya yang membedakan keduanya.
  const messages = [
    user("satu"),
    toolCall("a"),
    taskResult("a"),
    toolCall("b"),
    toolResult("b"),
    user("dua"),
  ]

  const { messages: pruned, bytesFreed } = pruneToolOutputs(messages, messages.length)

  // Hasil read dibuang seperti biasa — kalau tidak, test ini akan hijau hanya
  // karena prune berhenti bekerja sama sekali.
  assert.match(JSON.stringify(pruned[4]), /output was dropped/)
  assert.ok(bytesFreed > 0)
  // Hasil task lolos utuh: peringkas yang menanganinya, dan ringkasan itu lossy
  // tapi tidak destruktif.
  assert.deepEqual(pruned[2], messages[2])
  assert.doesNotMatch(JSON.stringify(pruned[2]), /dropped/)
})

test("prune ekor MEMBUANG hasil task, tapi penandanya menyebut harganya", () => {
  // Di ekor, mengecualikan task akan mengembalikan bahaya aslinya: permintaan
  // tetap kebesaran, provider memotong diam-diam, dan model menjawab yakin
  // tentang bahan yang tidak pernah dilihatnya. Kehilangan isi ekor adalah
  // kerugian yang lebih kecil — tapi model harus tahu apa yang baru saja hilang.
  const messages = [user("satu"), toolCall("a"), taskResult("a")]

  const { messages: pruned, bytesFreed } = pruneToolOutputs(messages, messages.length, 0, false)

  assert.ok(bytesFreed > 0)
  const rendered = JSON.stringify(pruned[2])
  assert.match(rendered, /sub-agent/)
  // Penandanya TIDAK boleh berbunyi seperti penanda `read`: "jalankan ulang
  // kalau perlu" tanpa menyebut ongkosnya adalah nasihat yang salah di sini.
  assert.doesNotMatch(rendered, /re-run the tool if you need it/)
})

test("penanda task punya ukurannya sendiri, jadi bytesFreed tetap bersih", () => {
  // Dua penanda dengan panjang berbeda: memakai satu angka untuk keduanya
  // membuat penghematan hasil task dilaporkan lebih besar dari sebenarnya —
  // arah kesalahan yang justru dilarang, karena pemanggil lalu mengira sudah
  // cukup meringan dan melewatkan peringkasan yang dibutuhkan.
  const message = taskResult("a")
  const output = (message.content as { output: unknown }[])[0]?.output
  const removed = Buffer.byteLength(JSON.stringify(output))

  const { messages: pruned, bytesFreed } = pruneToolOutputs([toolCall("a"), message], 2, 0, false)
  const markerSize = Buffer.byteLength(
    JSON.stringify((pruned[1]?.content as { output: unknown }[])[0]?.output),
  )

  assert.ok(markerSize > 97, "penanda task memang lebih panjang dari penanda biasa (97 byte)")
  assert.equal(bytesFreed, removed - markerSize)
})

test("prune ekor dua kali tidak menghemat apa pun untuk kedua kalinya", () => {
  // Idempotensi harus berlaku untuk KEDUA penanda: output yang sudah berisi
  // penanda task ukurannya sama persis dengan penanda itu, jadi menggantinya
  // lagi tidak membebaskan satu byte pun dan tidak boleh dihitung.
  const once = pruneToolOutputs([toolCall("a"), taskResult("a")], 2, 0, false)
  const twice = pruneToolOutputs(once.messages, 2, 0, false)
  assert.equal(twice.bytesFreed, 0)
  assert.deepEqual(twice.messages, once.messages)
})

test("bytesFreed dihitung BERSIH dari penanda, bukan kotor", () => {
  // Perbaikan ini pernah tidak terpatok sama sekali: mengembalikan
  // `bytesFreed += removed` (kotor) meninggalkan seluruh suite hijau.
  // Arahnya yang dilarang — melebih-lebihkan penghematan membuat pemanggil
  // melewatkan peringkasan yang justru dibutuhkan.
  //
  // 97 byte adalah ukuran JSON penanda itu sendiri; angkanya ditulis di sini
  // apa adanya, bukan diimpor, supaya test ini tidak ikut bergeser bersama
  // konstanta yang seharusnya ia jaga.
  const MARKER = 97
  const output = { type: "text", value: "z".repeat(80) }
  const message: ModelMessage = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "a", toolName: "read", output }],
  }
  const removed = Buffer.byteLength(JSON.stringify(output))

  // Positif dulu: outputnya memang SEDIKIT lebih besar dari penanda — di
  // bawahnya prune melewatinya dan test tidak menguji apa pun.
  assert.ok(removed > MARKER, `output ${removed} byte harus lebih besar dari penanda ${MARKER}`)
  assert.ok(removed < MARKER * 2, "sengaja hanya sedikit lebih besar, supaya selisihnya kentara")

  const { bytesFreed } = pruneToolOutputs([toolCall("a"), message], 2)
  assert.equal(bytesFreed, removed - MARKER)
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
