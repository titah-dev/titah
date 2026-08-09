/**
 * Logika penyuntingan prompt yang tidak butuh Ink: menelusuri histori dan
 * memindahkan kursor antar baris.
 *
 * Dipisah dari komponen supaya bisa diuji langsung. Panah atas/bawah punya DUA
 * arti tergantung posisi kursor, dan aturan itulah yang paling mudah salah.
 */

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

export function onFirstLine(text: string, cursor: number): boolean {
  return !text.slice(0, cursor).includes("\n")
}

export function onLastLine(text: string, cursor: number): boolean {
  return !text.slice(cursor).includes("\n")
}

/**
 * Memindahkan kursor satu baris, mempertahankan kolomnya.
 *
 * Baris tujuan yang lebih pendek menaruh kursor di ujungnya — bukan meluber ke
 * baris berikutnya, yang membuat kursor terlihat melompat dua baris sekaligus.
 */
export function moveCursorLine(text: string, cursor: number, step: -1 | 1): number {
  const { start, end } = lineBounds(text, cursor)
  const column = cursor - start

  if (step === -1) {
    if (start === 0) return cursor
    const previous = lineBounds(text, start - 1)
    return Math.min(previous.start + column, previous.end)
  }

  if (end === text.length) return cursor
  const next = lineBounds(text, end + 1)
  return Math.min(next.start + column, next.end)
}
