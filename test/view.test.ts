import assert from "node:assert/strict"
import test from "node:test"
import { viewLines } from "../src/tui/view.ts"
import { widthOf } from "../src/tui/markdown.ts"

test("rows meneruskan warna dan redup apa adanya", () => {
  const lines = viewLines(
    { kind: "rows", rows: [{ text: "main" }, { text: "old", dim: true }, { text: "hot", color: "red" }] },
    20,
  )
  assert.deepEqual(lines, [{ text: "main" }, { text: "old", dim: true }, { text: "hot", color: "red" }])
})

test("baris terpilih menang atas redup, bukan digambar keduanya", () => {
  /*
   * Extension bisa menyalakan `selected` dan `dim` bersamaan — mis. branch yang
   * sudah merged tapi sedang disorot kursor. Digambar redup, kursor panel hilang
   * tepat saat dipakai.
   */
  const lines = viewLines({ kind: "rows", rows: [{ text: "merged", dim: true, selected: true }] }, 20)
  assert.deepEqual(lines, [{ text: "merged", bold: true }])
})

test("pairs meratakan kolom nilai", () => {
  const lines = viewLines(
    { kind: "pairs", pairs: [{ key: "branch", value: "main" }, { key: "ahead", value: "2" }] },
    30,
  )
  assert.deepEqual(lines.map((line) => line.text), ["branch main", "ahead  2"])
})

test("perataan pairs memakai lebar tampilan, bukan jumlah karakter", () => {
  // Key berhuruf CJK memakan dua kolom per karakter. Meratakan pada jumlah
  // karakter membuat kolom nilai bergerigi justru pada key yang paling lebar.
  const lines = viewLines(
    { kind: "pairs", pairs: [{ key: "日本", value: "a" }, { key: "abcd", value: "b" }] },
    30,
  )
  const columns = lines.map((line) => widthOf(line.text.slice(0, line.text.lastIndexOf(" "))))
  assert.equal(columns[0], columns[1])
})

test("pairs yang tidak muat satu baris ditumpuk dua baris, bukan dipotong habis", () => {
  // Panel 12 kolom hanya punya 8 di dalam bingkai. Memaksa satu baris membuat
  // nilainya hilang seluruhnya, dan pasangan tanpa nilai tidak memberi tahu apa
  // pun.
  const lines = viewLines({ kind: "pairs", pairs: [{ key: "a-very-long-key", value: "v" }] }, 12)
  assert.deepEqual(lines, [{ text: "a-very-long-key", dim: true }, { text: "v" }])
})

test("text dipecah pada baris baru, bukan diserahkan sebagai satu baris raksasa", () => {
  const lines = viewLines({ kind: "text", text: "satu\ndua\n" }, 20)
  assert.deepEqual(lines.map((line) => line.text), ["satu", "dua", ""])
})

test("markdown dibungkus ke lebar di dalam bingkai, bukan ke lebar panel", () => {
  /*
   * Ini yang benar-benar menentukan apakah panel terbaca. Membungkus ke lebar
   * panel meloloskan empat kolom melewati bingkai, dan Ink membungkusnya lagi —
   * jadi setiap baris jadi dua dan panel tumbuh melewati tinggi yang sudah
   * direservasi.
   */
  const source = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh"
  const lines = viewLines({ kind: "markdown", text: source }, 20)
  for (const line of lines) assert.ok(widthOf(line.text) <= 16, `terlalu lebar: ${line.text}`)
  assert.ok(lines.length > 1)
})

test("penanda markdown tidak ikut terbawa sebagai teks", () => {
  const lines = viewLines({ kind: "markdown", text: "**tebal**" }, 40)
  assert.equal(lines[0]?.text, "tebal")
})

test("view kosong menghasilkan nol baris, bukan satu baris kosong", () => {
  // Nol baris yang membuat `panelBody` menampilkan empty-state-nya. Satu baris
  // kosong membuat panel terlihat punya isi yang tidak bisa dibaca.
  assert.deepEqual(viewLines({ kind: "rows", rows: [] }, 20), [])
  assert.deepEqual(viewLines({ kind: "pairs", pairs: [] }, 20), [])
})
