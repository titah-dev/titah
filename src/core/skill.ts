import fs from "node:fs"
import path from "node:path"
import type { Config } from "./schema.ts"

/**
 * Skill = file markdown yang dimuat ke konteks saat dipanggil (Q26).
 *
 * Dua tata letak didukung, karena keduanya sudah dipakai di lapangan:
 *   <dir>/<nama>/SKILL.md   (tata letak superpowers/Claude Code)
 *   <dir>/<nama>.md         (satu file per skill)
 */

export interface Skill {
  name: string
  description: string
  body: string
  file: string
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

function readSkill(file: string, fallbackName: string): Skill | undefined {
  let content: string
  try {
    content = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const { fields, body } = parseFrontmatter(content)
  return {
    name: fields["name"] ?? fallbackName,
    description: fields["description"] ?? "",
    body: body.trim(),
    file,
  }
}

export function discoverSkills(config: Config, cwd: string): Skill[] {
  const found = new Map<string, Skill>()

  for (const dir of config.skills.paths) {
    const root = path.resolve(cwd, dir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue // path skill yang salah tidak boleh menggagalkan sesi
    }

    for (const entry of entries) {
      const skill = entry.isDirectory()
        ? readSkill(path.join(root, entry.name, "SKILL.md"), entry.name)
        : entry.name.endsWith(".md")
          ? readSkill(path.join(root, entry.name), entry.name.replace(/\.md$/, ""))
          : undefined
      // Path yang lebih awal menang, supaya urutan di config berarti sesuatu.
      if (skill && !found.has(skill.name)) found.set(skill.name, skill)
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function skillByName(skills: Skill[], name: string): Skill | undefined {
  return skills.find((skill) => skill.name === name)
}

/** Katalog satu baris per skill, cukup untuk model tahu apa yang tersedia. */
export function skillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return ""
  return skills
    .map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`)
    .join("\n")
}
