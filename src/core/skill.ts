import fs from "node:fs"
import path from "node:path"
import type { Config } from "./schema.ts"
import { allSources } from "./skill-sources.ts"

/**
 * Skill = file markdown yang dimuat ke konteks saat dipanggil (Q26).
 *
 * Dua tata letak didukung, karena keduanya sudah dipakai di lapangan:
 *   <dir>/<nama>/SKILL.md   (tata letak superpowers/Claude Code)
 *   <dir>/<nama>.md         (satu file per skill)
 */

export interface Skill {
  /** `namespace:name` — satu-satunya bentuk yang dipakai memanggil skill. */
  id: string
  namespace: string
  name: string
  description: string
  body: string
  file: string
}

/** Satu direktori skill beserta namespace yang mewakilinya. */
export interface SkillSource {
  root: string
  namespace: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Parser frontmatter YAML seadanya: cukup untuk `name:` dan `description:`. */
export function parseFrontmatter(content: string): {
  fields: Record<string, string>
  body: string
} {
  const match = FRONTMATTER.exec(content)
  if (!match) return { fields: {}, body: content }

  const fields: Record<string, string> = {}
  for (const line of (match[1] as string).split("\n")) {
    const separator = line.indexOf(":")
    if (separator <= 0 || /^\s/.test(line)) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1")
    if (key !== "") fields[key] = value
  }
  return { fields, body: content.slice(match[0].length) }
}

/**
 * `requireFrontmatter` membedakan `SKILL.md` dari `<nama>.md` longgar: yang
 * pertama sudah dinyatakan skill oleh LOKASI-nya (namanya sendiri jadi nama
 * skill kalau frontmatter kosong), tapi yang kedua berbagi folder dengan
 * dokumen biasa seperti README.md — frontmatter satu-satunya sinyal bahwa
 * file itu memang dimaksudkan sebagai skill, bukan dokumentasi.
 */
function readSkill(
  file: string,
  fallbackName: string,
  namespace: string,
  options: { requireFrontmatter?: boolean } = {},
): Skill | undefined {
  let content: string
  try {
    content = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  if (options.requireFrontmatter === true && !FRONTMATTER.test(content)) return undefined

  const { fields, body } = parseFrontmatter(content)
  const name = fields["name"] ?? fallbackName
  return {
    id: `${namespace}:${name}`,
    namespace,
    name,
    description: fields["description"] ?? "",
    body: body.trim(),
    file,
  }
}

/**
 * Menentukan namespace sebuah direktori skill.
 *
 * Manifes plugin menang karena ia otoritatif. Kalau tidak ada, nama folder
 * dipakai — kecuali foldernya bernama `skills`, yang tidak memberi tahu apa pun,
 * sehingga induknya yang dipakai. Aturan terakhir itu yang menghasilkan
 * "opencode" untuk ~/.config/opencode/skills.
 */
export function deriveNamespace(root: string): string {
  const resolved = path.resolve(root)

  // Manifes bisa berada di direktori skill atau di akar paket di atasnya.
  for (const candidate of [resolved, path.dirname(resolved)]) {
    try {
      const raw = fs.readFileSync(path.join(candidate, ".claude-plugin", "plugin.json"), "utf8")
      const name = (JSON.parse(raw) as { name?: unknown }).name
      if (typeof name === "string" && name.trim() !== "") return name.trim()
    } catch {
      // Tanpa manifes bukan kesalahan — sebagian besar folder skill memang tidak punya.
    }
  }

  const base = path.basename(resolved)
  return base === "skills" ? path.basename(path.dirname(resolved)) : base
}

/** Semua skill di dalam satu sumber, dipindai sampai ke sub-direktori terdalam. */
export function scanSource(source: SkillSource): Skill[] {
  const out: Skill[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return // pagar terhadap symlink yang berputar

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // path skill yang salah tidak boleh menggagalkan sesi
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const skill = readSkill(path.join(full, "SKILL.md"), entry.name, source.namespace)
        if (skill) out.push(skill)
        // Tetap turun: `skills/productivity/` bukan skill, ia hanya wadah.
        else walk(full, depth + 1)
      } else if (entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        // Longgar berarti berbagi folder dengan dokumen biasa (README.md,
        // CHANGELOG.md, ...) — tanpa frontmatter, tidak ada cara membedakan
        // dokumentasi dari skill selain menolak yang tidak mendeklarasikan diri.
        const skill = readSkill(full, entry.name.replace(/\.md$/, ""), source.namespace, {
          requireFrontmatter: true,
        })
        if (skill) out.push(skill)
      }
    }
  }

  walk(path.resolve(source.root), 0)
  return out
}

export interface SkillConflict {
  id: string
  /** File yang dipakai. */
  kept: string
  /** File yang dikalahkan. */
  dropped: string
}

