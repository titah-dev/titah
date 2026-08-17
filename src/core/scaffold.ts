import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { configSources } from "./skill-sources.ts"

/**
 * Berkas yang DIDEKLARASIKAN config tapi belum ada, dibuatkan sekali.
 *
 * # Kenapa ini ada
 *
 * `buildSystemPrompt` membaca setiap path di `instructions` di dalam `try`
 * kosong: path yang salah ketik dilewati tanpa suara. Itu pilihan yang benar
 * untuk MEMBACA — satu berkas hilang tidak boleh menggagalkan sesi — tapi
 * akibatnya instruksi yang user kira sedang berlaku sebenarnya tidak pernah
 * ikut, dan tidak ada satu pun gejala yang menunjukkannya. Ia bekerja seperti
 * biasa, hanya saja tanpa aturan yang paling ingin ia tegakkan.
 *
 * Membuat berkasnya menutup celah itu dari sisi yang benar. Sesudah ini, path
 * yang ada di config selalu punya berkas; kalau isinya kosong itu terlihat,
 * dan yang terlihat bisa diperbaiki.
 *
 * # Batasnya, dan kenapa seketat itu
 *
 * HANYA yang ditulis user di config. Tidak ada penebakan, tidak ada "sekalian
 * buatkan AGENTS.md" — berkas yang muncul tanpa pernah diminta lebih buruk
 * daripada berkas yang hilang, karena user tidak punya cara menghubungkannya
 * dengan apa pun yang ia lakukan.
 *
 * TIDAK PERNAH menimpa. Yang sudah ada dibiarkan apa adanya, termasuk kalau
 * isinya kosong: berkas kosong adalah keputusan yang sah, dan menimpanya dengan
 * template akan menghapus keputusan itu.
 *
 * DILAPORKAN, tidak diam-diam. Menulis ke disk sebagai efek samping dari
 * membaca config adalah hal yang harus terlihat.
 */

/** Isi awal berkas instruksi, dengan contoh yang bisa langsung diganti. */
const INSTRUCTION_TEMPLATE = [
  "# Titah instructions",
  "",
  "Everything here is loaded into the system prompt at the start of every turn,",
  "before any work begins. Write rules, not explanations — this is read by a model,",
  "not by a person catching up.",
  "",
  "Delete these examples once you have written your own.",
  "",
  "- Hand any task with two or more independent parts to a sub-agent.",
  "- Never claim a test passed without showing the output.",
  "- Ask before installing a dependency that is not already in the manifest.",
  "",
].join("\n")

/** Path instruksi yang sudah diresolusi, dalam urutan config. */
export function instructionPaths(config: Config, cwd: string): string[] {
  return config.instructions.map((entry) => {
    const raw = typeof entry === "string" ? entry : entry.path
    return path.resolve(cwd, raw.replace(/^~(?=$|\/)/, os.homedir()))
  })
}

export interface Scaffolded {
  /** Berkas instruksi yang baru dibuat. */
  files: string[]
  /** Direktori skill yang baru dibuat. */
  dirs: string[]
}

export function scaffoldedAnything(result: Scaffolded): boolean {
  return result.files.length > 0 || result.dirs.length > 0
}

/**
 * Membuat yang belum ada, membiarkan yang sudah ada.
 *
 * Kegagalan menulis TIDAK dilempar. Kalau direktorinya read-only atau path-nya
 * mustahil, sesi tetap harus jalan — sama seperti pembacaannya yang juga tidak
 * pernah menggagalkan sesi. Yang hilang cuma berkasnya, dan itu keadaan yang
 * sudah berlaku sebelum fungsi ini ada.
 */
export function ensureDeclared(config: Config, cwd: string): Scaffolded {
  const files: string[] = []
  const dirs: string[] = []

  for (const file of instructionPaths(config, cwd)) {
    if (fs.existsSync(file)) continue
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, INSTRUCTION_TEMPLATE)
      files.push(file)
    } catch {
      // Sengaja diam: lihat komentar fungsi.
    }
  }

  /*
   * Hanya direktori skill yang DIDAFTARKAN user (`configSources`), bukan hasil
   * auto-deteksi. `~/.claude/skills` milik Claude Code, dan Titah tidak berhak
   * membuat direktori di wilayah alat lain hanya karena ia mengintip ke sana.
   */
  for (const source of configSources(config, cwd)) {
    if (fs.existsSync(source.root)) continue
    try {
      fs.mkdirSync(source.root, { recursive: true })
      dirs.push(source.root)
    } catch {
      // idem
    }
  }

  return { files, dirs }
}

/** Kabar untuk user, atau `undefined` kalau tidak ada yang dibuat. */
export function scaffoldNotice(result: Scaffolded, cwd: string): string | undefined {
  if (!scaffoldedAnything(result)) return undefined

  const short = (full: string) => path.relative(cwd, full) || full
  const parts: string[] = []
  if (result.files.length > 0) {
    parts.push(`instruction file${result.files.length === 1 ? "" : "s"}: ${result.files.map(short).join(", ")}`)
  }
  if (result.dirs.length > 0) {
    parts.push(`skill folder${result.dirs.length === 1 ? "" : "s"}: ${result.dirs.map(short).join(", ")}`)
  }

  return `Created what the config declared but did not exist — ${parts.join(" · ")}. Edit them and they take effect next turn.`
}
