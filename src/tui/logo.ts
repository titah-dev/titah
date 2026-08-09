import fs from "node:fs"
import path from "node:path"

/**
 * ASCII art dibaca dari `ascii-titah-art.txt` di akar paket, dengan salinan
 * tertanam sebagai cadangan.
 *
 * Dibaca saat runtime supaya bisa diganti tanpa build ulang; cadangan ada
 * supaya layar pembuka tidak pernah kosong hanya karena satu file hilang.
 */

/**
 * Cadangan wordmark ringkas, kalau `ascii-titah-art.txt` hilang dari paket.
 *
 * Isometrik: wajah huruf padat (`█`) dengan ekstrusi satu langkah (`▓`) ke
 * kanan-bawah. Gagasannya dari Rubik Iso, tapi digambar untuk grid sel — bukan
 * hasil render fontnya, yang berupa garis luar setebal rambut dan langsung
 * putus-putus begitu diperkecil ke ukuran ini.
 */
const FALLBACK = [
  "  ██       ██      ██                  ██      ",
  "  ██▓       ▓▓     ██▓                 ██▓     ",
  "███████    ██    ███████    ███████    ███████ ",
  " ▓██▓▓▓▓   ██▓    ▓██▓▓▓▓    ▓▓▓▓██▓   ██▓▓▓██▓",
  "  ██▓      ██▓     ██▓      ███████▓   ██▓  ██▓",
  "  ██▓      ██▓     ██▓      ██▓▓▓██▓   ██▓  ██▓",
  "  █████    ██▓     █████    ███████▓   ██▓  ██▓",
  "   ▓▓▓▓▓    ▓▓      ▓▓▓▓▓    ▓▓▓▓▓▓▓    ▓▓   ▓▓",
].join("\n")

/**
 * Cadangan wordmark lebar: Rubik Iso (OFL) yang benar-benar dirender.
 *
 * Strokenya ditebalkan lebih dulu; tanpa itu garis rambutnya hilang saat
 * diperkecil dan yang tersisa hanya bintik-bintik.
 */
const WIDE_FALLBACK = [
  "  ▄▄▄▄▄▄▄▖     ▟███████  ▄▄▄▄▄▄▄▖                     ▗▄▄▄▄▄▄▄          ",
  "  ██▀▀▀▀██     ██   ▄██  ██▀▀▀▀██                     ▐█▛▀▀▀▜█▌         ",
  "  ██    ██     ███████▜  ██    ██                     ▐█▌   ▐█▙         ",
  "████    ▀█████▙████████████    ▀█████▙▄▄▄▄▖      ▄▄▖  ▐█▌   ▐████████▙▄ ",
  "█▌          ▗████    ███▌          ▗█▛██▀▀▘▄▄▄   ▝███ ▐█▌    ▀▀     ▀██▄",
  "██▄▖    ▄▄▄▟█▛▘██    ███▙▄▖    ▄▄▄▟█▛▘██▄▄▟███▀    ▜█▖▐█▌   ▗▄▄▄▄    ▀██",
  "▝▀██    ██▀▀▀▘ ██    ██▝▀██    ██▀▀▀▘▗█████▛▀▀     ▐█ ▐█▌   ▐█▛██     ▐█",
  "  ██    █████▙ ██    ██  ██    █████▙██▘   ███▄    ▐█ ▐█▌   ▐█▌██     ▐█",
  "  ██▄       ▀█▌██    ██  ██▄       ▀███    ███▀    ▐█▘▐█▌   ▐█▌██     ▐█",
  "  ▀▀██▄▄▄▄▄▄▄█▙██▄▄▄▄██  ▀▀█▙▄▄▄▄▄▄▄████▄▖  ▄▄▄▄▄▄▄▟█ ▐█▙▄▄▄▟█▌██▄▄▄▄▄▟█",
  "    ▝▀▀▀▀▀▀▀▀▀▘▀▀▀▀▀▀▀▘    ▝▀▀▀▀▀▀▀▀▀▘▝▀▜████▛▀▀▀▀▀▀▀ ▝▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀",
].join("\n")