export interface SkillIndex {
  skills: Skill[]
  conflicts: SkillConflict[]
  /** Root sumber yang tidak menghasilkan skill sama sekali — typo, izin, atau memang kosong. */
  emptySources: string[]
}

/**
 * Seluruh skill yang terlihat, beserta bentrok yang terjadi saat menyusunnya.
 *
 * Konflik dikembalikan, bukan dibuang, supaya `/skills` dan `titah doctor` bisa
 * menunjukkannya. Bentrok yang senyap berarti skill yang dipanggil user bisa
 * berganti sendiri begitu ada plugin baru terpasang.
 *
 * `emptySources` dicatat untuk alasan yang sama: `scanSource` sengaja menelan
 * direktori yang salah ketik atau tidak terbaca supaya sesi tetap berjalan,
 * tapi itu berarti hasilnya tidak dibedakan dari "sumbernya memang kosong" —
 * satu-satunya cara user tahu path-nya salah adalah kalau sesuatu di luar
 * scanSource ikut melaporkan sumber mana yang nihil.
 */
export function buildSkillIndex(config: Config, cwd: string, home?: string): SkillIndex {
  const found = new Map<string, Skill>()
  const conflicts: SkillConflict[] = []
  const emptySources: string[] = []

  for (const source of allSources(config, cwd, home)) {
    const skills = scanSource(source)
    if (skills.length === 0) emptySources.push(source.root)

    for (const skill of skills) {
      const existing = found.get(skill.id)
      if (existing) {
        conflicts.push({ id: skill.id, kept: existing.file, dropped: skill.file })
        continue
      }
      found.set(skill.id, skill)
    }
  }

  return {
    skills: [...found.values()].sort((a, b) => a.id.localeCompare(b.id)),
    conflicts,
    emptySources,
  }
}

export function discoverSkills(config: Config, cwd: string): Skill[] {
  return buildSkillIndex(config, cwd).skills
}

/** Cocok hanya lewat id lengkap (`namespace:name`) — nama telanjang tidak pernah dipakai. */
export function skillById(skills: Skill[], id: string): Skill | undefined {
  return skills.find((skill) => skill.id === id)
}

/**
 * Isi skill sebagaimana dilihat model.
 *
 * Pembungkus `<skill>` bukan hiasan: peringkas `/compact` memakainya untuk
 * mencatat "skill X dimuat" alih-alih menyalin ulang seluruh isinya ke ringkasan.
 */
export function renderSkill(skill: Skill, args = ""): string {
  const block = `<skill name="${skill.id}" source="${skill.file}">\n${skill.body}\n</skill>`
  return args.trim() === "" ? block : `${block}\n\n${args.trim()}`
}

/** Katalog satu baris per skill, dengan id lengkap karena itu yang harus diketik user. */
export function skillCatalog(skills: Skill[]): string {
  return skills
    .map((skill) => `- ${skill.id}${skill.description ? `: ${skill.description}` : ""}`)
    .join("\n")
}

/**
 * Ringkasan keadaan skill untuk `titah doctor` dan `/skills`.
 *
 * Tiga hal ditampilkan di sini karena ketiganya dilewati diam-diam saat sesi
 * berjalan — kalau tidak pernah muncul di mana pun, user tidak punya cara
 * menemukan konfigurasinya salah: id kembar (konflik), nama `always` yang
 * tidak pernah cocok dengan skill apa pun, dan path di `skills.paths` yang
 * tidak menghasilkan satu skill pun (salah ketik, izin, atau memang kosong).
 */
export function renderSkillReport(config: Config, cwd: string, home?: string): string {
  const index = buildSkillIndex(config, cwd, home)
  const perNamespace = new Map<string, number>()
  for (const skill of index.skills) {
    perNamespace.set(skill.namespace, (perNamespace.get(skill.namespace) ?? 0) + 1)
  }

  const lines = [`Skills: ${index.skills.length} from ${perNamespace.size} namespaces`]
  for (const [namespace, count] of [...perNamespace].sort()) {
    lines.push(`  ${namespace.padEnd(24)} ${count} skill${count === 1 ? "" : "s"}`)
  }

  if (index.conflicts.length > 0) {
    lines.push(`  ${index.conflicts.length} conflict${index.conflicts.length === 1 ? "" : "s"}:`)
    for (const conflict of index.conflicts) {
      lines.push(`    ${conflict.id}: kept ${conflict.kept}, ignored ${conflict.dropped}`)
    }
  }

  if (index.emptySources.length > 0) {
    lines.push(`  sources with no skills: ${index.emptySources.join(", ")}`)
  }

  const missing = config.skills.always.filter((id) => !skillById(index.skills, id))
  if (missing.length > 0) {
    lines.push(`  always, not found: ${missing.join(", ")}`)
  }

  return lines.join("\n")
}
