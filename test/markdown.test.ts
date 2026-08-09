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

test("daftar bersarang mempertahankan indentasinya", () => {
  const [line] = renderMarkdown("  - bersarang")
  assert.equal(line?.text, "  • bersarang")
})

test("kutipan diberi garis tepi dan diredupkan", () => {
  const [line] = renderMarkdown("> ini kutipan")
  assert.equal(line?.text, "│ ini kutipan")
  assert.equal(line?.spans[1]?.dim, true)
})

test("blok kode tidak diurai sebagai markdown", () => {
  const lines = renderMarkdown("```ts\nconst a = b ** 2\n```")

  assert.match(lines[0]?.text ?? "", /^┌ ts$/)
  assert.equal(lines[1]?.text, "  const a = b ** 2", "bintang di dalam kode tetap utuh")
  assert.equal(lines[1]?.spans[0]?.bold, undefined)
  assert.equal(lines[2]?.text, "└")
})

test("blok kode yang tidak ditutup tetap ditampilkan seluruhnya", () => {
  const lines = renderMarkdown("```\nsatu\ndua")
  assert.equal(lines.length, 4, "pembuka + dua baris + penutup darurat")
  assert.equal(lines[3]?.text, "└")
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

  assert.equal(lines[0]?.text, "Hasil")
  assert.equal(lines[0]?.spans?.[0]?.bold, true)
  assert.equal(lines[1]?.text, "• penting")
})

test("prompt user TIDAK dirender sebagai markdown", () => {
  // Yang diketik user bukan markdown; merendernya menyembunyikan karakter yang
  // sengaja ia tulis, misalnya saat bertanya tentang sintaks markdown itu sendiri.
  const lines = messageLines(message("user", "apa arti **ini**?"), false)
  const isi = lines.find((line) => line.kind === "user")

  assert.equal(isi?.text, "│ apa arti **ini**?")
  assert.equal(isi?.spans, undefined)
})
