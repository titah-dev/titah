/**
 * Geometri panel samping.
 *
 * Sengaja dipisah dari komponen Ink supaya lebar yang DIRESERVASI untuk riwayat
 * dan lebar yang DIGAMBAR untuk panel datang dari satu perhitungan. Catatan di
 * `app.tsx` untuk panel sub-agent mencatat bug persis itu pada sumbu tinggi:
 * reservasi dan render menyimpang diam-diam, dan gejalanya baru muncul saat satu
 * giliran menghasilkan cukup banyak baris. Sumbu lebar lebih rawan lagi, karena
 * di situlah pembungkus baris riwayat mengambil angkanya.
 */

/*
 * Bawaannya di-reeksport dari schema, bukan ditulis ulang di sini. Config yang
 * mendeklarasikan 40 sementara geometri memakai 50 adalah bentuk lain dari
 * "yang diukur bukan yang dikirim", dan yang ini tidak akan terlihat sampai ada
 * orang menghapus blok `panel` dari config-nya.
 */
export { PANEL_FLOOR, PANEL_WIDTH } from "../core/schema.ts"

import { widthOf } from "./markdown.ts"

export type PanelSide = "left" | "right"

export interface PanelRequest {
  columns: number
  /** Kolom minimum untuk kolom tengah. Panel ditutup, bukan dipersempit. */
  floor: number
  /** Lebar panel kiri kalau ia diminta terbuka; 0 berarti tidak diminta. */
  left: number
  right: number
}

export interface PanelLayout {
  /** Kolom yang benar-benar diberikan; 0 berarti panel tidak digambar. */
  left: number
  right: number
  /** Kolom yang tersisa untuk kolom tengah, sebelum padding riwayat. */
  content: number
  /**
   * Panel yang DIMINTA terbuka tapi tidak digambar karena lantai.
   *
   * Dilaporkan, bukan disimpan diam-diam: state "terbuka" milik user tetap
   * menyala, jadi panel muncul sendiri lagi begitu terminal dilebarkan. Kalau
   * lantai ikut mematikan state-nya, melebarkan terminal tidak akan memulihkan
   * apa pun dan user harus menekan tombolnya lagi tanpa tahu kenapa.
   */
  dropped: PanelSide[]
}

/**
 * Membagi kolom terminal antara panel kiri, riwayat, dan panel kanan.
 *
 * Lantai hanya bisa MENUTUP panel; ia tidak bisa melebarkan terminal. Pada
 * terminal yang lebih sempit dari lantainya, kedua panel tertutup dan kolom
 * tengah tetap di bawah lantai — itu keadaan yang tidak punya jalan keluar, dan
 * berpura-pura sebaliknya hanya menghasilkan panel yang digambar di atas
 * riwayat.
 *
 * Kanan yang ditutup lebih dulu, selalu. Bukan karena kanan kurang penting,
 * tapi karena urutan yang tetap bisa dipelajari: panel yang hilang berganti-
 * ganti sisi setiap kali terminal diubah ukurannya terlihat seperti kerusakan.
 */
export function panelLayout(request: PanelRequest): PanelLayout {
  const columns = Math.max(0, Math.trunc(request.columns))
  const floor = Math.max(0, Math.trunc(request.floor))
  let left = clampWidth(request.left, columns)
  let right = clampWidth(request.right, columns)
  const dropped: PanelSide[] = []

  if (columns - left - right < floor && right > 0) {
    right = 0
    dropped.push("right")
  }
  if (columns - left - right < floor && left > 0) {
    left = 0
    dropped.push("left")
  }

  return { left, right, content: columns - left - right, dropped }
}

function clampWidth(width: number, columns: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0
  return Math.min(Math.trunc(width), columns)
}

/** Lebar terkecil yang masih berguna. Sama dengan batas di skema config. */
export const PANEL_MIN_WIDTH = 8

