import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { deriveNamespace, type SkillSource } from "./skill.ts"

/**
 * Menerjemahkan registry milik editor LAIN menjadi sumber skill.
 *
 * Dipisah dari skill.ts karena isinya adalah pengetahuan tentang bentuk file
 * orang lain di disk — sesuatu yang berubah karena alasan yang sama sekali tidak
 * berhubungan dengan cara Titah merender skill.
 *
 * Semua fungsi di sini mengembalikan daftar kosong ketika ada yang tidak beres.
 * Registry ini milik Claude Code dan opencode; mereka boleh mengubah formatnya
 * kapan saja, dan itu tidak boleh membuat Titah gagal menyala.
 */

function readJSON(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Folder yang ada DAN berupa direktori. */
function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function claudeSources(home = os.homedir()): SkillSource[] {
  const registry = readJSON(path.join(home, ".claude", "plugins", "installed_plugins.json"))
  if (registry === null || typeof registry !== "object") return []

  const { version, plugins } = registry as { version?: unknown; plugins?: unknown }
  // Versi asing berarti bentuknya sudah bukan yang kita pahami. Menebak isinya
  // lebih buruk daripada tidak menemukan skill sama sekali.
  if (version !== 2 || plugins === null || typeof plugins !== "object") return []

  const out: SkillSource[] = []
  for (const installs of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown }).installPath
      if (typeof installPath !== "string") continue
      const root = path.join(installPath, "skills")
      if (!directoryExists(root)) continue
      out.push({ root, namespace: deriveNamespace(root) })
    }
  }
  return out
}

/**
 * Direktori config dasar, mengikuti aturan yang sama dengan src/core/paths.ts:
 * XDG_CONFIG_HOME kalau diisi, jika tidak `<home>/.config`.
 *
 * Tanpa ini, user yang mengatur XDG_CONFIG_HOME ke tempat lain kehilangan skill
 * opencode-nya secara diam-diam — bukan cuma soal test, itu bug produksi.
 */
function xdgConfigHome(home: string): string {
  const fromEnv = process.env["XDG_CONFIG_HOME"]
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : path.join(home, ".config")
}

export function opencodeSources(home = os.homedir()): SkillSource[] {
  const config = readJSON(path.join(xdgConfigHome(home), "opencode", "opencode.json"))
  if (config === null || typeof config !== "object") return []

  const paths = (config as { skills?: { paths?: unknown } }).skills?.paths
  if (!Array.isArray(paths)) return []

  return paths
    .filter((entry): entry is string => typeof entry === "string")
    .map((root) => ({ root: path.resolve(root), namespace: deriveNamespace(root) }))
}

export function configSources(config: Config, cwd: string): SkillSource[] {
  return config.skills.paths.map((entry) => {
    const raw = typeof entry === "string" ? entry : entry.path
    const root = path.resolve(cwd, raw.replace(/^~(?=$|\/)/, os.homedir()))
    const override = typeof entry === "string" ? undefined : entry.as
    return { root, namespace: override ?? deriveNamespace(root) }
  })
}

/**
 * Sumber dalam urutan PRIORITAS: milik user lebih dulu.
 *
 * Urutan ini yang menyelesaikan bentrok id nanti — yang pertama menang, jadi
 * konfigurasi yang ditulis sendiri selalu mengalahkan hasil auto-deteksi.
 */
export function allSources(config: Config, cwd: string, home = os.homedir()): SkillSource[] {
  const auto: SkillSource[] = []
  if (config.skills.discover.includes("claude")) auto.push(...claudeSources(home))
  if (config.skills.discover.includes("opencode")) auto.push(...opencodeSources(home))
  const combined = [...configSources(config, cwd), ...auto]

  // Menaruh path yang sama persis dengan hasil auto-deteksi di `skills.paths`
  // (mis. demi override namespace) itu wajar — tapi kalau dibiarkan, direktori
  // itu dipindai dua kali dan setiap skill di dalamnya "bentrok dengan dirinya
  // sendiri" di buildSkillIndex. Menyisakan kemunculan PERTAMA saja
  // mempertahankan urutan prioritas di atas: milik user datang lebih dulu di
  // `combined`, jadi dialah yang tersisa.
  const seen = new Set<string>()
  return combined.filter((source) => {
    const key = path.resolve(source.root)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
