import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { discoverSkills, skillByName, skillCatalog } from "./skill.ts"

/**
 * Urutan file instruksi (Q13): AGENTS.md → CLAUDE.md → TITAH.md.
 *
 * AGENTS.md sebagai utama karena itu konvensi lintas-tool, CLAUDE.md sebagai
 * kompatibilitas, TITAH.md sebagai override khusus Titah. Biayanya nyaris nol
 * dan langsung membuat Titah berguna di repo yang sudah ada.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "TITAH.md"] as const

const BASE_PROMPT = `You are Titah, a coding agent running in the user's terminal.

You work inside a project directory and have tools to explore it. Use them to
establish facts — never guess file contents, directory structure, or symbol
names. If you have not read it, you do not know it.

Guidelines:
- Answer concisely. The user reads in a terminal, not a document.
- Refer to files by relative path, with line numbers where relevant
  (e.g. src/core/config.ts:42).
- If answering needs several tools, just call them — do not ask permission first.
- If a tool fails, report it as it is. Never invent file contents.
- Reply in the language the user wrote in.

Available tools:
- Reading: read, list, glob, grep
- Changing: edit, write, bash

About the changing tools:
- Read a file before editing it. \`edit\` matches text character for character;
  guessing at contents will always fail.
- Use \`edit\` for small changes, \`write\` only for new files or full rewrites.
- Every change asks the user for permission. If permission is refused, do not
  route around it with another tool — report that the change was not made.`

interface InstructionFile {
  path: string
  content: string
}

/** Mencari file instruksi dari cwd ke atas, berhenti di root git atau home. */
function discover(cwd: string): InstructionFile[] {
  const found: InstructionFile[] = []
  const home = os.homedir()
  let dir = path.resolve(cwd)

  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).isFile()) {
          found.push({ path: file, content: fs.readFileSync(file, "utf8") })
        }
      } catch {
        // tidak ada — lanjut
      }
    }
    if (fs.existsSync(path.join(dir, ".git"))) break
    const parent = path.dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }

  // Yang paling dekat dengan cwd harus dibaca terakhir supaya menang.
  return found.reverse()
}

export interface BuiltPrompt {
  system: string
  sources: string[]
}

export function buildSystemPrompt(config: Config, cwd: string, agentID?: string): BuiltPrompt {
  const files = discover(cwd)

  for (const extra of config.instructions) {
    const file = path.resolve(cwd, extra)
    try {
      files.push({ path: file, content: fs.readFileSync(file, "utf8") })
    } catch {
      // Path instruksi yang salah tidak boleh menggagalkan sesi.
    }
  }

  const sections = [BASE_PROMPT, `Working directory: ${path.resolve(cwd)}`]
  for (const file of files) {
    sections.push(`--- Project instructions from ${file.path} ---\n${file.content.trim()}`)
  }

  const skills = discoverSkills(config, cwd)
  const agent = agentID ? config.agent[agentID] : undefined

  if (agent?.prompt) {
    sections.push(`--- Instructions for agent "${agentID}" ---\n${agent.prompt.trim()}`)
  }

  // Skill yang ditugaskan ke agent dimuat UTUH; sisanya cukup dikatalogkan,
  // karena memuat semuanya akan menghabiskan context window sebelum kerja dimulai.
  const assigned = (agent?.skills ?? [])
    .map((name) => skillByName(skills, name))
    .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)

  for (const skill of assigned) {
    sections.push(`--- Skill: ${skill.name} ---\n${skill.body}`)
  }

  const rest = skills.filter((skill) => !assigned.includes(skill))
  if (rest.length > 0) {
    sections.push(
      `--- Available skills (ask the user to run /skills for details) ---\n${skillCatalog(rest)}`,
    )
  }

  return {
    system: sections.join("\n\n"),
    sources: [...files.map((file) => file.path), ...assigned.map((skill) => skill.file)],
  }
}
