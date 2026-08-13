import assert from "node:assert/strict"
import test from "node:test"
import { fit, fitsWideHeader, headerLines, tilde } from "../src/tui/header.ts"
import { widthOf } from "../src/tui/markdown.ts"
import { markLines } from "../src/tui/logo.ts"

const LOGO = markLines()

const header = (columns: number, extra: Record<string, unknown> = {}) =>
  headerLines({
    columns,
    logo: LOGO,
    cwd: "/Users/seseorang/kerja/proyek",
    model: "9router/ant",
    agent: "plan",
    session: "new session",
    account: "akil",
    ...extra,
  })

test("setiap baris tepat selebar terminal — tidak kurang, tidak lebih", () => {
  /*
   * Satu kolom kelebihan membuat terminal membungkus baris itu, dan header
   * setinggi sepuluh mendadak memakan sebelas baris — sementara `historyRows`
   * masih mengira sepuluh. Selisih itu memotong baris teratas riwayat tanpa
   * satu pun tanda. Satu kolom kekurangan lebih jinak, tapi tepi kanannya
   * bergerigi dan itu langsung terlihat pada gambar bergaris.
   */
  for (const columns of [66, 72, 80, 100, 120, 200]) {
    for (const line of header(columns)) {
      assert.equal(widthOf(line.text), columns, `lebar ${columns}: "${line.text}"`)
    }
  }
})

test("teks dan span selalu menggambarkan baris yang sama", () => {
  // `text` dipakai test dan pengukuran; `spans` yang benar-benar digambar.
  // Begitu keduanya berbeda, yang diuji bukan lagi yang dilihat user.
  for (const line of header(100)) {
    assert.equal(line.spans.map((span) => span.text).join(""), line.text)
  }
})

test("tingginya tetap, apa pun isinya", () => {
  /*
   * Angka ini yang ditanyakan `historyRows`. Ia tidak boleh bergantung pada
   * panjang nama sesi, path, atau nama akun — kalau bergantung, tinggi header
   * berubah di tengah sesi dan riwayat ikut bergeser tanpa sebab yang terlihat.
   */
  const tinggi = header(100).length
  assert.equal(tinggi, 10)

  assert.equal(header(100, { session: "x".repeat(400) }).length, tinggi)
  assert.equal(header(100, { cwd: `/${"panjang/".repeat(50)}` }).length, tinggi)
  assert.equal(header(100, { account: undefined }).length, tinggi)
  assert.equal(header(100, { agent: undefined }).length, tinggi)
})

test("sambungan garis digambar, bukan dibiarkan hampir bersambung", () => {
  const lines = header(100).map((line) => line.text)

  assert.equal((lines[0]?.match(/┬/g) ?? []).length, 2, "tiga kolom di baris atas")
  assert.ok(lines[3]?.includes("├") && lines[3]?.includes("┤"), "kotak Tips ditutup")
  assert.ok(lines[6]?.includes("┴"), "kolom tengah dan kanan menyatu di bawah")
  assert.equal((lines[9]?.match(/┴/g) ?? []).length, 1, "dua kolom di baris bawah")
})

test("isi yang diminta memang ada di tempatnya", () => {
  const lines = header(120).map((line) => line.text)

  assert.match(lines[1] ?? "", /Welcome, akil/)
  assert.match(lines[1] ?? "", /Tips for getting started/)
  assert.match(lines[2] ?? "", /titah/)
  assert.match(lines[4] ?? "", /new session/)
  assert.match(lines[4] ?? "", /What's New/)
  assert.match(lines[7] ?? "", /~?\/?.*proyek/)
  assert.match(lines[8] ?? "", /plan · 9router\/ant/)
})

test("tips dan kabar baru TIDAK berubah antar render", () => {
  /*
   * Layar ini digambar ulang puluhan kali per giliran. Butir yang dipilih acak
   * per render bukan tips — ia kedipan. Kuncinya diambil dari sesi: tetap di
   * dalam satu sesi, berbeda antar sesi.
   */
  const sekali = header(120, { session: "sesi-a" }).map((line) => line.text)
  const lagi = header(120, { session: "sesi-a" }).map((line) => line.text)
  assert.deepEqual(lagi, sekali)

  const lain = header(120, { session: "sesi-b" }).map((line) => line.text)
  assert.notDeepEqual(lain, sekali, "sesi berbeda tidak wajib sama")
})

test("header lebar menyerah di terminal sempit, bukan memaksakan diri", () => {
  /*
   * Tiga kolom di layar sempit menyisakan kolom selebar beberapa karakter —
   * semua isinya jadi elipsis, dan yang tersisa hanya gambar garis. Di situ
   * pemanggilnya memakai header ringkas.
   */
  assert.equal(fitsWideHeader(60, LOGO), false)
  assert.equal(fitsWideHeader(65, LOGO), false, "tepat di bawah ambang")
  assert.equal(fitsWideHeader(66, LOGO), true, "tepat di ambang")
  assert.equal(fitsWideHeader(120, LOGO), true)
})

test("nama sesi ber-emoji tidak merusak lebar kolom", () => {
  // Emoji dua kolom yang dihitung satu adalah cara paling umum tabel jadi
  // miring, dan header ini digambar dengan aturan lebar yang sama.
  for (const line of header(100, { session: "✅ rilis 🎉 besar", account: "日本語" })) {
    assert.equal(widthOf(line.text), 100)
  }
})

test("fit memotong ke lebar TAMPILAN dan menandai potongannya", () => {
  assert.equal(fit("halo", 10), "halo", "yang muat tidak disentuh")
  assert.equal(widthOf(fit("halo dunia panjang", 8)), 8)
  assert.ok(fit("halo dunia panjang", 8).endsWith("…"))
  assert.equal(fit("apa pun", 0), "")
  assert.ok(widthOf(fit("✅✅✅✅✅", 5)) <= 5, "emoji tidak melewati batas")
})

test("tilde memendekkan home, dan hanya home", () => {
  const home = process.env["HOME"] ?? ""
  assert.equal(tilde(`${home}/kerja`), "~/kerja")
  assert.equal(tilde("/etc/hosts"), "/etc/hosts")
  assert.equal(tilde(`${home}xyz/kerja`), `${home}xyz/kerja`, "awalan mirip bukan home")
})
