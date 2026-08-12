import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import type { ModelMessage } from "ai"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-autocompact-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "autocompact.db")
process.env.HOME = path.join(root, "home")

const { autoCompact } = await import("../src/core/auto-compact.ts")
const {
  createSession,
  appendModelMessages,
  listModelRows,
  latestCompaction,
  listModelMessages,
  saveCompaction,
} = await import("../src/core/storage/session.ts")

after(() => fs.rmSync(root, { recursive: true, force: true }))

const CONFIG = { auto: true, reserved: 100, tailTurns: 1, prune: true }

const bigResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "text", value: "x".repeat(20_000) },
    },
  ],
})
/** Hasil tool kecil, tapi tetap lebih besar dari penanda prune (97 byte). */
const smallResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "text", value: `isi ekor ${"y".repeat(200)}` },
    },
  ],
})
const call = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})

function seed(): string {
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "giliran satu" },
    call("a"),
    bigResult("a"),
    { role: "assistant", content: "selesai satu" },
    { role: "user", content: "giliran dua" },
    { role: "assistant", content: "selesai dua" },
  ])
  return session.id
}

test("compaction.auto: false tidak menjalankan apa pun, walau jauh di atas ambang", async () => {
  // Saklarnya tidak terpatok sama sekali sebelumnya: menghapus penjaga
  // `if (!compaction.auto) return IDLE` meninggalkan seluruh suite hijau,
  // padahal "compaction.auto: false berperilaku persis seperti sebelum rencana
  // ini" adalah salah satu syarat kelulusan rencananya sendiri.
  const sessionID = seed()
  const before = listModelRows(sessionID)

  // Positif dulu, di atas DATA YANG SAMA: dengan auto: true, angka-angka ini
  // sungguh memadatkan. Tanpa ini, `ran === false` di bawah bisa saja benar
  // karena fixture-nya memang tidak pernah melewati ambang.
  const proof = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => "RINGKASAN",
  })
  assert.equal(proof.ran, true)
  assert.equal(proof.summarised, true)

  // Baru negatif, di sesi yang baru disemai persis sama.
  const off = seed()
  const offBefore = listModelRows(off)
  const result = await autoCompact({
    sessionID: off,
    compaction: { ...CONFIG, auto: false },
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil saat auto mati")
    },
  })

  assert.equal(result.ran, false)
  assert.equal(result.changed, false)
  assert.deepEqual(listModelRows(off), offBefore)
  assert.equal(latestCompaction(off), undefined)
  assert.deepEqual(before.length, 6)
})

test("hasil tool yang lebih besar dari seluruh anggaran TETAP terpangkas, walau ia ada di ekor", async () => {
  // F1: dengan `midTurnKeep` berbasis jumlah pesan, riwayat sependek ini
  // memberi potong = 0 — prune dilewati (`cut === 0`) dan peringkas tidak
  // menyentuh ekor karena ekor memang dipertahankan apa adanya. Hasilnya satu
  // hasil `read` 22 KB duduk di konteks sepanjang giliran, dan tiap panggilan
  // smallModel sesudahnya membakar kuota tanpa mengubah apa pun. Terukur:
  // konteks memuncak di 19.407 token pada jendela 8192.
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "baca berkas besar" },
    call("a"),
    bigResult("a"), // 20 KB — jauh lebih besar dari seluruh anggaran
  ])

  // Positif dulu: barisnya memang berisi 20 KB itu sebelum apa pun dijalankan.
  const before = listModelRows(session.id)
  assert.equal(before.length, 3)
  assert.match(JSON.stringify(before[2]?.message), /x{1000,}/)

  // Anggaran ekor 500 byte memaksa `midTurnCut` menyisakan satu pesan saja,
  // lalu mundur ke pemanggilnya — potongnya jatuh di 1, dan hasil 20 KB itu
  // berada DI DALAM ekor, tempat yang dulu tidak terjangkau apa pun.
  let summarised = 0
  const result = await autoCompact({
    sessionID: session.id,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    midTurn: { keepMessages: 6, budgetBytes: 500 },
    summarise: async () => {
      summarised += 1
      return "RINGKASAN"
    },
  })

  assert.equal(result.ran, true)
  assert.equal(result.changed, true)
  // Peringkas sungguh dipakai untuk bagian di luar ekor — bukti bahwa
  // pemangkasan ekor di bawah adalah upaya TERAKHIR, bukan pengganti keduanya.
  assert.equal(summarised, 1)

  // Inti klaimnya: isi 20 KB itu sudah tidak ada lagi di baris mana pun.
  const after = listModelRows(session.id)
  assert.equal(after.length, 3, "prune tidak boleh MENGHAPUS pesan — hasil yatim ditolak provider")
  assert.equal(after[2]?.message.role, "tool")
  assert.doesNotMatch(JSON.stringify(after[2]?.message), /x{1000,}/)
  assert.match(JSON.stringify(after[2]?.message), /output was dropped/)
})

