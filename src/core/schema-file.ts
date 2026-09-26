import fs from "node:fs"
import path from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { editConfigFile } from "./config-edit.ts"
import { globalConfigFile, userSchemaFile } from "./paths.ts"

/**
 * `config.schema.json` di folder config user, dan `$schema` yang menunjuk ke sana.
 *
 * # Kenapa salinan, bukan path ke paket
 *
 * Sampai 0.9.0 `titah init` menulis path absolut ke folder instalasi paket —
 * `/opt/homebrew/lib/node_modules/titah-code/config.schema.json` atau semacamnya.
 * Path itu putus begitu Node, prefix npm, atau cara pasangnya berganti, dan
 * gejalanya cuma autocomplete yang hilang tanpa pesan apa pun. `~/.config/titah`
 * tidak pernah berpindah, jadi schema disalin ke sana dan disegarkan setiap kali
 * isinya berbeda dari versi yang sedang jalan — upgrade membawa schema-nya
 * sendiri tanpa ada yang perlu mengingat apa pun.
 *
 * # Kenapa absolut, bukan `./config.schema.json`
 *
 * VS Code tidak mengembangkan `~`, dan path relatif hanya benar untuk config
 * global. Nilai yang sama yang disalin ke `titah.json` proyek harus tetap
 * menunjuk ke berkas yang sama.
 */

/** Schema yang dikirim bersama paket: `<root>/config.schema.json`, dari `src/core` maupun `dist/core`. */
export function bundledSchemaFile(): string {
  return path.join(import.meta.dirname, "..", "..", "config.schema.json")
}

export type SchemaSync = "created" | "updated" | "current" | "unavailable"

/**
 * Menyamakan salinan user dengan schema paket. Menulis hanya kalau isinya beda.
 *
 * "unavailable" berarti paketnya tidak membawa schema (checkout yang belum
 * menjalankan `npm run schema`) — bukan kegagalan, dan tidak ada yang ditulis.
 */
export function syncSchemaFile(bundled = bundledSchemaFile(), target = userSchemaFile()): SchemaSync {
  let source: string
  try {
    source = fs.readFileSync(bundled, "utf8")
  } catch {
    return "unavailable"
  }

  let existing: string | undefined
  try {
    existing = fs.readFileSync(target, "utf8")
  } catch {
    existing = undefined
  }
  if (existing === source) return "current"

  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Tulis-lalu-rename, sama seperti config: editor yang sedang membaca schema
  // tidak pernah melihat berkas setengah tertulis.
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, source, "utf8")
  fs.renameSync(temporary, target)
  return existing === undefined ? "created" : "updated"
}

export type SchemaRef =
  | { state: "no-config" }
  | { state: "unparsable" }
  | { state: "absent" }
  | { state: "current" }
  | { state: "stale"; value: string }
  | { state: "custom"; value: string }

/**
 * Ke mana `$schema` di sebuah config menunjuk, tanpa mengubah apa pun.
 *
 * "stale" hanya untuk path LOKAL yang berakhiran `config.schema.json` — itulah
 * bentuk yang pernah ditulis `titah init`. URL dan nama berkas lain adalah
 * pilihan user sendiri ("custom") dan tidak pernah disentuh.
 */
export function readSchemaRef(file = globalConfigFile(), target = userSchemaFile()): SchemaRef {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { state: "no-config" }
  }
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null) return { state: "unparsable" }

  const value = (parsed as Record<string, unknown>).$schema
  if (typeof value !== "string" || value.trim() === "") return { state: "absent" }
  if (path.resolve(value) === path.resolve(target)) return { state: "current" }
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  if (!isUrl && path.basename(value) === "config.schema.json") return { state: "stale", value }
  return { state: "custom", value }
}

/**
 * Memindahkan `$schema` yang basi ke salinan user. `true` kalau berkasnya berubah.
 *
 * Tidak MENAMBAHKAN `$schema` ke config yang tidak punya: tidak adanya kunci itu
 * juga sebuah pilihan, dan Titah tidak menyunting config orang tanpa alasan.
 */
export function migrateSchemaRef(file = globalConfigFile(), target = userSchemaFile()): boolean {
  if (readSchemaRef(file, target).state !== "stale") return false
  return editConfigFile(file, ["$schema"], target)
}

/**
 * Dipanggil sekali per proses. Tidak pernah melempar: autocomplete di editor
 * bukan alasan untuk menolak menjalankan agent.
 */
export function ensureSchema(): void {
  try {
    const synced = syncSchemaFile()
    if (synced === "unavailable") return
    migrateSchemaRef()
  } catch {
    // Disk penuh, folder read-only, config dikunci editor lain — semuanya
    // dicoba lagi di proses berikutnya, dan `titah doctor` menunjukkan keadaannya.
  }
}
