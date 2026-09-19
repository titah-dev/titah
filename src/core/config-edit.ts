import fs from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { globalConfigFile, projectConfigFile } from "./paths.ts"

/**
 * Menyunting config user di tempat, tanpa menghancurkan apa yang ia tulis.
 *
 * Sampai sekarang Titah HANYA membaca config (`config.ts` cuma memanggil
 * `parse`). Penulisan lahir karena memasang extension harus mencatat sesuatu ke
 * config — dan "pasang lewat picker" yang menyuruh user menyunting JSON sendiri
 * sesudahnya bukan pemasangan, cuma pengingat.
 *
 * # Kenapa `modify` dan bukan `JSON.stringify`
 *
 * Config Titah adalah JSONC. `JSON.parse` lalu `JSON.stringify` mengembalikan
 * berkas yang setara secara data dan berbeda secara berkas: komentar hilang,
 * urutan key bisa berubah, indentasi jadi milik stringify, bukan milik user.
 * Kerusakan itu tidak bisa dibatalkan, dan ia terjadi pada berkas yang
 * dirawat tangan.
 *
 * `modify` dari jsonc-parser mengembalikan daftar sunting berupa rentang teks,
 * jadi yang berubah hanya bagian yang memang dituju.
 */

export interface EditOptions {
  tabSize?: number
  insertSpaces?: boolean
}

/**
 * Terlempar saat config yang ada tidak bisa diurai.
 *
 * Kelas tersendiri, bukan `Error` biasa, karena pemanggilnya harus bisa
 * membedakan "config rusak, jangan sentuh" dari kegagalan tulis biasa: yang
 * pertama menuntut manusia melihat berkasnya, yang kedua bisa dicoba ulang.
 */
export class ConfigUnparsable extends Error {
  readonly file: string

  constructor(file: string, detail: string) {
    super(`${file} is not valid JSONC (${detail}) — refusing to edit it`)
    this.name = "ConfigUnparsable"
    this.file = file
  }
}

/**
 * Menyunting satu jalur di dalam teks JSONC dan mengembalikan teks barunya.
 *
 * `value === undefined` MENGHAPUS jalur itu. Itu bagian dari kontrak dan bukan
 * kebetulan: mencabut extension harus bisa membuang entrinya, dan menuliskan
 * `null` di sana akan meninggalkan entri yang tetap dimuat lalu gagal.
 */
export function editJsonc(text: string, keys: (string | number)[], value: unknown, options: EditOptions = {}): string {
  const edits = modify(text, keys, value, {
    formattingOptions: {
      tabSize: options.tabSize ?? 2,
      insertSpaces: options.insertSpaces ?? true,
    },
  })
  return applyEdits(text, edits)
}

/**
 * Menyunting berkas config di disk. Mengembalikan `true` kalau isinya berubah.
 *
 * Config yang tidak bisa diurai membuat fungsi ini MELEMPAR, bukan menuliskan
 * berkas baru di atasnya. Berkas yang punya satu koma salah masih memuat
 * seluruh pilihan user; menggantinya dengan berkas yang hanya berisi apa yang
 * kita tahu berarti menghukum satu salah tulis dengan kehilangan segalanya.
 */
export function editConfigFile(
  file: string,
  keys: (string | number)[],
  value: unknown,
  options: EditOptions = {},
): boolean {
  const existing = readIfExists(file)

  if (existing !== undefined && existing.trim() !== "") {
    const errors: ParseError[] = []
    parseJsonc(existing, errors, { allowTrailingComma: true })
    if (errors.length > 0) throw new ConfigUnparsable(file, `${errors.length} parse error(s)`)
  }

  const before = existing ?? "{}\n"
  const after = editJsonc(before, keys, value, options)
  if (after === before) return false

  fs.mkdirSync(path.dirname(file), { recursive: true })
  /*
   * Tulis ke berkas sementara lalu rename, bukan tulis langsung.
   *
   * `rename` di filesystem yang sama bersifat atomik: config tidak pernah ada
   * dalam keadaan setengah tertulis. Tanpa itu, proses yang mati di tengah
   * penulisan meninggalkan berkas terpotong — dan berkas terpotong berarti
   * sesi berikutnya menolak start karena hal yang tidak diminta user.
   */
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, after, "utf8")
  fs.renameSync(temporary, file)
  return true
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Berkas config yang benar-benar menyebut `extension[spec]`, urut prioritas naik.
 *
 * `loadConfig()` tidak bisa menjawab ini: ia me-merge global dan proyek ke satu
 * objek dan membuang asal tiap kunci. Yang dibutuhkan saat mencabut justru
 * asalnya — path lokal `./x` selalu ditulis ke config PROYEK, jadi pencabutan
 * yang selalu menyunting config global melapor "Removed" untuk entri yang masih
 * utuh.
 *
 * Mengembalikan DAFTAR, bukan satu berkas. Spec yang disebut di kedua tempat
 * harus dicabut dari keduanya; entri global yang tertinggal menghidupkannya lagi
 * di sesi berikutnya, dan user melihat extension yang ia hapus kembali sendiri.
 */
export function extensionDeclaredIn(
  spec: string,
  files: string[] = [globalConfigFile(), projectConfigFile()],
): string[] {
  const found: string[] = []
  for (const file of files) {
    const text = readIfExists(file)
    if (text === undefined || text.trim() === "") continue

    const errors: ParseError[] = []
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as
      | { extension?: Record<string, unknown> }
      | undefined
    /*
     * Berkas yang tidak bisa diurai MENGGAGALKAN pencarian, bukan dilewati.
     *
     * Melewatinya berarti mengaku tahu spec itu tidak ada di sana, padahal yang
     * sebenarnya terjadi adalah tidak bisa membacanya — dan jawaban itu yang
     * menentukan berkas mana yang disunting sesudahnya.
     */
    if (errors.length > 0) throw new ConfigUnparsable(file, `${errors.length} parse error(s)`)

    const table = parsed?.extension
    if (table !== null && typeof table === "object" && spec in table) found.push(file)
  }
  return found
}
