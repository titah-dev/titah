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
export { PANEL_BOX_FLOOR, PANEL_FLOOR, PANEL_WIDTH } from "../core/schema.ts"

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
 * Ditampilkan saat ADA extension yang dikonfigurasi tapi tidak satu pun berhasil
 * dimuat.
 *
 * `PANEL_EMPTY` berbohong dalam keadaan itu: bukan "tidak ada extension",
 * melainkan "ada dan ditolak". Bedanya menentukan ke mana orang mencari — yang
 * satu menyuruhnya memasang sesuatu, yang lain menyuruhnya membaca sebabnya.
 *
 * Pendek dengan sengaja, dan tunduk pada batas yang sama dengan `PANEL_EMPTY`:
 * enam belas kolom di dalam panel bawaan. Kalimat yang bisa ditindaklanjuti
 * tidak muat di situ dan akan terpotong di tengah kata — jadi kalimat itu pergi
 * ke footer, dan yang tinggal di sini cuma penunjuknya.
 */
export function panelFailed(count: number): string {
  return `⚠ ${count} failed`
}

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

/**
 * Baris yang dipakai satu box TERLIPAT: judulnya saja, tanpa bingkai.
 *
 * Satu dan bukan tiga. Box terlipat yang masih membayar bingkai atas dan bawah
 * hampir tidak menghemat apa pun — tiga box terlipat akan memakan sembilan
 * baris untuk tidak menampilkan apa-apa, dan melipat berhenti jadi jalan keluar
 * dari sidebar yang penuh.
 */
export const PANEL_COLLAPSED_ROWS = 1

/** Satu extension yang meminta tempat di tumpukan sisinya. */
export interface StackEntry {
  spec: string
  /** Tinggi TOTAL yang diminta, termasuk bingkai. Tanpa ini: bagi rata. */
  rows?: number
  /** Dilipat oleh user atau oleh config. */
  collapsed: boolean
}

/** Satu box beserta tinggi yang benar-benar diberikan kepadanya. */
export interface StackBox {
  spec: string
  /** Tinggi TOTAL di layar, termasuk bingkai. `PANEL_COLLAPSED_ROWS` kalau terlipat. */
  rows: number
  collapsed: boolean
}

export interface StackLayout {
  boxes: StackBox[]
  /** Dilipat oleh LANTAI, bukan oleh user — untuk notice. */
  folded: string[]
  /** Tidak digambar sama sekali; hanya terjadi saat baris terlipat pun tak muat. */
  dropped: string[]
}

/**
 * Membagi tinggi satu sisi di antara box-boxnya.
 *
 * Kembaran `panelLayout` pada sumbu tinggi, dan bentuk kontraknya sengaja sama:
 * lantai, daftar yang dikorbankan, lalu satu kalimat notice yang menjelaskannya.
 * Yang sudah paham kenapa panel menutup sendiri saat terminal disempitkan sudah
 * paham kenapa box melipat sendiri saat terminal dipendekkan.
 *
 * Melipat dari BAWAH ke atas. Urutan config adalah urutan prioritas user —
 * melipat dari ujung yang lain berarti box teratas, yang sengaja ia taruh di
 * sana, justru yang pertama hilang.
 */
export function stackLayout(request: {
  rows: number
  boxes: StackEntry[]
  floor: number
}): StackLayout {
  const total = Math.max(0, Math.trunc(request.rows))
  const floor = Math.max(1, Math.trunc(request.floor))
  /** Tinggi terkecil sebuah box yang masih pantas disebut terbuka. */
  const base = floor + PANEL_CHROME_ROWS

  const entries = request.boxes.map((box) => ({ ...box }))
  const folded: string[] = []
  const dropped: string[] = []

  const cost = () => {
    const open = entries.filter((entry) => !entry.collapsed).length
    return open * base + (entries.length - open) * PANEL_COLLAPSED_ROWS
  }

  while (cost() > total) {
    const last = entries.findLastIndex((entry) => !entry.collapsed)
    if (last === -1) break
    const entry = entries[last] as StackEntry
    entry.collapsed = true
    folded.push(entry.spec)
  }

  // Bahkan baris judulnya pun tidak muat. Membuangnya dilaporkan, bukan
  // digambar menimpa riwayat — panel yang meluber ke kolom tengah terlihat
  // seperti kerusakan render, dan sumbernya tidak akan pernah dicari di sini.
  while (entries.length > 0 && entries.length * PANEL_COLLAPSED_ROWS > total) {
    const gone = entries.pop() as StackEntry
    dropped.push(gone.spec)
    const at = folded.indexOf(gone.spec)
    if (at !== -1) folded.splice(at, 1)
  }

  const heights = entries.map((entry) => (entry.collapsed ? PANEL_COLLAPSED_ROWS : base))
  const openAt = entries.flatMap((entry, index) => (entry.collapsed ? [] : [index]))
  let spare = total - heights.reduce((sum, value) => sum + value, 0)

  // Yang menyebut `rows` dilayani lebih dulu, dari atas ke bawah. Permintaan,
  // bukan jaminan: yang tersisa tetap batas atasnya.
  for (const index of openAt) {
    if (spare <= 0) break
    const wanted = entries[index]?.rows
    if (wanted === undefined) continue
    const extra = Math.max(0, Math.min(wanted - base, spare))
    heights[index] = (heights[index] as number) + extra
    spare -= extra
  }

  /*
   * Sisanya dibagi rata, dan HABIS dibagi.
   *
   * Baris yang menganggur di dasar sidebar terlihat seperti box yang gagal
   * digambar, bukan seperti ruang yang memang kosong. Sisa pembagian jatuh ke
   * box paling atas, arah yang sama dengan seluruh keputusan lain di sini.
   */
  const takers = openAt.filter((index) => entries[index]?.rows === undefined)
  const pool = takers.length > 0 ? takers : openAt
  if (pool.length > 0 && spare > 0) {
    const each = Math.floor(spare / pool.length)
    let rest = spare - each * pool.length
    for (const index of pool) {
      heights[index] = (heights[index] as number) + each + (rest > 0 ? 1 : 0)
      if (rest > 0) rest -= 1
    }
  }

  return {
    boxes: entries.map((entry, index) => ({
      spec: entry.spec,
      rows: heights[index] as number,
      collapsed: entry.collapsed,
    })),
    folded,
    dropped,
  }
}

