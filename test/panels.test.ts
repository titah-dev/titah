import assert from "node:assert/strict"
import test from "node:test"
import {
  droppedNotice,
  panelBody,
  panelHit,
  plain,
  resizePanel,
  type PanelLine,
  panelLayout,
  PANEL_CHROME_COLUMNS,
  PANEL_EMPTY,
  PANEL_FLOOR,
  PANEL_WIDTH,
} from "../src/tui/panels.ts"
import { widthOf as displayWidth } from "../src/tui/markdown.ts"

/** Test di bawah menguji geometri, bukan gaya — jadi gayanya dibuang di sini. */
const texts = (lines: PanelLine[]): string[] => lines.map((entry) => entry.text)

test("kedua panel terbuka pada 80 kolom dengan lebar bawaan", () => {
  // Kasus yang menentukan bawaannya: 20 + 20 + 40 = 80, dan 40 PERSIS lantainya.
  // Kalau perbandingannya pernah berubah jadi `<=`, kasus inilah yang jatuh.
  const layout = panelLayout({ columns: 80, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: PANEL_WIDTH })
  assert.deepEqual(layout, { left: 20, right: 20, content: 40, dropped: [] })
})

test("panel kanan yang ditutup lebih dulu saat kolom tengah menembus lantai", () => {
  const layout = panelLayout({ columns: 79, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: PANEL_WIDTH })
  assert.deepEqual(layout, { left: 20, right: 0, content: 59, dropped: ["right"] })
})

test("panel kiri menyusul ditutup kalau menutup yang kanan belum cukup", () => {
  const layout = panelLayout({ columns: 50, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: PANEL_WIDTH })
  assert.deepEqual(layout, { left: 0, right: 0, content: 50, dropped: ["right", "left"] })
})

test("panel yang tidak diminta terbuka tidak pernah masuk daftar dropped", () => {
  // Terminal 30 kolom, tidak ada panel yang diminta: kolom tengah di bawah
  // lantai, dan itu tidak apa-apa. Lantai hanya bisa menutup panel, jadi
  // melaporkan "dropped" di sini akan menuduh user menutup sesuatu yang tidak
  // pernah ia buka.
  const layout = panelLayout({ columns: 30, floor: PANEL_FLOOR, left: 0, right: 0 })
  assert.deepEqual(layout, { left: 0, right: 0, content: 30, dropped: [] })
})

test("satu panel terbuka mendapat lebarnya penuh selama kolom tengah masih di atas lantai", () => {
  const layout = panelLayout({ columns: 60, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: 0 })
  assert.deepEqual(layout, { left: 20, right: 0, content: 40, dropped: [] })
})

test("lebar panel dipangkas ke lebar terminal, bukan menghasilkan kolom tengah negatif", () => {
  // Config bisa menuliskan lebar yang lebih besar dari terminalnya. Kolom
  // tengah negatif akan diteruskan ke pembungkus baris riwayat, dan di sana ia
  // berubah jadi pembagian yang tidak pernah berhenti.
  const layout = panelLayout({ columns: 24, floor: 0, left: 400, right: 0 })
  assert.deepEqual(layout, { left: 24, right: 0, content: 0, dropped: [] })
})

test("terminal lebar memberi seluruh sisa ke kolom tengah, bukan melebarkan panel", () => {
  // Kolom tetap adalah keputusan yang disengaja: nama branch dan nama berkas
  // tidak ikut melebar bersama terminal, jadi persentase membuang ruang.
  const layout = panelLayout({ columns: 200, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: PANEL_WIDTH })
  assert.deepEqual(layout, { left: 20, right: 20, content: 160, dropped: [] })
})

test("lebar pecahan dan nilai tak masuk akal tidak menghasilkan kolom pecahan", () => {
  // Ink menerima angka pecahan tanpa mengeluh lalu membulatkannya sendiri, jadi
  // reservasi dan gambar akan berbeda sepersekian kolom tanpa satu pun error.
  const layout = panelLayout({ columns: 100.7, floor: PANEL_FLOOR, left: 20.9, right: Number.NaN })
  assert.deepEqual(layout, { left: 20, right: 0, content: 80, dropped: [] })
})

test("notice menyebut sisi yang benar, dan tidak muncul kalau tidak ada yang ditutup", () => {
  assert.equal(droppedNotice([], PANEL_FLOOR), undefined)
  assert.equal(droppedNotice(["right"], PANEL_FLOOR), "Right panel hidden — history needs 40 columns")
  assert.equal(droppedNotice(["left"], PANEL_FLOOR), "Left panel hidden — history needs 40 columns")
  assert.equal(droppedNotice(["right", "left"], PANEL_FLOOR), "Side panels hidden — history needs 40 columns")
})

