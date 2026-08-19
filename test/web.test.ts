import assert from "node:assert/strict"
import test from "node:test"
import { WEB_HTML } from "../src/server/web.ts"

/**
 * Klien web, disematkan sebagai string.
 *
 * Titah dipasang lewat npm dan dijalankan sebagai satu biner. Aset yang harus
 * disalin, ditemukan lewat path relatif, lalu disajikan adalah tiga cara baru
 * untuk gagal pada mesin orang lain — dan ketiganya gagal dengan gejala yang
 * sama: halaman kosong tanpa satu pun petunjuk.
 */

test("halaman utuh, bukan potongan", () => {
  assert.match(WEB_HTML, /^<!doctype html>/i)
  assert.match(WEB_HTML, /<\/html>\s*$/)
})

test("memakai API yang memang ada di server", () => {
  /*
   * Klien yang menyebut rute yang tidak ada gagal hanya saat diklik, dan
   * gejalanya sebuah panel yang tidak pernah muncul. Rute-rute ini dipaku di
   * sini supaya penggantian nama di server memerahkan test, bukan mematahkan
   * halaman diam-diam.
   */
  for (const route of [
    "/session",
    "/event?session=",
    "/message",
    "/status",
    "/abort",
    "/permission/",
    "/question/",
  ]) {
    assert.ok(WEB_HTML.includes(route), `rute ${route} hilang dari klien`)
  }
})

test("menangani izin DAN pertanyaan — tanpa keduanya ia cuma pembaca", () => {
  // Di browser tidak ada terminal yang bisa menjawab dialog. Tanpa panel ini,
  // setiap giliran yang butuh izin menggantung sampai timeout.
  assert.match(WEB_HTML, /permission\.request/)
  assert.match(WEB_HTML, /question\.request/)
})

test("stream lama ditutup sebelum yang baru dibuka", () => {
  /*
   * Berpindah sesi tanpa menutupnya meninggalkan EventSource yang masih
   * menggambar ke layar yang sudah menampilkan sesi lain — dua percakapan
   * bercampur, dan tidak ada di layar yang menjelaskan kenapa.
   */
  assert.match(WEB_HTML, /if \(source\) source\.close\(\)/)
})

test("teks dari model DI-ESCAPE sebelum masuk innerHTML", () => {
  /*
   * Jawaban model dan judul tool bisa memuat `<`. Tanpa escape, keluaran tool
   * yang kebetulan berisi HTML akan dirender sebagai HTML — di halaman yang
   * juga memegang kredensial sesi.
   */
  assert.match(WEB_HTML, /const escape = /)
  assert.match(WEB_HTML, /&amp;/)
})

test("tidak memuat apa pun dari luar", () => {
  // Halaman yang menarik font atau skrip dari CDN akan kosong di mesin tanpa
  // internet — yaitu mesin yang justru paling mungkin menjalankan agent lokal.
  assert.doesNotMatch(WEB_HTML, /https?:\/\/(?!127\.0\.0\.1|localhost)/)
})

test("keyboard bisa dipakai — daftar sesi fokusabel, Enter mengirim", () => {
  assert.match(WEB_HTML, /tabIndex = 0/)
  assert.match(WEB_HTML, /focus-visible/)
  assert.match(WEB_HTML, /e\.key === "Enter" && !e\.shiftKey/)
})
