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