test("lebar yang direservasi sama dengan lebar yang digambar", () => {
  /*
   * Pin untuk kelas bug yang berulang di repo ini: yang diukur bukan yang
   * dikirim. Satu-satunya perlindungannya adalah bahwa ketiga angka datang dari
   * SATU pemanggilan, jadi test ini memeriksa jumlahnya di seluruh rentang
   * lebar terminal yang masuk akal — bukan pada satu lebar yang dipilih tangan.
   */
  for (let columns = 1; columns <= 240; columns++) {
    const layout = panelLayout({ columns, floor: PANEL_FLOOR, left: PANEL_WIDTH, right: PANEL_WIDTH })
    assert.equal(
      layout.left + layout.right + layout.content,
      columns,
      `kolom hilang atau tercipta pada ${columns} kolom`,
    )
    assert.ok(layout.content >= 0, `kolom tengah negatif pada ${columns} kolom`)
    if (layout.dropped.length === 0 && columns >= PANEL_FLOOR) {
      assert.ok(layout.content >= PANEL_FLOOR, `lantai dilanggar tanpa laporan pada ${columns} kolom`)
    }
  }
})

test("isi panel dipotong ke lebar dalam bingkai, bukan ke lebar panel", () => {
  // Panel 20 kolom hanya punya 16 untuk teks: dua kolom bingkai, dua padding.
  // Memotong ke 20 membuat Ink membungkusnya dan panel tumbuh melewati tinggi
  // yang sudah direservasi.
  const body = texts(panelBody([plain("x".repeat(40))], 20, 10))
  assert.equal(body.length, 1)
  assert.equal(body[0]?.length, 16)
  assert.ok(body[0]?.endsWith("…"))
})

test("baris yang persis muat tidak diberi elipsis", () => {
  assert.deepEqual(texts(panelBody([plain("x".repeat(16))], 20, 10)), ["x".repeat(16)])
})

test("isi panel di-window ke tinggi dikurangi bingkai dan judul", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `row ${index}`)
  const body = texts(panelBody(lines.map(plain), 20, 8))
  assert.equal(body.length, 5)
  assert.equal(body[0], "row 0")
  assert.equal(body[4], "row 4")
})

test("sisi tanpa extension menunjukkan keadaannya, bukan kotak kosong", () => {
  assert.deepEqual(texts(panelBody([], PANEL_WIDTH, 10)), [PANEL_EMPTY])
})

test("empty-state muat utuh di lebar panel bawaan", () => {
  // Ditemukan oleh test di atas, bukan oleh mata: kalimat pertama yang dipakai
  // di sini 26 karakter, dan pada panel 20 kolom ia jadi "No extension fo…" —
  // pesan yang berhenti menjelaskan tepat di kata yang menjelaskan.
  assert.ok(PANEL_EMPTY.length <= PANEL_WIDTH - PANEL_CHROME_COLUMNS)
  assert.deepEqual(texts(panelBody([], PANEL_WIDTH, 10)), [PANEL_EMPTY])
})

test("panel yang lebih sempit dari bingkainya tidak menghasilkan lebar negatif", () => {
  // `panelLayout` bisa memangkas lebar ke lebar terminal, jadi lebar 2 bukan
  // hal yang mustahil sampai di sini.
  assert.deepEqual(texts(panelBody([plain("abc")], 2, 10)), [""])
  assert.deepEqual(texts(panelBody([plain("abc")], 0, 10)), [""])
})

test("panel yang lebih pendek dari bingkainya tidak menggambar satu baris pun", () => {
  assert.deepEqual(texts(panelBody([plain("abc")], 20, 3)), [])
  assert.deepEqual(texts(panelBody([plain("abc")], 20, 0)), [])
})

test("pemotongan memakai lebar tampilan, bukan jumlah karakter", () => {
  /*
   * Satu karakter CJK memakan dua kolom. Memotong pada jumlah karakter
   * meloloskan 16 karakter = 32 kolom melewati bingkai 16 kolom, dan Ink
   * membungkusnya ke baris berikutnya — panel tumbuh melewati tinggi yang
   * sudah direservasi, tanpa error.
   */
  const body = texts(panelBody([plain("日本語".repeat(10))], PANEL_WIDTH, 10))
  assert.equal(body.length, 1)
  const line = body[0] ?? ""
  assert.ok(line.endsWith("…"))
  // 7 karakter CJK = 14 kolom, plus elipsis = 15; karakter kedelapan tidak muat
  // di 16 karena ia butuh dua kolom.
  assert.equal(displayWidth(line), 15)
})

test("emoji tidak melewati bingkai", () => {
  const body = texts(panelBody([plain("🚀".repeat(20))], PANEL_WIDTH, 10))
  assert.ok(displayWidth(body[0] ?? "") <= PANEL_WIDTH - PANEL_CHROME_COLUMNS)
})