/** Kolom per tekanan resize. */
export const PANEL_RESIZE_STEP = 2

/**
 * Lebar baru sesudah satu tekanan resize.
 *
 * Dibatasi supaya pelebaran TIDAK BISA menembus lantai. Tanpa batas itu,
 * menekan `+` sekali lagi membuat panel yang sedang kamu lebarkan menutup
 * sendiri — lantai bekerja seperti seharusnya, tapi dari tempat user itu
 * terbaca sebagai panel yang hilang karena dilebarkan.
 *
 * `other` adalah lebar panel seberang yang sedang TERGAMBAR, bukan yang
 * dikonfigurasi: melebarkan panel kiri saat yang kanan tertutup boleh memakai
 * ruangnya, dan menghitungnya dari config akan menyisakan ruang untuk panel
 * yang tidak ada di layar.
 */
export function resizePanel(input: {
  current: number
  delta: number
  columns: number
  other: number
  floor: number
}): number {
  const ceiling = Math.max(PANEL_MIN_WIDTH, input.columns - input.other - input.floor)
  const wanted = Math.trunc(input.current + input.delta)
  return Math.max(PANEL_MIN_WIDTH, Math.min(wanted, ceiling))
}

/**
 * Kolom yang habis dipakai bingkai dan padding satu panel.
 *
 * `borderStyle` mengambil satu kolom di tiap sisi dan `paddingX={1}` satu lagi.
 * Angka ini HARUS cocok dengan properti Box di `panel.tsx` — kalau tidak, teks
 * dipotong pada lebar yang berbeda dari lebar yang tersedia, dan gejalanya
 * hanya muncul pada baris yang panjangnya persis di perbatasan.
 */
export const PANEL_CHROME_COLUMNS = 4

/** Baris yang habis dipakai bingkai atas, bingkai bawah, dan judul. */
export const PANEL_CHROME_ROWS = 3

/**
 * Ditampilkan saat sisi ini terbuka tapi tidak ada extension yang mengisinya.
 *
 * Harus muat di lebar panel bawaan — dua belas karakter untuk enam belas kolom
 * dalam bingkai. Kalimat yang lebih menjelaskan justru terpotong di tengah dan
 * berhenti menjelaskan apa pun; ada test yang menahan batas ini.
 */
export const PANEL_EMPTY = "No extension"

/**
 * Satu baris di dalam panel, beserta gayanya.
 *
 * Bergaya dan bukan string telanjang karena `ViewRow` membawa `dim`, `color`,
 * dan `selected` — dan memotong teksnya di satu tempat lalu memasang gayanya di
 * tempat lain adalah bentuk lain dari dua ekspresi untuk satu baris.
 */
export interface PanelLine {
  text: string
  dim?: boolean
  color?: string
  bold?: boolean
}

/**
 * Memotong dan mem-window isi panel ke ruang yang benar-benar ada.
 *
 * Pemotongan terjadi DI SINI dan bukan diserahkan ke Ink, karena Ink akan
 * membungkus baris yang terlalu panjang ke baris berikutnya — dan panel yang
 * membungkus mendorong barisnya sendiri keluar dari tinggi yang sudah
 * direservasi, tanpa satu pun error.
 */
export function panelBody(lines: PanelLine[], width: number, rows: number): PanelLine[] {
  const inner = Math.max(0, width - PANEL_CHROME_COLUMNS)
  const height = Math.max(0, rows - PANEL_CHROME_ROWS)
  const source = lines.length === 0 ? [{ text: PANEL_EMPTY, dim: true }] : lines
  return source.slice(0, height).map((line) => ({ ...line, text: truncate(line.text, inner) }))
}

/**
 * Bentuk pendek untuk baris tanpa gaya.
 *
 * Dinamai `plain` dan bukan `line`: `line` adalah nama variabel lokal yang wajar
 * di setiap tempat yang mengulang baris, dan tabrakannya muncul sebagai
 * "Cannot access before initialization" — pesan yang menunjuk hoisting, bukan
 * menunjuk nama.
 */
