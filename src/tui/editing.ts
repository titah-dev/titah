/**
 * Logika penyuntingan prompt yang tidak butuh Ink: menelusuri histori dan
 * memindahkan kursor.
 *
 * Dipisah dari komponen supaya bisa diuji langsung. Panah atas/bawah punya DUA
 * arti tergantung posisi kursor, dan aturan itulah yang paling mudah salah.
 */

import { widthOf } from "./markdown.ts"

/** Nilai `index` yang berarti "sedang mengetik draft baru", bukan menelusuri. */
export const DRAFT = -1

/**
 * Menggeser posisi telusur histori.
 *
 * `step` -1 menuju prompt yang lebih LAMA, +1 menuju yang lebih baru. Melewati
 * entri terbaru mengembalikan `DRAFT`: teks yang tadi sedang diketik harus bisa
 * didapatkan lagi, kalau tidak, satu tekanan panah menghapus ketikan user.
 */
export function browseHistory(history: string[], index: number, step: -1 | 1): number {
  if (history.length === 0) return DRAFT

  if (step === -1) {
    // Dari draft, panah atas masuk ke entri TERBARU, lalu mundur satu-satu.
    if (index === DRAFT) return history.length - 1
    return Math.max(0, index - 1)
  }

  if (index === DRAFT) return DRAFT
  return index + 1 >= history.length ? DRAFT : index + 1
}

/**
 * Prompt yang identik berturut-turut disimpan sekali saja.
 *
 * Mengulang perintah yang sama beberapa kali itu wajar, dan tanpa penyaringan
 * ini panah atas harus ditekan lima kali untuk melewati lima entri yang sama.
 */
export function pushHistory(history: string[], text: string): string[] {
  if (text === "" || history.at(-1) === text) return history
  return [...history, text]
}

function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursor - 1) + 1
  const nextBreak = text.indexOf("\n", cursor)
  return { start, end: nextBreak === -1 ? text.length : nextBreak }
}

/**
 * Awal dan akhir baris LOGIS, untuk ctrl+a / ctrl+e.
 *
 * Sengaja baris logis dan bukan baris visual, meski panah atas/bawah memakai
 * yang visual: ctrl+a yang berhenti di tengah kalimat karena kalimat itu
 * kebetulan terbungkus lebih membingungkan daripada membantu, dan itu juga
 * yang dilakukan readline.
 */
export function lineStart(text: string, cursor: number): number {
  return lineBounds(text, cursor).start
}

