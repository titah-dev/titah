import assert from "node:assert/strict"
import test from "node:test"
import { EXTENSION_API, satisfiesEngine } from "../src/extension.ts"

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
  assert.equal(satisfiesEngine("0.3.0", "0.3.x"), false)
  assert.equal(satisfiesEngine("0.3.0", "latest"), false)
  /*
   * Bagian cacat diperlakukan BERBEDA tergantung posisinya, dan itu disengaja
   * karena keduanya aman ke arah yang sama.
   *
   * Di dalam konjungsi ia menjatuhkan kelompoknya: `>=0.3.0 <BOGUS` yang
   * diloloskan berarti batas atas yang sengaja ditulis penulisnya hilang tanpa
   * jejak — persis bug yang dulu ditemukan test, bukan mata.
   *
   * Sesudah `||` ia cukup diabaikan: `||` hanya bisa MELEBARKAN, jadi
   * mengabaikan satu alternatif tidak pernah melebarkan apa pun. Yang tersisa
   * tetap harus cocok atas kekuatannya sendiri — baris terakhir yang menahannya.
   */
  assert.equal(satisfiesEngine("0.3.0", ">=0.3.0 <BOGUS"), false)
  assert.equal(satisfiesEngine("0.3.0", "^0.3.0 || sembarang"), true)
  assert.equal(satisfiesEngine("0.9.0", "^0.3.0 || sembarang"), false)
  assert.equal(satisfiesEngine("0.3.0", " || "), false, "tidak ada satu pun bagian yang sah")
})

test("konjungsi berspasi menutup rentang di kedua ujung", () => {
  /*
   * Ini yang dulu tidak ada, dan ketiadaannya nyata: satu-satunya bentuk lebar
   * adalah `>=0.4.0`, yang tanpa batas atas sama sekali. Penulis extension jadi
   * harus memilih antara terlalu sempit dan tidak berbatas.
   */
  assert.equal(satisfiesEngine("0.6.1", ">=0.4.0 <1.0.0"), true)
  assert.equal(satisfiesEngine("0.3.0", ">=0.4.0 <1.0.0"), false, "di bawah batas bawah")
  assert.equal(satisfiesEngine("1.0.0", ">=0.4.0 <1.0.0"), false, "batas atas eksklusif")
  assert.equal(satisfiesEngine("1.0.0", ">=0.4.0 <=1.0.0"), true)
  assert.equal(satisfiesEngine("0.4.0", ">0.4.0"), false)
})

test("|| menerima kalau SALAH SATU alternatifnya cocok", () => {
  const range = "^0.4.0 || ^0.5.0 || ^0.6.0"
  for (const version of ["0.4.9", "0.5.0", "0.6.1"]) {
    assert.equal(satisfiesEngine(version, range), true, version)
  }
  assert.equal(satisfiesEngine("0.7.0", range), false)
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


test("EXTENSION_API masih menerima extension yang menargetkan 0.4.0", () => {
  /*
   * Pin yang paling penting di berkas ini.
   *
   * Setiap extension yang sudah terbit menyatakan `^0.4.0`. Hari seseorang
   * menaikkan `EXTENSION_API` melewati 0.4.x, test ini gagal — dan itulah
   * gunanya: menaikkannya MEMATIKAN semuanya sampai masing-masing diterbitkan
   * ulang, jadi keputusan itu tidak boleh terjadi tanpa disengaja.
   *
   * Kalau kamu memang bermaksud memutus kontraknya, ganti angka di bawah dan
   * tulis alasannya di CHANGELOG.
   */
  assert.equal(satisfiesEngine(EXTENSION_API, "^0.4.0"), true)
})
