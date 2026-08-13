import assert from "node:assert/strict"
import test from "node:test"
import { parseInline, renderMarkdown } from "../src/tui/markdown.ts"
import { messageLines } from "../src/tui/layout.ts"
import type { Message } from "../src/core/message.ts"

const styles = (text: string) => parseInline(text).map((span) => ({ ...span }))

// ---------- inline ----------

test("tebal, miring, dan kode dikenali sebagai span terpisah", () => {
  const spans = styles("ada **tebal** dan *miring* dan `kode`")

  assert.deepEqual(
    spans.map((span) => span.text),
    ["ada ", "tebal", " dan ", "miring", " dan ", "kode"],
  )
  assert.equal(spans[1]?.bold, true)
  assert.equal(spans[3]?.italic, true)
  assert.equal(spans[5]?.color, "yellow")
})

test("penanda markdown dibuang dari teks polos", () => {
  const [line] = renderMarkdown("**halo** `dunia`")
  assert.equal(line?.text, "halo dunia", "yang dilihat user tanpa bintang dan backtick")
})

test("teks tanpa markup menghasilkan satu span apa adanya", () => {
  const spans = styles("cuma teks biasa")
  assert.equal(spans.length, 1)
  assert.equal(spans[0]?.bold, undefined)
})

test("tautan menampilkan labelnya, bukan URL-nya", () => {
  const spans = styles("lihat [dokumentasi](https://contoh.test/panjang)")
  assert.equal(spans.at(-1)?.text, "dokumentasi")
  assert.equal(spans.at(-1)?.underline, true)
})

test("garis bawah tidak pernah dianggap penekanan", () => {
  // Jawaban coding agent penuh `snake_case_name` dan `__init__`. Menukar
  // dukungan `_italic_` demi identifier yang utuh jelas menguntungkan.
  assert.equal(renderMarkdown("pakai snake_case_name di sini")[0]?.text, "pakai snake_case_name di sini")
  assert.equal(renderMarkdown("panggil __init__ dulu")[0]?.text, "panggil __init__ dulu")
  assert.equal(renderMarkdown("_bukan miring_")[0]?.spans[0]?.italic, undefined)
})

test("bintang tanpa pasangan tidak menelan sisa baris", () => {
  const [line] = renderMarkdown("2 * 3 = 6")
  assert.equal(line?.text, "2 * 3 = 6")
})

// ---------- blok ----------

test("judul ditebalkan; judul level satu jadi huruf besar", () => {
  const lines = renderMarkdown("# judul utama\n## subjudul")
  assert.equal(lines[0]?.text, "JUDUL UTAMA")
  assert.equal(lines[0]?.spans[0]?.bold, true)
  assert.equal(lines[1]?.text, "subjudul")
})

test("daftar berpoin dan bernomor diberi penanda", () => {
  const lines = renderMarkdown("- satu\n* dua\n1. tiga")
  assert.equal(lines[0]?.text, "• satu")
  assert.equal(lines[1]?.text, "• dua")
  assert.equal(lines[2]?.text, "1. tiga")
})

test("daftar bersarang memakai tanda berbeda, supaya kedalamannya terbaca", () => {
  // Indentasi dua spasi mudah hilang di mata; tandanya yang membedakan.
  assert.equal(renderMarkdown("- atas")[0]?.text, "• atas")
  assert.equal(renderMarkdown("  - bersarang")[0]?.text, "  ◦ bersarang")
})

test("kutipan diberi garis tepi dan diredupkan", () => {
  const [line] = renderMarkdown("> ini kutipan")
  assert.equal(line?.text, "│ ini kutipan")
  assert.equal(line?.spans[1]?.dim, true)
})

test("blok kode tidak diurai sebagai markdown", () => {
  const lines = renderMarkdown("```ts\nconst a = b ** 2\n```")

  assert.match(lines[0]?.text ?? "", /^╭─ ts$/)
  assert.equal(lines[1]?.text, "│ const a = b ** 2", "bintang di dalam kode tetap utuh")
  assert.equal(lines[1]?.spans[0]?.bold, undefined)
  assert.equal(lines[2]?.text, "╰─")
})

test("blok kode yang tidak ditutup tetap ditampilkan seluruhnya", () => {
  const lines = renderMarkdown("```\nsatu\ndua")
  assert.equal(lines.length, 4, "pembuka + dua baris + penutup darurat")
  assert.equal(lines[3]?.text, "╰─")
})

test("garis horizontal jadi pemisah", () => {
  const [line] = renderMarkdown("---")
  assert.match(line?.text ?? "", /^─+$/)
})

test("baris kosong dipertahankan sebagai baris kosong", () => {
  const lines = renderMarkdown("satu\n\ndua")
  assert.equal(lines.length, 3)
  assert.equal(lines[1]?.text, "")
})

// ---------- integrasi dengan riwayat ----------

const message = (role: Message["role"], text: string): Message => ({
  id: "m",
  sessionID: "s",
  role,
  created: 1,
  parts: [{ type: "text", text }],
})

