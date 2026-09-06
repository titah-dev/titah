import assert from "node:assert/strict"
import test from "node:test"
import {
  droppedNotice,
  foldedNotice,
  panelBody,
  panelFailed,
  panelHit,
  plain,
  resizePanel,
  type PanelLine,
  panelLayout,
  PANEL_CHROME_COLUMNS,
  PANEL_CHROME_ROWS,
  PANEL_EMPTY,
  PANEL_BOX_FLOOR,
  PANEL_COLLAPSED_ROWS,
  PANEL_FLOOR,
  PANEL_WIDTH,
  stackGeometry,
  stackLayout,
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

test("kalimat 'ada tapi ditolak' muat utuh di lebar panel bawaan", () => {
  /*
   * Batas yang sama dengan `PANEL_EMPTY`, dan alasannya sama: kalimat yang
   * terpotong di tengah berhenti menjelaskan tepat di kata yang menjelaskan.
   * Dua digit sengaja diuji juga — jumlahnya ikut memakan kolom.
   */
  for (const count of [1, 2, 12]) {
    assert.ok(
      displayWidth(panelFailed(count)) <= PANEL_WIDTH - PANEL_CHROME_COLUMNS,
      `panelFailed(${count}) terpotong di panel bawaan`,
    )
  }
})

test("sisi yang extension-nya DITOLAK tidak berbunyi 'tidak ada extension'", () => {
  // Bedanya menentukan ke mana orang mencari: yang satu menyuruhnya memasang
  // sesuatu, yang lain menyuruhnya membaca sebabnya.
  assert.notEqual(panelFailed(2), PANEL_EMPTY)
  assert.match(panelFailed(2), /2/)
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

// ---------- tumpukan box ----------

const box = (spec: string, extra: { rows?: number; collapsed?: boolean } = {}) => ({
  spec,
  collapsed: extra.collapsed ?? false,
  ...(extra.rows !== undefined ? { rows: extra.rows } : {}),
})

test("satu box mendapat seluruh tinggi sisinya", () => {
  const stack = stackLayout({ rows: 14, boxes: [box("a")], floor: PANEL_BOX_FLOOR })
  assert.deepEqual(stack.boxes, [{ spec: "a", rows: 14, collapsed: false }])
  assert.deepEqual(stack.folded, [])
})

test("sisa tinggi dibagi rata, dan HABIS dibagi", () => {
  // Baris yang menganggur di dasar sidebar terlihat seperti box yang gagal
  // digambar, bukan seperti ruang yang memang kosong. 15 = 8 + 7, bukan 7 + 7.
  const stack = stackLayout({ rows: 15, boxes: [box("a"), box("b")], floor: PANEL_BOX_FLOOR })
  assert.deepEqual(
    stack.boxes.map((entry) => entry.rows),
    [8, 7],
  )
  assert.equal(
    stack.boxes.reduce((sum, entry) => sum + entry.rows, 0),
    15,
    "tidak ada baris yang menganggur",
  )
})

test("`rows` dilayani lebih dulu, tapi tetap dibatasi yang tersisa", () => {
  const dilayani = stackLayout({
    rows: 20,
    boxes: [box("a", { rows: 6 }), box("b")],
    floor: PANEL_BOX_FLOOR,
  })
  assert.deepEqual(
    dilayani.boxes.map((entry) => entry.rows),
    [6, 14],
  )

  // Permintaan yang lebih besar dari sisi itu sendiri tidak boleh mendorong
  // box lain ke bawah lantai; ia dipangkas, bukan dituruti.
  const dipangkas = stackLayout({
    rows: 12,
    boxes: [box("a", { rows: 99 }), box("b")],
    floor: PANEL_BOX_FLOOR,
  })
  assert.equal(dipangkas.boxes[1]?.rows, PANEL_BOX_FLOOR + PANEL_CHROME_ROWS)
  assert.equal(
    dipangkas.boxes.reduce((sum, entry) => sum + entry.rows, 0),
    12,
  )
})

test("box yang tidak kebagian tinggi melipat sendiri, dari BAWAH ke atas", () => {
  /*
   * Urutan config adalah urutan prioritas user. Melipat dari ujung yang lain
   * berarti box teratas — yang sengaja ia taruh di sana — justru yang pertama
   * hilang, dan tidak ada apa pun di layar yang menjelaskan kenapa.
   */
  const stack = stackLayout({
    rows: 12,
    boxes: [box("a"), box("b"), box("c")],
    floor: PANEL_BOX_FLOOR,
  })
  assert.deepEqual(stack.folded, ["c"], "yang paling bawah yang melipat")
  assert.deepEqual(
    stack.boxes.map((entry) => entry.collapsed),
    [false, false, true],
  )
  assert.equal(stack.boxes[2]?.rows, PANEL_COLLAPSED_ROWS)
})

test("box terlipat memakan satu baris, bukan satu bingkai", () => {
  // Tiga box terlipat yang masih membayar bingkai akan menghabiskan sembilan
  // baris untuk tidak menampilkan apa-apa, dan melipat berhenti jadi jalan
  // keluar dari sidebar yang penuh — satu-satunya gunanya.
  const stack = stackLayout({
    rows: 10,
    boxes: [box("a"), box("b", { collapsed: true }), box("c", { collapsed: true })],
    floor: PANEL_BOX_FLOOR,
  })
  assert.deepEqual(
    stack.boxes.map((entry) => entry.rows),
    [8, PANEL_COLLAPSED_ROWS, PANEL_COLLAPSED_ROWS],
  )
  assert.deepEqual(stack.folded, [], "user yang melipat, bukan lantai")
})

test("kalau baris terlipat pun tidak muat, yang paling bawah dibuang", () => {
  // Keadaan merosot yang tetap dilaporkan: panel yang meluber ke kolom tengah
  // terlihat seperti kerusakan render, dan sumbernya tidak akan dicari di sini.
  const stack = stackLayout({
    rows: 2,
    boxes: [box("a"), box("b"), box("c")],
    floor: PANEL_BOX_FLOOR,
  })
  assert.equal(stack.boxes.length, 2)
  assert.deepEqual(stack.dropped, ["c"])
  assert.ok(!stack.folded.includes("c"), "yang dibuang tidak ikut dijanjikan terlipat")
})

test("notice melipat menyebut jumlah dan lantainya", () => {
  assert.equal(foldedNotice([], 2), undefined)
  assert.match(foldedNotice(["a"], 2) ?? "", /1 panel folded/)
  assert.match(foldedNotice(["a", "b"], 3) ?? "", /2 panels folded .* 3 rows/)
})

// ---------- peta klik ----------

/*
 * Geometri dibangun `stackGeometry`, bukan ditulis tangan.
 *
 * Menuliskannya sebagai objek literal berarti test ini menyetujui angka yang
 * ia karang sendiri, dan pergeseran satu baris di penyusunnya akan lolos.
 * `top: 4` menaruh bingkai atas di baris layar 5 (1-basis), judul di 6, dan
 * baris isi pertama di 7.
 */
const GEOMETRY = {
  left: stackGeometry([{ spec: "kiri", rows: 8, collapsed: false }], { from: 1, to: 20 }, 4),
  right: stackGeometry([{ spec: "kanan", rows: 8, collapsed: false }], { from: 81, to: 100 }, 4),
}

test("klik dipetakan ke box dan indeks baris yang benar", () => {
  // Pergeseran satu di sini membuat SETIAP klik memilih tetangganya.
  assert.deepEqual(panelHit(GEOMETRY, 5, 7), { spec: "kiri", row: 0, title: false })
  assert.deepEqual(panelHit(GEOMETRY, 5, 8), { spec: "kiri", row: 1, title: false })
  assert.deepEqual(panelHit(GEOMETRY, 5, 11), { spec: "kiri", row: 4, title: false })
  assert.deepEqual(panelHit(GEOMETRY, 90, 9), { spec: "kanan", row: 2, title: false })
})

test("batas kolom panel eksklusif di kedua ujung yang benar", () => {
  assert.deepEqual(panelHit(GEOMETRY, 1, 7), { spec: "kiri", row: 0, title: false })
  assert.deepEqual(panelHit(GEOMETRY, 20, 7), { spec: "kiri", row: 0, title: false })
  assert.equal(panelHit(GEOMETRY, 21, 7), undefined)
  assert.equal(panelHit(GEOMETRY, 80, 7), undefined)
  assert.deepEqual(panelHit(GEOMETRY, 81, 7), { spec: "kanan", row: 0, title: false })
  assert.deepEqual(panelHit(GEOMETRY, 100, 7), { spec: "kanan", row: 0, title: false })
  assert.equal(panelHit(GEOMETRY, 101, 7), undefined)
})

test("baris judul adalah gestur LIPAT, bingkainya bukan apa-apa", () => {
  // Bingkai ada di kolom panel juga. Meneruskannya ke pencocokan riwayat akan
  // melipat blok tool yang kebetulan sebaris dengan bingkai panel.
  assert.deepEqual(panelHit(GEOMETRY, 5, 6), { spec: "kiri", row: 0, title: true })
  assert.equal(panelHit(GEOMETRY, 5, 5), undefined, "bingkai atas")
  assert.equal(panelHit(GEOMETRY, 5, 12), undefined, "bingkai bawah")
  assert.equal(panelHit(GEOMETRY, 5, 99), undefined)
})

test("box KEDUA di satu sisi punya barisnya sendiri", () => {
  /*
   * Inti dari sisi yang menampung banyak box. Selama peta klik hanya mengenal
   * satu box per sisi, klik di box bawah mengembalikan baris box atas — yang
   * terbaca sebagai "kliknya kurang akurat", bukan sebagai hitungan yang salah.
   */
  const dua = {
    left: stackGeometry(
      [
        { spec: "atas", rows: 6, collapsed: false },
        { spec: "bawah", rows: 6, collapsed: false },
      ],
      { from: 1, to: 20 },
      0,
    ),
    right: [],
  }
  // Box atas: bingkai 1, judul 2, isi 3–5, bingkai 6 (1-basis).
  assert.deepEqual(panelHit(dua, 5, 3), { spec: "atas", row: 0, title: false })
  // Box bawah mulai di baris 7: bingkai 7, judul 8, isi 9–11.
  assert.deepEqual(panelHit(dua, 5, 8), { spec: "bawah", row: 0, title: true })
  assert.deepEqual(panelHit(dua, 5, 9), { spec: "bawah", row: 0, title: false })
  assert.deepEqual(panelHit(dua, 5, 11), { spec: "bawah", row: 2, title: false })
})

test("box terlipat hanya bisa dikenai lewat baris judulnya", () => {
  const terlipat = {
    left: stackGeometry([{ spec: "lipat", rows: PANEL_COLLAPSED_ROWS, collapsed: true }], { from: 1, to: 20 }, 3),
    right: [],
  }
  assert.deepEqual(panelHit(terlipat, 5, 4), { spec: "lipat", row: 0, title: true })
  assert.equal(panelHit(terlipat, 5, 5), undefined, "tidak punya baris isi sama sekali")
})

test("sisi yang tidak tergambar tidak pernah kena klik", () => {
  const onlyLeft = {
    left: stackGeometry([{ spec: "kiri", rows: 8, collapsed: false }], { from: 1, to: 20 }, 4),
    right: [],
  }
  assert.equal(panelHit(onlyLeft, 90, 7), undefined)
  assert.equal(panelHit({ left: [], right: [] }, 5, 7), undefined)
})