/**
 * Cadangan lambang — `@`, kalau `ascii-logo-art.txt` hilang dari paket.
 *
 * SENGAJA bukan Rubik Iso, meski wordmark-nya memakai font itu. `@` versi Iso
 * adalah spiral cincin konsentris dengan goresan dan celah selebar 1/19 lebar
 * glif. Satu kolom sel hanya memberi dua sub-piksel mendatar, jadi bentuknya
 * baru benar mulai 19 kolom — lebih lebar daripada yang pantas dipakai lambang
 * di panel header. Di bawah itu cincinnya tidak menipis, melainkan HILANG, dan
 * cincin mana yang hilang ditentukan oleh di mana ia kebetulan jatuh di kisi.
 *
 * Jadi yang dipakai di sini `@` berbobot tunggal: 12×7, dan pada ukuran itu
 * ketiga cirinya masih utuh — cincin, huruf "a" di dalam, dan ekor kanan bawah.
 */
const MARK_FALLBACK = [
  "  ▄▄█████▄  ",
  " ██▀     ▀█ ",
  "██ ▄█████ ██",
  "██ ██  ██ ██",
  "██ ▀███████▀",
  " ██▄     ▄▄ ",
  "  ▀██████▀  "
].join("\n")

const cache = new Map<string, string[]>()

/** dist/tui/logo.js → ../../<nama> (akar paket) */
function load(fileName: string, fallback: string): string[] {
  const hit = cache.get(fileName)
  if (hit) return hit

  let raw: string
  try {
    raw = fs.readFileSync(path.join(import.meta.dirname, "..", "..", fileName), "utf8")
  } catch {
    raw = fallback
  }

  // Semua baris disamakan lebarnya.
  //
  // Tanpa ini, seni ASCII yang spasi kanannya terpangkas akan PECAH saat
  // ditengahkan: Ink menengahkan tiap baris menurut lebarnya sendiri, sehingga
  // baris pendek bergeser lebih jauh ke kanan daripada baris panjang.
  const raw_lines = raw.replace(/\s+$/, "").split("\n")
  const width = raw_lines.reduce((max, line) => Math.max(max, line.length), 0)
  const lines = raw_lines.map((line) => line.padEnd(width))

  cache.set(fileName, lines)
  return lines
}

/**
 * Wordmark untuk layar pembuka, dipilih sesuai ruang yang tersedia.
 *
 * Versi Rubik Iso jauh lebih detail tapi butuh 76 kolom. Tanpa pilihan ringkas,
 * terminal 80-kolom-ke-bawah tidak mendapat logo sama sekali — dan tidak ada
 * logo jelas lebih buruk daripada logo yang lebih sederhana.
 */
export function logoLines(columns = Number.POSITIVE_INFINITY, rows = Number.POSITIVE_INFINITY): string[] {
  const wide = load("ascii-titah-art-wide.txt", WIDE_FALLBACK)
  if (fits(wide, columns, rows)) return wide
  return load("ascii-titah-art.txt", FALLBACK)
}

/** Sisakan ruang di kanan-kiri, dan ruang tegak untuk prompt serta petunjuk. */
function fits(lines: string[], columns: number, rows: number): boolean {
  return columns >= logoWidth(lines) + 4 && rows >= lines.length + 12
}

/** Lambang kecil untuk panel atas. */
export function markLines(): string[] {
  return load("ascii-logo-art.txt", MARK_FALLBACK)
}

/**
 * Panel berlambang memakan sembilan baris layar. Di terminal pendek, riwayat
 * percakapan jauh lebih berharga daripada hiasan.
 */
export function shouldShowMark(columns: number, rows: number): boolean {
  const mark = markLines()
  return rows >= 26 && columns >= logoWidth(mark) + 40
}

export function logoWidth(lines: string[] = logoLines()): number {
  return lines.reduce((max, line) => Math.max(max, line.length), 0)
}

/** Layar sempit lebih baik tanpa logo daripada dengan logo yang terpotong. */
export function shouldShowLogo(columns: number, rows: number): boolean {
  return fits(logoLines(columns, rows), columns, rows)
}