test("jawaban asisten dirender sebagai markdown", () => {
  const lines = messageLines(message("assistant", "## Hasil\n- **penting**"), false)

  // Talang kiri ikut di sini: bulatan pada baris pertama bagian, dua spasi
  // pada sisanya. Ia potongan span TERSENDIRI supaya tidak mewarisi tebalnya
  // judul — bulatan yang ikut menebal terbaca sebagai bagian dari judulnya.
  assert.equal(lines[0]?.text, "⏺ Hasil")
  assert.equal(lines[0]?.spans?.[0]?.text, "⏺ ")
  assert.notEqual(lines[0]?.spans?.[0]?.bold, true)
  assert.equal(lines[0]?.spans?.[1]?.bold, true)
  assert.equal(lines[1]?.text, "  • penting")
})

test("prompt user TIDAK dirender sebagai markdown", () => {
  // Yang diketik user bukan markdown; merendernya menyembunyikan karakter yang
  // sengaja ia tulis, misalnya saat bertanya tentang sintaks markdown itu sendiri.
  const lines = messageLines(message("user", "apa arti **ini**?"), false)
  const isi = lines.find((line) => line.kind === "user")

  assert.equal(isi?.text, "  │ apa arti **ini**?")
  assert.equal(isi?.spans, undefined)
})

// ---------- pembungkusan: inti perbaikan render ----------

test("baris panjang DIBUNGKUS ke lebar yang diberikan", () => {
  /*
   * Ini cacat yang paling terlihat sebelum perbaikan: baris tidak pernah
   * dibungkus di sini, Ink membungkusnya sendiri jadi beberapa baris LAYAR,
   * dan `viewport` masih menghitungnya satu. Selisih itu membuat isi meluber
   * lalu terpotong, dan gulirnya meleset sebanyak baris yang terbungkus.
   */
  const lines = renderMarkdown("satu dua tiga empat lima enam tujuh", 12)
  assert.ok(lines.length > 1, "harus jadi beberapa baris")
  for (const line of lines) {
    assert.ok(line.text.length <= 12, `"${line.text}" (${line.text.length}) melewati 12`)
  }
})

test("tanpa lebar, tidak ada pembungkusan sama sekali", () => {
  // Nol berarti "tidak tahu", dan membungkus ke lebar yang dikarang membuat
  // hasilnya bergantung pada angka yang tidak ada artinya.
  const lines = renderMarkdown("satu dua tiga empat lima enam tujuh delapan")
  assert.equal(lines.length, 1)
})

test("sambungan butir daftar sejajar dengan TEKSNYA, bukan dengan bulatnya", () => {
  const lines = renderMarkdown("- kalimat yang cukup panjang untuk terbungkus", 20)
  assert.ok(lines.length > 1)
  assert.match(lines[0]?.text ?? "", /^• /)
  // Indent gantung: dua spasi, selebar "• ".
  assert.match(lines[1]?.text ?? "", /^ {2}\S/)
})

test("kata tunggal yang lebih panjang dari layar dipotong keras, bukan hilang", () => {
  // Path panjang dan URL adalah kasus normal, bukan kasus tepi.
  const long = "a".repeat(50)
  const lines = renderMarkdown(long, 20)
  assert.ok(lines.length >= 3)
  assert.equal(lines.map((line) => line.text).join(""), long, "tidak ada karakter yang hilang")
})

test("kode dipotong keras, TIDAK dibungkus di batas kata", () => {
  // Membungkus kode pada spasi mengubah indentasinya, dan indentasi adalah
  // bagian dari arti kode.
  const lines = renderMarkdown("```\n" + "x".repeat(60) + "\n```", 20)
  const body = lines[1]?.text ?? ""
  assert.ok(body.startsWith("│ "), "punya gutter")
  assert.ok(body.length <= 20)
  assert.ok(body.endsWith("…"), "dipotong dan terlihat terpotong")
})

// ---------- tabel ----------

test("tabel markdown jadi kolom yang rata", () => {
  const lines = renderMarkdown(
    ["| Nama | Nilai |", "|---|---|", "| a | 1 |", "| panjang sekali | 2 |"].join("\n"),
    80,
  )
  // Kepala, pemisah, dua baris isi.
  assert.equal(lines.length, 4)
  assert.match(lines[0]?.text ?? "", /Nama/)
  assert.match(lines[1]?.text ?? "", /^├─/)
  // Kolom pertama dipadatkan ke lebar yang sama, jadi pipa kedua sejajar.
  const pipeOf = (text: string) => text.indexOf("│", 2)
  assert.equal(pipeOf(lines[2]?.text ?? ""), pipeOf(lines[3]?.text ?? ""))
})

test("kepala tabel ditebalkan, isinya tetap diurai sebagai markdown", () => {
  const lines = renderMarkdown(["| a | b |", "|---|---|", "| `kode` | x |"].join("\n"), 80)
  assert.equal(lines[0]?.spans[1]?.bold, true)
  assert.ok(
    lines[2]?.spans.some((span) => span.color === "yellow"),
    "backtick di dalam sel tetap jadi kode",
  )
})

test("judul tingkat 1, 2, dan 3 dibedakan", () => {
  // Judul yang semuanya sama menghapus satu-satunya hal yang disampaikan
  // judul: struktur.
  assert.equal(renderMarkdown("# satu")[0]?.text, "SATU")
  assert.equal(renderMarkdown("## dua")[0]?.text, "dua")
  assert.equal(renderMarkdown("## dua")[0]?.spans[0]?.color, "green")
  assert.equal(renderMarkdown("### tiga")[0]?.spans[0]?.color, "cyan")
})