test("pemangkasan ekor TIDAK dilakukan kalau prune di luar ekor sudah cukup", async () => {
  // Pasangan negatif test di atas: ekor dipertahankan apa adanya justru supaya
  // model bisa melanjutkan, jadi menyentuhnya ketika tidak perlu akan membuat
  // model membaca ulang berkas tanpa alasan — mahal, dan persis kebalikan dari
  // tujuan fitur ini. Karena itu ia UPAYA TERAKHIR, bukan langkah biasa.
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "baca dua berkas" },
    call("a"),
    bigResult("a"), // 20 KB, DI LUAR ekor — ini yang seharusnya cukup diprune
    call("b"),
    smallResult("b"), // di DALAM ekor, dan cukup besar untuk bisa diprune
  ])

  const result = await autoCompact({
    sessionID: session.id,
    compaction: CONFIG,
    contextWindow: 1000,
    // 3000 memicu (ambang 900), tapi ~20.000 byte yang dibebaskan prune
    // (÷8 = 2500 token) sudah menjatuhkannya ke 500 — di bawah ambang.
    lastStepTokens: 3000,
    midTurn: { keepMessages: 2, budgetBytes: 1_000_000 },
    summarise: async () => {
      throw new Error("prune di luar ekor sudah cukup, peringkas tidak boleh dipanggil")
    },
  })

  assert.equal(result.ran, true)
  assert.equal(result.summarised, false)

  const after = listModelRows(session.id)
  // Positif dulu: prune SUNGGUH jalan pada data ini — tanpa ini, assertion
  // negatif di bawah lolos bahkan kalau prune tidak pernah dipanggil sama
  // sekali.
  assert.match(JSON.stringify(after[2]?.message), /output was dropped/)
  // Baru negatif: hasil di dalam ekor tetap utuh.
  assert.match(JSON.stringify(after[4]?.message), /isi ekor/, "ekor tidak boleh disentuh di sini")
})

test("changed membedakan pemadatan yang menolong dari yang tidak bisa berbuat apa-apa", async () => {
  // `ran` saja tidak cukup: pemanggil mid-turn memakainya untuk memutuskan
  // apakah riwayat perlu disusun ulang, dan pemadatan yang menyala tanpa
  // membebaskan apa pun lalu dilaporkan sebagai keberhasilan — bagian dari
  // alasan kenapa F1 tidak terlihat begitu lama.
  const session = createSession(root)
  // Hanya pesan teks: tidak ada output tool untuk diprune, dan dengan
  // tailTurns: 1 tidak ada apa pun sebelum giliran terakhir untuk diringkas.
  appendModelMessages(session.id, [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" },
  ])

  const result = await autoCompact({
    sessionID: session.id,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => {
      throw new Error("tidak ada yang bisa diringkas di sini")
    },
  })

  // Positif dulu: pemicunya SUNGGUH menyala — kalau tidak, `changed: false`
  // di bawah lolos untuk alasan yang salah.
  assert.equal(result.ran, true)
  assert.equal(result.changed, false)
  assert.equal(result.prunedBytes, 0)
  assert.equal(result.summarised, false)
})