export function plain(text: string): PanelLine {
  return { text }
}

/** Judul dipotong dengan aturan yang sama dengan isinya, dari satu tempat. */
export function panelTitle(title: string, width: number): string {
  return truncate(title, Math.max(0, width - PANEL_CHROME_COLUMNS))
}

/**
 * Memotong berdasarkan lebar TAMPILAN, bukan jumlah karakter.
 *
 * `widthOf` yang dipakai dan bukan `.length` karena satu karakter CJK atau emoji
 * memakan dua kolom. Memotong pada jumlah karakter membuat nama branch berhuruf
 * Jepang melewati bingkai, dan Ink membungkusnya ke baris berikutnya — panel
 * lalu tumbuh melewati tinggi yang sudah direservasi, tanpa satu pun error.
 */
function truncate(line: string, inner: number): string {
  if (inner <= 0) return ""
  if (widthOf(line) <= inner) return line
  if (inner === 1) return "…"

  // Elipsis memakan satu kolom, jadi ia MENGGANTIKAN karakter terakhir yang
  // masih muat — bukan ditambahkan sesudahnya, yang justru melewati batas.
  const budget = inner - 1
  let width = 0
  let cut = 0
  for (const character of line) {
    const next = width + widthOf(character)
    if (next > budget) break
    width = next
    cut += character.length
  }
  return `${line.slice(0, cut)}…`
}

/** Di mana panel digambar di layar, untuk memetakan klik. */
export interface PanelBox {
  /** Kolom pertama dan terakhir, 1-basis seperti yang dikirim terminal. */
  from: number
  to: number
  /** Berapa baris isi yang benar-benar digambar. */
  rows: number
}

export interface PanelGeometry {
  /** Baris layar 0-basis tempat baris ISI pertama digambar. */
  contentTop: number
  left?: PanelBox
  right?: PanelBox
}

/**
 * Sisi dan indeks baris yang dikenai sebuah klik, atau `undefined`.
 *
 * Fungsi murni, dan itu disengaja: pergeseran satu baris di sini membuat SETIAP
 * klik memilih baris tetangganya — bug yang terlihat seperti "kliknya kurang
 * akurat" alih-alih seperti perhitungan yang salah, dan karena itu bisa hidup
 * lama tanpa ada yang mencurigainya.
 *
 * `x` dan `y` 1-basis, seperti yang dikirim terminal.
 */
export function panelHit(
  geometry: PanelGeometry,
  x: number,
  y: number,
): { side: PanelSide; row: number } | undefined {
  const row = y - 1 - geometry.contentTop
  for (const side of ["left", "right"] as const) {
    const box = geometry[side]
    if (!box || x < box.from || x > box.to) continue
    /*
     * Klik di dalam kolom panel tapi di luar barisnya mengembalikan undefined —
     * dan pemanggil harus BERHENTI di situ, bukan lanjut mencocokkan ke riwayat.
     * Bingkai dan judul panel ada di kolom itu juga, dan klik di sana tidak
     * boleh membuka blok tool yang kebetulan sebaris.
     */
    if (row < 0 || row >= box.rows) return undefined
    return { side, row }
  }
  return undefined
}

/**
 * Kalimat untuk notice saat lantai menutup panel.
 *
 * Ada di sini dan bukan di komponen supaya yang menutup panel dan yang
 * menjelaskannya adalah satu tempat. Notice yang ditulis di sisi render akan
 * menyebut sisi yang salah begitu urutan penutupan di atas berubah.
 */
export function droppedNotice(dropped: PanelSide[], floor: number): string | undefined {
  if (dropped.length === 0) return undefined
  const which = dropped.length === 2 ? "Side panels" : dropped[0] === "left" ? "Left panel" : "Right panel"
  return `${which} hidden — history needs ${floor} columns`
}
