import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { buildSkillIndex, skillById, skillCatalog, type Skill } from "./skill.ts"

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
- Remembering: plan

About \`plan\`:
- Your conversation is summarised automatically once it grows long, including
  in the middle of a turn. Anything that lives only in the transcript can be
  compressed away. The plan is not: it is stored separately and prepended to
  every request unchanged.
- So for work of more than a few steps, write the plan there first and work from
  it. It is the only memory you have that a long turn cannot eat.
- Update it as steps complete. A plan still listing a finished step makes you
  redo work; one missing a pending step makes you skip it silently.
- It is a whole document, replaced on every call — send all of it, not a diff.
  Keep it short enough that rewriting it is cheap.

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

  const index = buildSkillIndex(config, cwd)
  const agent = agentID ? config.agent[agentID] : undefined

  if (agent?.prompt) {
    sections.push(`--- Instructions for agent "${agentID}" ---\n${agent.prompt.trim()}`)
  }

  // `always` berlaku untuk semua agent; `agent.skills` menambahkan yang khusus
  // agent ini. Keduanya dimuat UTUH — sisanya cukup dikatalogkan, karena memuat
  // semuanya menghabiskan context window sebelum kerja dimulai.
  //
  // Yang tidak ketemu dilewati tanpa suara DI SINI dengan sengaja: yang melapor
  // adalah `renderSkillReport`, yang dibaca `/skills` dan `titah doctor`.
  // Menyusun prompt bukan tempat untuk mengeluh, dan dua penghitung untuk hal
  // yang sama berarti salah satunya pasti ketinggalan zaman.
  const wanted = [...config.skills.always, ...(agent?.skills ?? [])]
  const full: Skill[] = []

  for (const id of wanted) {
    const skill = skillById(index.skills, id)
    if (skill && !full.includes(skill)) full.push(skill)
  }

  for (const skill of full) {
    sections.push(`--- Skill: ${skill.id} ---\n${skill.body}`)
  }

  const rest = index.skills.filter((skill) => !full.includes(skill))
  if (rest.length > 0) {
    sections.push(
      [
        "--- Available skills ---",
        'Call skill("<id>") to load one in full when it applies to the task.',
        skillCatalog(rest),
      ].join("\n"),
    )
  }

  return {
    system: sections.join("\n\n"),
    sources: [...files.map((file) => file.path), ...full.map((skill) => skill.file)],
  }
}