/** Di mana satu box digambar di layar, untuk memetakan klik. */
export interface PanelBox {
  spec: string
  /** Kolom pertama dan terakhir, 1-basis seperti yang dikirim terminal. */
  from: number
  to: number
  /** Baris layar 0-basis tempat JUDUL box ini digambar. */
  titleTop: number
  /** Baris layar 0-basis baris ISI pertamanya. */
  top: number
  /** Berapa baris isi yang benar-benar digambar; 0 kalau terlipat. */
  rows: number
}

export interface PanelGeometry {
  left: PanelBox[]
  right: PanelBox[]
}

/**
 * Menyusun geometri satu sisi dari hasil `stackLayout`.
 *
 * Ada di sini, bukan di app.tsx: yang menghitung tinggi dan yang memetakan klik
 * harus membaca angka yang sama. Menyusunnya di sisi render berarti dua
 * ekspresi untuk satu tumpukan, dan gejalanya klik yang mengenai box tetangga —
 * yang terbaca sebagai "kliknya kurang akurat", bukan sebagai hitungan salah.
 */
export function stackGeometry(
  boxes: StackBox[],
  columns: { from: number; to: number },
  top: number,
): PanelBox[] {
  const out: PanelBox[] = []
  let cursor = top
  for (const box of boxes) {
    out.push({
      spec: box.spec,
      from: columns.from,
      to: columns.to,
      // Box terlipat TIDAK punya bingkai: barisnya sendiri adalah judulnya.
      titleTop: box.collapsed ? cursor : cursor + 1,
      top: cursor + 2,
      rows: box.collapsed ? 0 : Math.max(0, box.rows - PANEL_CHROME_ROWS),
    })
    cursor += box.rows
  }
  return out
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
): { spec: string; row: number; title: boolean } | undefined {
  const screen = y - 1
  for (const side of ["left", "right"] as const) {
    for (const box of geometry[side]) {
      if (x < box.from || x > box.to) continue

      // Baris judul adalah gestur LIPAT, bukan baris isi. Ia diperiksa lebih
      // dulu karena pada box terlipat ia satu-satunya baris yang ada.
      if (screen === box.titleTop) return { spec: box.spec, row: 0, title: true }

      const row = screen - box.top
      if (row >= 0 && row < box.rows) return { spec: box.spec, row, title: false }
    }
  }
  /*
   * Klik di dalam kolom panel tapi di luar baris mana pun mengembalikan
   * undefined — dan pemanggil harus BERHENTI di situ, bukan lanjut mencocokkan
   * ke riwayat. Bingkai panel ada di kolom itu juga, dan klik di sana tidak
   * boleh melipat blok tool yang kebetulan sebaris.
   */
  return undefined
}

/**
 * Kalimat untuk notice saat LANTAI melipat box, bukan user.
 *
 * Kembaran `droppedNotice` di bawah, dan ada di sini karena alasan yang sama:
 * yang melipat dan yang menjelaskan harus satu tempat.
 */
export function foldedNotice(folded: string[], floor: number): string | undefined {
  if (folded.length === 0) return undefined
  const which = folded.length === 1 ? "1 panel" : `${folded.length} panels`
  return `${which} folded — an open box needs ${floor} rows`
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
