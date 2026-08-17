/**
 * Membaca kemajuan dari rencana — tanpa menambah mesin keadaan.
 *
 * # Kenapa parsing, bukan status per butir
 *
 * `plan.ts` sengaja menolak butir bergranular: *"Butir bergranular berarti mesin
 * keadaan kedua di sebelah `ToolState`, dan yang dibelinya — status per langkah
 * — sudah terlihat di transkrip."* Penolakan itu masih benar, dan tidak dibatalkan
 * di sini.
 *
 * Yang berubah adalah siapa yang bertanya. Dulu tidak ada satu pun yang perlu
 * TAHU apakah rencananya sudah habis; sekarang loop antar-giliran perlu, karena
 * "selesai" harus bisa dinilai tanpa bertanya ke model. Dan untuk itu tidak
 * dibutuhkan status — cukup MEMBACA apa yang sudah ditulis model sendiri.
 *
 * Model menulis `- [ ]` dan `- [x]` secara alami dalam markdown, tanpa pernah
 * diminta. Jadi tidak ada tool baru, tidak ada kolom baru, tidak ada keadaan
 * kedua yang harus dijaga tetap sinkron dengan yang pertama. Yang ada hanya
 * pembacaan atas satu-satunya sumber yang sudah ada.
 *
 * # Kenapa "tidak ada kotak centang" berarti tidak ada kemajuan yang bisa dinilai
 *
 * Rencana yang ditulis sebagai paragraf, atau sebagai daftar berpoin tanpa
 * kotak, tidak bisa dinilai — dan itu dilaporkan apa adanya lewat `checkable`,
 * bukan disamarkan jadi "nol butir tersisa". Bedanya menentukan: nol butir
 * tersisa berarti pekerjaan selesai, sedangkan tidak ada yang bisa dinilai
 * berarti kita tidak tahu. Menyamakan keduanya membuat loop berhenti pada
 * rencana yang justru baru saja ditulis.
 */

/**
 * Kotak centang markdown di awal butir daftar.
 *
 * `[x]`, `[X]`, dan `[-]` sama-sama dihitung selesai. `[-]` bukan standar
 * GitHub, tapi beberapa model memakainya untuk "dilewati" — dan butir yang
 * sengaja dilewati juga bukan pekerjaan yang tersisa.
 */
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX-])\]/

export interface PlanProgress {
  /** Butir yang kotaknya masih kosong. */
  open: number
  /** Butir yang sudah dicentang atau ditandai dilewati. */
  done: number
  /**
   * Apakah rencananya memang memakai kotak centang sama sekali.
   *
   * `false` berarti "tidak bisa dinilai", BUKAN "tidak ada sisa". Pemanggil
   * yang menyamakan keduanya akan berhenti pada rencana yang baru ditulis.
   */
  checkable: boolean
}

export function planProgress(text: string | undefined): PlanProgress {
  let open = 0
  let done = 0

  for (const line of (text ?? "").split("\n")) {
    const match = CHECKBOX.exec(line)
    if (!match) continue
    if (match[1] === " ") open += 1
    else done += 1
  }

  return { open, done, checkable: open + done > 0 }
}

/**
 * Apakah masih ada pekerjaan yang JELAS tersisa menurut rencananya sendiri.
 *
 * Sengaja konservatif: rencana yang tidak bisa dinilai menjawab `false`. Loop
 * yang terus jalan karena "tidak tahu" akan berputar pada setiap sesi yang
 * rencananya berbentuk paragraf — dan biayanya ditanggung user, bukan kita.
 */
export function hasOpenWork(text: string | undefined): boolean {
  const progress = planProgress(text)
  return progress.checkable && progress.open > 0
}