test("di bawah ambang, tidak melakukan apa pun", async () => {
  const sessionID = seed()
  const before = listModelRows(sessionID)

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 32768,
    lastStepTokens: 10,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })

  assert.equal(result.ran, false)
  assert.deepEqual(listModelRows(sessionID), before)
})

test("contextWindow yang tidak dideklarasikan tidak pernah menjalankan apa pun", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: undefined,
    lastStepTokens: 999_999,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })
  assert.equal(result.ran, false)
})

test("prune jalan lebih dulu, dan tersimpan ke baris", async () => {
  const sessionID = seed()

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 950,
    summarise: async () => "RINGKASAN",
  })

  assert.equal(result.ran, true)
  assert.ok(result.prunedBytes > 10_000)

  // Positif dulu: barisnya memang masih ada dan strukturnya utuh.
  const rows = listModelRows(sessionID)
  assert.equal(rows.length, 6)
  assert.equal(rows[2]?.message.role, "tool")
  // Baru negatif: isinya sudah tidak ada.
  assert.doesNotMatch(JSON.stringify(rows[2]?.message), /xxxxx/)

  // Prune sendiri sudah cukup membebaskan konteks di angka test ini — jangan
  // sampai ia naik ke peringkasan juga. Tanpa dua baris ini, test ini lolos
  // sama saja baik prune BERHENTI di sini maupun diam-diam lanjut meringkas
  // (stub-nya mengembalikan "RINGKASAN", tidak melempar) — jadi ia tidak bisa
  // membedakan "prune cukup, berhenti" dari "prune lalu tetap meringkas juga".
  assert.equal(result.summarised, false)
  assert.equal(latestCompaction(sessionID), undefined)
})

test("prune yang tidak cukup naik ke peringkasan", async () => {
  const sessionID = seed()
  let called = 0

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999, // jauh di atas apa pun yang bisa dibebaskan prune
    summarise: async (system, prompt) => {
      called += 1
      assert.match(system, /compress a coding session/)
      assert.match(prompt, /giliran satu/)
      // Positif dulu: isi ASLI hasil tool (20.000 karakter "x", dipotong 400
      // oleh renderMessage) memang ada di transkrip yang dikirim ke peringkas.
      assert.match(prompt, /x{100,}/)
      // Baru negatif: bukan penanda yang tersimpan ke BARIS setelah prune.
      // `planAtCut` harus dijalankan atas `rows` dari SEBELUM prune menimpa
      // database — meringkas dari penanda berarti kehilangan detail yang
      // sama dua kali (sekali oleh prune, sekali oleh peringkas).
      assert.doesNotMatch(prompt, /output was dropped/)
      return "RINGKASAN"
    },
  })

  assert.equal(called, 1)
  assert.equal(result.summarised, true)
  assert.equal(latestCompaction(sessionID)?.summary.includes("RINGKASAN"), true)

  // Giliran terakhir tetap utuh — itu arti tailTurns.
  const visible = listModelMessages(sessionID)
  assert.match(JSON.stringify(visible), /giliran dua/)
})

test("focus diteruskan ke prompt peringkas", async () => {
  const sessionID = seed()
  let seen = ""
  await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    focus: "modul autentikasi",
    summarise: async (_system, prompt) => {
      seen = prompt
      return "RINGKASAN"
    },
  })
  assert.match(seen, /modul autentikasi/)
})

test("prune: false melewatkan prune dan langsung meringkas", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: { ...CONFIG, prune: false },
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => "RINGKASAN",
  })
  assert.equal(result.prunedBytes, 0)
  assert.equal(result.summarised, true)
})

test("ringkasan kosong dari peringkas TIDAK disimpan, riwayat tidak diganti", async () => {
  // `streamText` meneruskan error provider ke `onError`, bukan menolak
  // promise-nya — jadi `synthesizerFor` mengembalikan string kosong, bukan
  // melempar, kalau smallModel-nya sedang down. Sebuah 503 sesaat TIDAK boleh
  // berarti seluruh riwayat lama diganti ringkasan yang membungkus kekosongan.
  const sessionID = seed()

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => "",
  })

  assert.equal(result.summarised, false)
  assert.equal(latestCompaction(sessionID), undefined)
  // Riwayat yang dilihat model tetap enam baris apa adanya — bukan tergantikan
  // pasangan ringkasan yang membungkus kekosongan.
  assert.equal(listModelMessages(sessionID).length, 6)
})

