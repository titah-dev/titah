import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { dispatchableAgents } from "./subagent.ts"
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
- Changing: edit, patch, write, move, remove, bash
- Long-running: bash_start, bash_output, bash_stop
- Checking: diagnostics
- Remembering: plan (this session), memory (this project, forever)
- Asking: question
- Web: webfetch, websearch

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

About the web tools:
- Your training data has an expiry date; the web does not. When a library's
  behaviour matters, read its current docs instead of recalling them.
- \`websearch\` gives you titles and snippets so you can pick a URL. Snippets are
  never enough to answer from — read the page with \`webfetch\` before you rely
  on it.
- Both send data outside the user's machine and both ask permission. If it is
  refused, say what you could not check rather than answering from memory as
  though you had checked.

About \`memory\` and \`question\`:
- \`memory\` is for facts that stay true and are NOT in the repository: a
  constraint, a decision and why, a dead end already tried. It is recalled into
  every request automatically, in this and every future session — you never
  read it back. Anything the code records belongs to read/grep instead, and
  anything about the task in front of you belongs to \`plan\`.
- \`question\` stops and waits for the user. Use it when the work forks on
  something only they can decide. Do not use it to ask permission to continue,
  and do not use it for anything the repository can answer. If they skip it,
  continue with your best assumption and say which assumption you made.

About the changing tools:
- Several edits to one file belong in one \`patch\` call, not several \`edit\`
  calls. It is all-or-nothing, so a file is never left half-changed.
- Run \`diagnostics\` after a batch of edits, before you say the work is done.
  Nothing else will tell you that you just introduced a type error.
- \`bash\` waits for the command to finish. For a dev server, a watcher, or a
  long build, use \`bash_start\` and keep working; read it with \`bash_output\`.
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

/**
 * Bagian roster, atau `undefined` kalau tidak ada yang bisa dipanggil.
 *
 * Dipisah jadi fungsi supaya `/tim` bisa memakai perakit yang sama untuk
 * daftarnya sendiri — dua perakit untuk satu bentuk berarti yang kedua akan
 * tertinggal saat yang pertama diperbaiki.
 */
export function rosterSection(config: Config): string | undefined {
  const ids = dispatchableAgents(config)
  if (ids.length === 0) return undefined

  const lines = ids.map((id) => {
    const description = config.agent[id]?.description
    return description ? `  ${id} — ${description}` : `  ${id}`
  })

  return [
    "--- Sub-agents you may dispatch with `task` ---",
    ...lines,
    "",
    "Hand work to one of them when it matches their description better than doing it",
    "yourself. Several calls in one step run at the same time; the ones allowed to write",
    "files are serialised for you. A sub-agent never gets more permission than you have.",
  ].join("\n")
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

  /*
   * Daftar sub-agent yang boleh dipanggil, SETIAP giliran.
   *
   * Sebelumnya daftar ini hanya dirakit di cabang `/tim`. Akibatnya tool `task`
   * ditawarkan ke model tanpa satu pun nama yang sah: ia harus menebak, dan
   * tebakan yang salah baru ketahuan setelah panggilan gagal. Deskripsi yang
   * susah payah ditulis user di config tidak pernah sampai ke tempat yang bisa
   * memakainya.
   *
   * Roster KOSONG berarti tidak ada bagian sama sekali — bukan judul dengan
   * daftar kosong di bawahnya, yang hanya mengajari model bahwa bagian ini
   * boleh diabaikan.
   */
  const roster = rosterSection(config)
  if (roster) sections.push(roster)

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