export function lineEnd(text: string, cursor: number): number {
  return lineBounds(text, cursor).end
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" })

/**
 * Offset awal setiap baris VISUAL: awal baris logis ditambah titik bungkus.
 *
 * Kursor harus bergerak sebanyak yang dilihat mata. Terminal membungkus baris
 * panjang jadi beberapa baris, dan panah yang menghitung `\n` saja akan
 * melompati seluruh blok terbungkus dalam satu tekanan — persis yang membuat
 * panah terasa tidak berfungsi pada prompt yang panjang.
 *
 * Lebarnya dari `widthOf`, bukan `text.length`. Ink menggambar dengan lebar
 * tampilan, jadi menghitung titik bungkus dengan satuan lain berarti kursor
 * pindah baris di tempat yang berbeda dari tempat baris itu benar-benar patah.
 */
export function visualRows(text: string, columns: number): number[] {
  const starts = [0]
  // Lebar yang tidak masuk akal (nol, negatif, tak hingga) tidak boleh
  // menghasilkan pembungkusan sama sekali — yang tersisa hanya baris logis.
  const wrap = Number.isFinite(columns) && columns >= 1 ? columns : Infinity

  let width = 0
  let offset = 0

  for (const { segment } of GRAPHEMES.segment(text)) {
    if (segment === "\n") {
      offset += segment.length
      starts.push(offset)
      width = 0
      continue
    }

    // Tanda yang tidak muat dibuka di baris berikutnya utuh, bukan dipotong:
    // terminal juga menggeser seluruh tanda, bukan separuh kolomnya.
    const cells = widthOf(segment)
    if (width > 0 && width + cells > wrap) {
      starts.push(offset)
      width = 0
    }

    width += cells
    offset += segment.length
  }

  return starts
}

/** Baris visual yang memuat kursor: yang TERAKHIR dimulai pada atau sebelumnya. */
function rowAt(starts: number[], cursor: number): number {
  let row = 0
  for (let i = 0; i < starts.length; i++) {
    if ((starts[i] as number) > cursor) break
    row = i
  }
  return row
}

/**
 * Akhir isi sebuah baris visual.
 *
 * `\n` dikecualikan: ia milik baris ini tapi tidak pernah jadi tempat kursor
 * yang sah — kursor di sana terlihat berada di baris berikutnya.
 */
function rowEnd(text: string, starts: number[], row: number): number {
  const next = starts[row + 1]
  if (next === undefined) return text.length
  return text[next - 1] === "\n" ? next - 1 : next
}

/** Offset di dalam satu baris yang kolom tampilannya paling dekat ke `column`. */
function offsetAtColumn(text: string, start: number, end: number, column: number): number {
  let width = 0
  let offset = start

  for (const { segment } of GRAPHEMES.segment(text.slice(start, end))) {
    const cells = widthOf(segment)
    if (width + cells > column) break
    width += cells
    offset += segment.length
  }

  return offset
}

export function onFirstVisualLine(text: string, cursor: number, columns: number): boolean {
  return rowAt(visualRows(text, columns), cursor) === 0
}

export function onLastVisualLine(text: string, cursor: number, columns: number): boolean {
  const starts = visualRows(text, columns)
  return rowAt(starts, cursor) === starts.length - 1
}

/**
 * Memindahkan kursor satu baris visual, mempertahankan kolomnya.
 *
 * Baris tujuan yang lebih pendek menaruh kursor di ujungnya — bukan meluber ke
 * baris berikutnya, yang membuat kursor terlihat melompat dua baris sekaligus.
 */
export function moveCursorVisualLine(
  text: string,
  cursor: number,
  step: -1 | 1,
  columns: number,
): number {
  const starts = visualRows(text, columns)
  const row = rowAt(starts, cursor)
  const target = row + step
  if (target < 0 || target >= starts.length) return cursor

  const column = widthOf(text.slice(starts[row] as number, cursor))
  const start = starts[target] as number
  return offsetAtColumn(text, start, rowEnd(text, starts, target), column)
}

/**
 * Apa yang dihitung sebagai satu kata untuk alt+←/→.
 *
 * Tanda baca adalah pemisah, bukan bagian kata, supaya `src/tui/app.tsx` punya
 * beberapa perhentian dan bukan satu — jalur dan pemanggilan fungsi adalah dua
 * hal yang paling sering disunting di prompt ini.
 *
 * Batasnya per aksara, jadi tulisan tanpa spasi (CJK, Thai) diperlakukan sebagai
 * satu kata panjang. `Intl.Segmenter` bisa memenggalnya dan sudah dipakai di
 * `markdown.ts`, tapi hasilnya bergantung versi ICU — perilaku tombol yang
 * berbeda antar mesin Node lebih merugikan daripada penggalan yang kasar.
 */
const WORD = /[\p{L}\p{N}_]/u

/** Ke awal kata sebelumnya, seperti `backward-word` readline. */
export function wordLeft(text: string, cursor: number): number {
  let index = Math.min(cursor, text.length)
  while (index > 0 && !WORD.test(text[index - 1] as string)) index--
  while (index > 0 && WORD.test(text[index - 1] as string)) index--
  return index
}

/** Ke akhir kata berikutnya, seperti `forward-word` readline. */
export function wordRight(text: string, cursor: number): number {
  let index = Math.max(cursor, 0)
  while (index < text.length && !WORD.test(text[index] as string)) index++
  while (index < text.length && WORD.test(text[index] as string)) index++
  return index
}