test("baris di belakang batas air tidak pernah ditulis ulang, dan ringkasan lama ikut dilipat", async () => {
  // Menutup dua lubang sekaligus, karena satu skenario membuktikan keduanya:
  //
  // 1. `seq` vs indeks: begitu ada pemadatan sebelumnya, `rows` yang disaring
  //    `autoCompact` punya indeks lokal (0, 1, 2, ...) yang TIDAK LAGI sama
  //    dengan `seq` baris aslinya (yang mulai dari watermark+1). Kalau prune
  //    memakai indeks itu langsung sebagai `seq` ke `replaceModelMessage`, ia
  //    menimpa baris yang SALAH — termasuk baris di belakang batas air yang
  //    seharusnya tidak pernah disentuh lagi.
  // 2. Ringkasan lama: baris sebelum batas air tidak boleh ikut diringkas
  //    ULANG (baru negatif di bawah), tapi ISI ringkasan lamanya harus tetap
  //    dilipat ke sumber ringkasan yang baru (baru positif) — supaya
  //    ringkasan tidak menumpuk tanpa batas maupun kehilangan jejak.
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "purba satu" }, // seq0 — sudah diringkas
    { role: "assistant", content: "balasan purba" }, // seq1 — sudah diringkas (batas air)
    call("a"), // seq2
    bigResult("a"), // seq3 — 20 KB, seharusnya yang diprune
    { role: "assistant", content: "selesai satu" }, // seq4
    { role: "user", content: "giliran dua" }, // seq5
    { role: "assistant", content: "selesai dua" }, // seq6
  ])
  saveCompaction(session.id, 1, "RINGKASAN LAMA")

  // Positif dulu: baris yang diuji sungguh berisi apa yang diharapkan SEBELUM
  // autoCompact dipanggil sama sekali.
  const before = listModelRows(session.id)
  assert.equal(before[1]?.seq, 1)
  assert.equal(String((before[1]?.message as { content: string }).content), "balasan purba")
  assert.equal(before[3]?.seq, 3)
  assert.match(JSON.stringify(before[3]?.message), /x{100,}/)

  let capturedPrompt = ""
  const result = await autoCompact({
    sessionID: session.id,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async (_system, prompt) => {
      capturedPrompt = prompt
      return "RINGKASAN BARU"
    },
  })
  assert.equal(result.summarised, true)

  // Batas air: baris LAMA (seq 1) tidak boleh tersentuh sama sekali — masih
  // pesan assistant apa adanya, bukan tertimpa isi baris lain.
  const after = listModelRows(session.id)
  const stillAtSeq1 = after.find((row) => row.seq === 1)
  assert.equal(stillAtSeq1?.message.role, "assistant")
  assert.equal(String((stillAtSeq1?.message as { content: string }).content), "balasan purba")

  // Baris yang SEHARUSNYA diprune (seq 3, hasil tool 20 KB) memang yang berubah.
  const prunedRow = after.find((row) => row.seq === 3)
  assert.equal(prunedRow?.message.role, "tool")
  assert.doesNotMatch(JSON.stringify(prunedRow?.message), /x{100,}/)

  // Ringkasan lama ikut dilipat ke sumber ringkasan baru, bukan ditumpuk
  // terpisah — dan materi giliran yang BARU (belum diringkas) memang masuk.
  assert.match(capturedPrompt, /RINGKASAN LAMA/)
  assert.match(capturedPrompt, /selesai satu/)
  // Baru negatif: materi yang SUDAH ada di belakang batas air tidak
  // diringkas ulang — kalau ia diikutkan lagi, ringkasan membesar tanpa henti.
  assert.doesNotMatch(capturedPrompt, /purba satu/)
  assert.doesNotMatch(capturedPrompt, /balasan purba/)

  assert.equal(latestCompaction(session.id)?.summary.includes("RINGKASAN BARU"), true)
})
