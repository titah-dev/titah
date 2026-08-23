import assert from "node:assert/strict"
import test from "node:test"
import { satisfiesEngine } from "../src/extension.ts"

test("caret di bawah 1.0.0 mengunci minor, seperti npm", () => {
  /*
   * Ini aturan npm, dan menyimpang darinya adalah cara extension pecah pada
   * rilis yang penulisnya yakin sudah ia batasi: `^0.3.1` di npm TIDAK
   * menerima 0.4.0, karena di bawah 1.0.0 minor berperan sebagai major.
   */
  assert.equal(satisfiesEngine("0.3.1", "^0.3.0"), true)
  assert.equal(satisfiesEngine("0.3.9", "^0.3.0"), true)
  assert.equal(satisfiesEngine("0.4.0", "^0.3.0"), false)
  assert.equal(satisfiesEngine("0.2.9", "^0.3.0"), false)
})

test("caret di atas 1.0.0 mengunci major", () => {
  assert.equal(satisfiesEngine("1.9.9", "^1.2.3"), true)
  assert.equal(satisfiesEngine("1.2.2", "^1.2.3"), false)
  assert.equal(satisfiesEngine("2.0.0", "^1.2.3"), false)
})

test("caret pada 0.0.x mengunci patch", () => {
  assert.equal(satisfiesEngine("0.0.5", "^0.0.5"), true)
  assert.equal(satisfiesEngine("0.0.6", "^0.0.5"), false)
})

test("tilde mengunci minor apa pun major-nya", () => {
  assert.equal(satisfiesEngine("1.2.9", "~1.2.3"), true)
  assert.equal(satisfiesEngine("1.3.0", "~1.2.3"), false)
})

test("versi persis hanya cocok dengan dirinya", () => {
  assert.equal(satisfiesEngine("0.3.0", "0.3.0"), true)
  assert.equal(satisfiesEngine("0.3.1", "0.3.0"), false)
})

test(">= menerima apa pun di atasnya", () => {
  assert.equal(satisfiesEngine("2.0.0", ">=0.3.0"), true)
  assert.equal(satisfiesEngine("0.2.9", ">=0.3.0"), false)
})

test("bintang dan rentang kosong menerima apa pun", () => {
  assert.equal(satisfiesEngine("0.1.0", "*"), true)
  assert.equal(satisfiesEngine("0.1.0", ""), true)
})

test("rentang yang tidak dikenali DITOLAK, bukan diloloskan", () => {
  /*
   * Memuat extension karena rentangnya tidak terbaca adalah kebalikan dari
   * gunanya pemeriksaan ini. Yang benar adalah gagal dengan kalimat yang
   * menyebut sebabnya, dan itu menuntut jawaban `false` di sini.
   */
  assert.equal(satisfiesEngine("0.3.0", ">=0.1.0 <0.4.0"), false)
  assert.equal(satisfiesEngine("0.3.0", "0.3.x"), false)
  assert.equal(satisfiesEngine("0.3.0", "latest"), false)
})

test("prerelease diperlakukan sama dengan rilisnya", () => {
  // Extension tidak pernah menargetkan 0.3.0-rc.1 secara berbeda dari 0.3.0,
  // dan memperlakukannya berbeda hanya membuat rilis kandidat menolak semuanya.
  assert.equal(satisfiesEngine("0.3.0-rc.1", "^0.3.0"), true)
  assert.equal(satisfiesEngine("v0.3.0", "^0.3.0"), true)
})

test("versi Titah yang tidak masuk akal tidak meloloskan apa pun", () => {
  assert.equal(satisfiesEngine("", "^0.3.0"), false)
  assert.equal(satisfiesEngine("unknown", "^0.3.0"), false)
})
