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

/**
 * Urutan file instruksi (Q13): AGENTS.md → CLAUDE.md → TITAH.md.
 *
 * AGENTS.md sebagai utama karena itu konvensi lintas-tool, CLAUDE.md sebagai
 * kompatibilitas, TITAH.md sebagai override khusus Titah. Biayanya nyaris nol
 * dan langsung membuat Titah berguna di repo yang sudah ada.
 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "TITAH.md"] as const

export interface InstructionFile {
  path: string
  content: string
}

/**
 * Mencari file instruksi dari cwd ke atas, berhenti di root git atau home.
 *
 * Tinggal di sini, bukan di `prompt.ts`, karena SATU pencarian ini menjawab dua
 * pertanyaan yang harus sepakat: "apa yang dibaca ke system prompt" dan "apakah
 * proyek ini sudah punya instruksi sama sekali". Kalau yang kedua dijawab
 * pencarian terpisah, Titah bisa membuat AGENTS.md di repo yang sebenarnya
 * sudah punya CLAUDE.md — dua berkas instruksi yang bisa saling bertentangan,
 * dibuat oleh alat yang seharusnya membacanya.
 */
export function findInstructionFiles(cwd: string): InstructionFile[] {
  /*
   * Dikumpulkan PER DIREKTORI, lalu urutan direktorinya yang dibalik.
   *
   * Versi sebelumnya membalik daftar datarnya, dan itu ikut membalik urutan
   * di DALAM satu direktori: AGENTS → CLAUDE → TITAH keluar sebagai TITAH →
   * CLAUDE → AGENTS. Karena yang dibaca terakhir yang menang, TITAH.md — yang
   * seluruh alasan keberadaannya adalah menjadi override khusus Titah —
   * justru kalah oleh AGENTS.md di direktori yang sama.
   *
   * Gejalanya nyaris mustahil dikenali: aturan yang ditulis khusus untuk Titah
   * diam-diam tidak berlaku, dan yang berlaku adalah aturan bersama yang tampak
   * masuk akal.
   */
  const levels: InstructionFile[][] = []
  const home = os.homedir()
  let dir = path.resolve(cwd)

  for (;;) {
    const here: InstructionFile[] = []
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).isFile()) {
          here.push({ path: file, content: fs.readFileSync(file, "utf8") })
        }
      } catch {
        // tidak ada — lanjut
      }
    }
    levels.push(here)

    if (fs.existsSync(path.join(dir, ".git"))) break
    const parent = path.dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }

  // Yang paling dekat dengan cwd harus dibaca terakhir supaya menang.
  return levels.reverse().flat()
}

/**
 * Isi awal AGENTS.md, ditulis sebagai PERTANYAAN yang harus dijawab.
 *
 * Template yang sudah berisi aturan contoh punya nasib yang bisa ditebak: ia
 * dibiarkan apa adanya, dan Titah lalu bekerja menurut aturan yang tidak pernah
 * dipilih siapa pun. Pertanyaan tidak punya nasib itu — ia jelas belum dijawab
 * selama masih berbentuk pertanyaan.
 */
const AGENTS_TEMPLATE = [
  "# AGENTS.md",
  "",
  "Read by Titah, Claude Code, and other agent CLIs at the start of every turn.",
  "Keep it short: everything here is paid for on every request.",
  "",
  "## What this project is",
  "",
  "<!-- One or two sentences. What it does, and what it is built with. -->",
  "",
  "## Commands",
  "",
  "<!-- The ones an agent needs before it can verify its own work. -->",
  "",
  "- Build:",
  "- Test:",
  "- Lint / typecheck:",
  "",
  "## Conventions",
  "",
  "<!-- Only what is NOT obvious from reading the code. Naming, layout, and",
  "     style are already visible there; the reasons behind them are not. -->",
  "",
  "## Rules",
  "",
  "<!-- Things that must always or never happen. Be specific enough to obey.",
  '     "Write good code" cannot be followed; "never commit to main" can. -->',
  "",
].join("\n")

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

  if (config.scaffold === false) return { files, dirs }

  /*
   * AGENTS.md hanya kalau proyeknya belum punya instruksi SAMA SEKALI.
   *
   * Bukan "kalau AGENTS.md belum ada". Repo yang sudah punya CLAUDE.md sudah
   * menjawab pertanyaan yang sama, dan menambahkan AGENTS.md di sebelahnya
   * menghasilkan dua berkas instruksi yang bisa saling bertentangan — dibuat
   * oleh alat yang seharusnya membacanya, bukan menambahinya.
   *
   * Pencarian yang dipakai sama persis dengan yang membacanya ke system prompt,
   * jadi "sudah punya" di sini berarti "benar-benar ikut terbaca", bukan
   * sekadar "ada berkas dengan nama itu di suatu tempat".
   */
  if (findInstructionFiles(cwd).length === 0) {
    const file = path.join(path.resolve(cwd), "AGENTS.md")
    try {
      fs.writeFileSync(file, AGENTS_TEMPLATE, { flag: "wx" })
      files.push(file)
    } catch {
      // `wx` gagal kalau berkasnya muncul di antara pengecekan dan penulisan.
      // Itu hasil yang benar: yang sudah ada tidak pernah ditimpa.
    }
  }

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