test("resize bergerak per langkah dan berhenti di lebar minimum", () => {
  const base = { columns: 120, other: 0, floor: PANEL_FLOOR }
  assert.equal(resizePanel({ ...base, current: 20, delta: 2 }), 22)
  assert.equal(resizePanel({ ...base, current: 20, delta: -2 }), 18)
  assert.equal(resizePanel({ ...base, current: 8, delta: -2 }), 8)
  assert.equal(resizePanel({ ...base, current: 9, delta: -2 }), 8)
})

test("pelebaran TIDAK BISA menembus lantai", () => {
  /*
   * Tanpa batas ini, menekan `+` sekali lagi membuat panel yang sedang
   * dilebarkan menutup sendiri — lantai bekerja seperti seharusnya, tapi dari
   * tempat user itu terbaca sebagai panel yang hilang karena dilebarkan.
   */
  // 80 kolom, lantai 40, panel seberang tertutup → langit-langitnya 40.
  const base = { columns: 80, other: 0, floor: PANEL_FLOOR }
  assert.equal(resizePanel({ ...base, current: 38, delta: 2 }), 40)
  assert.equal(resizePanel({ ...base, current: 40, delta: 2 }), 40)
})

test("panel seberang yang TERGAMBAR ikut mengurangi langit-langit", () => {
  // Melebarkan kiri saat kanan terbuka tidak boleh memakan ruang kanan.
  assert.equal(resizePanel({ current: 20, delta: 20, columns: 100, other: 20, floor: PANEL_FLOOR }), 40)
  // Dan saat kanan tertutup, ruangnya boleh dipakai.
  assert.equal(resizePanel({ current: 20, delta: 20, columns: 100, other: 0, floor: PANEL_FLOOR }), 40)
  assert.equal(resizePanel({ current: 20, delta: 60, columns: 100, other: 0, floor: PANEL_FLOOR }), 60)
})

test("terminal yang lebih sempit dari lantainya tetap memberi lebar minimum", () => {
  // Bukan nol dan bukan negatif: yang menutup panel adalah panelLayout, bukan
  // resize, dan lebar negatif diteruskan ke pembungkus baris.
  assert.equal(resizePanel({ current: 20, delta: 2, columns: 30, other: 0, floor: PANEL_FLOOR }), 8)
})

const GEOMETRY = {
  contentTop: 6,
  left: { from: 1, to: 20, rows: 5 },
  right: { from: 81, to: 100, rows: 5 },
}

test("klik dipetakan ke sisi dan indeks baris yang benar", () => {
  // contentTop 6 (0-basis) berarti baris isi pertama ada di baris layar 7
  // (1-basis). Pergeseran satu di sini membuat SETIAP klik memilih tetangganya.
  assert.deepEqual(panelHit(GEOMETRY, 5, 7), { side: "left", row: 0 })
  assert.deepEqual(panelHit(GEOMETRY, 5, 8), { side: "left", row: 1 })
  assert.deepEqual(panelHit(GEOMETRY, 5, 11), { side: "left", row: 4 })
  assert.deepEqual(panelHit(GEOMETRY, 90, 9), { side: "right", row: 2 })
})

test("batas kolom panel eksklusif di kedua ujung yang benar", () => {
  assert.deepEqual(panelHit(GEOMETRY, 1, 7), { side: "left", row: 0 })
  assert.deepEqual(panelHit(GEOMETRY, 20, 7), { side: "left", row: 0 })
  assert.equal(panelHit(GEOMETRY, 21, 7), undefined)
  assert.equal(panelHit(GEOMETRY, 80, 7), undefined)
  assert.deepEqual(panelHit(GEOMETRY, 81, 7), { side: "right", row: 0 })
  assert.deepEqual(panelHit(GEOMETRY, 100, 7), { side: "right", row: 0 })
  assert.equal(panelHit(GEOMETRY, 101, 7), undefined)
})

test("klik pada bingkai dan judul panel tidak mengenai baris apa pun", () => {
  // Bingkai atas dan judul ada di kolom panel juga. Meneruskannya ke pencocokan
  // riwayat akan membuka blok tool yang kebetulan sebaris dengan judul panel.
  assert.equal(panelHit(GEOMETRY, 5, 5), undefined)
  assert.equal(panelHit(GEOMETRY, 5, 6), undefined)
  assert.equal(panelHit(GEOMETRY, 5, 12), undefined)
  assert.equal(panelHit(GEOMETRY, 5, 99), undefined)
})

test("sisi yang tidak tergambar tidak pernah kena klik", () => {
  const onlyLeft = { contentTop: 6, left: { from: 1, to: 20, rows: 5 } }
  assert.equal(panelHit(onlyLeft, 90, 7), undefined)
  assert.equal(panelHit({ contentTop: 6 }, 5, 7), undefined)
})

test("panel tanpa baris isi tidak bisa diklik", () => {
  // Terjadi saat tinggi panel lebih kecil dari bingkai + judulnya.
  assert.equal(panelHit({ contentTop: 6, left: { from: 1, to: 20, rows: 0 } }, 5, 7), undefined)
})
