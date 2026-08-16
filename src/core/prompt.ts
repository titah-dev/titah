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
- Delegating: task — hand a piece of work to a configured sub-agent
- Other: skill, github

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

export type Effort = "low" | "medium" | "high"

/**
 * Tingkat yang bisa dipilih, URUT dari yang paling ringkas.
 *
 * Satu daftar untuk tiga pemakai: putaran ctrl+r, validasi di server, dan
 * keterangan di layar. Tiga daftar untuk satu himpunan berarti yang ketiga akan
 * ketinggalan begitu tingkat keempat ditambahkan.
 *
 * `"default"` ikut di sini karena ia memang salah satu pilihan yang dilewati
 * putaran — bukan keadaan di luar putaran.
 */
export const EFFORTS = ["default", "low", "medium", "high"] as const

export type EffortChoice = (typeof EFFORTS)[number]

/** Tingkat berikutnya dalam putaran, kembali ke awal setelah yang terakhir. */
export function nextEffort(current: EffortChoice): EffortChoice {
  const at = EFFORTS.indexOf(current)
  return EFFORTS[(at + 1) % EFFORTS.length] as EffortChoice
}

/**
 * Penutup jawaban: satu kesimpulan setelah pekerjaannya selesai.
 *
 * # Kenapa ini ada
 *
 * Giliran yang panjang berakhir dengan keluaran tool terakhir dan satu-dua
 * kalimat. Yang hilang justru bagian yang paling mahal dihitung ulang: apa yang
 * berubah, apa yang dibuktikan, dan apa yang masih menggantung. User yang
 * membacanya besok pagi harus menyusun sendiri semua itu dari gulungan panjang.
 *
 * # Kenapa panjangnya bisa diatur, dan kenapa "kosong" bukan salah satu tingkat
 *
 * Kesimpulan yang selalu panjang berhenti dibaca; yang selalu pendek tidak
 * cukup untuk giliran besar. Jadi panjangnya jadi sumbu — TAPI tanpa nilai
 * bawaan. `undefined` berarti Titah tidak menyebut panjang sama sekali dan
 * modelnya yang menakar, persis seperti sebelum sumbu ini ada.
 *
 * Itu bukan malas memilih. Ia satu-satunya tingkat yang tidak bisa dinyatakan
 * sebagai angka: model yang menakar sendiri akan menulis dua kalimat untuk
 * perbaikan satu baris dan setengah halaman untuk migrasi — dan itu memang yang
 * benar. Angka apa pun yang kita pilih akan salah di salah satu ujungnya.
 */
const EFFORT_RULE: Record<Effort, string> = {
  low: "Keep it to one or two sentences. Only what changed and whether it works.",
  medium:
    "A short paragraph: what changed, what you verified, and anything still open. " +
    "No restating the steps — they are already on screen.",
  high:
    "Go through it properly: what changed and why this way, what you verified and how, " +
    "what you deliberately left alone, and what could still bite. Say what you are unsure " +
    "of — an analysis that only lists successes is not an analysis.",
}

export function conclusionSection(effort?: Effort): string {
  /*
   * Izin melewatkan kesimpulan HANYA berlaku di tingkat bawah.
   *
   * Diukur pada giliran sungguhan sebelum pembagian ini ada: `high` menghasilkan
   * penutup yang sama pendeknya dengan `low` untuk suntingan satu baris — klausa
   * "lewati kalau tidak ada yang disimpulkan" menang atas seluruh aturan
   * panjangnya. Masuk akal bagi model, dan salah bagi user: ia baru saja MEMILIH
   * analisa panjang, jadi Titah yang memutuskan pekerjaannya "tidak layak
   * disimpulkan" mengambil kembali pilihan yang baru diberikan.
   *
   * Di tingkat bawah kebalikannya yang benar. `default` dan `low` justru dipilih
   * supaya layar tidak penuh, dan di sana penutup wajib untuk "halo" adalah
   * persis gangguan yang ingin dihindari.
   */
  const alwaysWrite = effort === "medium" || effort === "high"

  return [
    "--- Closing the answer ---",
    "End every answer with a short conclusion, after the work is done. Not a summary of",
    "the steps — the user watched those. What it changed, whether it is verified, and what",
    "is still open.",
    "",
    effort
      ? EFFORT_RULE[effort]
      : // Tidak menyebut panjang sama sekali. Menulis "sepanjang yang perlu"
        // terdengar netral tapi tetap sebuah instruksi, dan model membacanya
        // sebagai izin untuk memanjang.
        "Let its length follow the work: a one-line fix does not need a paragraph.",
    "",
    alwaysWrite
      ? "Write it even when the change was small. The user asked for this depth; a one-line " +
        "edit still has a reason, a check, and something it did not cover. Only a bare " +
        "greeting gets nothing."
      : "Skip it entirely when there is nothing to conclude — a greeting, or a question you " +
        "answered in one line. A conclusion under a one-sentence answer is padding.",
  ].join("\n")
}

/**
 * Bagian roster, atau `undefined` kalau tidak ada yang bisa dipanggil.
 *
 * Dipisah jadi fungsi supaya `/tim` bisa memakai perakit yang sama untuk
 * daftarnya sendiri — dua perakit untuk satu bentuk berarti yang kedua akan
 * tertinggal saat yang pertama diperbaiki.
 */
export function rosterSection(config: Config): string | undefined {
  // `never` tidak mengirim rosternya sama sekali: daftar yang tidak boleh
  // dipakai tetap dibayar sebagai token di setiap permintaan.
  if (config.delegation === "never") return undefined

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
    /*
     * Kriteria yang BISA DINILAI, bukan ajakan bersyarat.
     *
     * Versi sebelumnya berbunyi "hand work to one of them when it matches their
     * description better than doing it yourself" — dan untuk tugas kecil itu
     * memang salah: membaca tiga berkas sendiri jelas lebih murah daripada
     * memanggil sub-agent. Modelnya menalar dengan benar; kalimatnya yang tidak
     * pernah memicu. Diukur pada `9router/ant`: satu delegasi dari lima
     * percobaan pada tugas yang cocok.
     */
    "Hand work to one of them when any of these is true:",
    "  - it needs reading many files, and you only need the conclusion",
    "  - it matches one of the descriptions above more closely than your own job",
    "  - two or more parts of the work do not depend on each other",
    "",
    "Several calls in one step run at the same time; the ones allowed to write files are",
    "serialised for you. A sub-agent never gets more permission than you have, and it",
    "cannot see this conversation — give it a self-contained brief.",
    ...(config.delegation === "always"
      ? ["", "This project delegates by default: if one of them fits, hand it over."]
      : []),
  ].join("\n")
}

export function buildSystemPrompt(
  config: Config,
  cwd: string,
  agentID?: string,
  /**
   * Tingkat yang dipilih user LIVE lewat ctrl+r, mengalahkan `agent.effort`.
   *
   * `"default"` bukan sekadar ketiadaan nilai — ia pilihan yang bisa ditekan,
   * dan artinya "kembalikan ke model yang menakar" walaupun config agent-nya
   * menyetel sesuatu. Tanpa nilai itu, sekali user menyetel `effort` di config
   * ia tidak akan pernah bisa kembali ke perilaku tanpa batas dari keyboard.
   */
  effortOverride?: Effort | "default",
): BuiltPrompt {
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

  /*
   * Kriteria eskalasi, apa adanya dari config.
   *
   * TIDAK diurai Titah. Satu-satunya yang bisa menilai "butuh pemahaman
   * arsitektur dulu" adalah yang sedang mengerjakan pekerjaannya, dan setiap
   * usaha menerjemahkan kalimat itu jadi aturan akan salah pada kasus yang
   * justru paling ingin ditangkap user.
   */
  if (agent?.escalate) {
    const target = config.externalAgent[agent.escalate.to]
    sections.push(
      [
        `--- Escalating to "${agent.escalate.to}" ---`,
        `You may hand work to "${agent.escalate.to}" with the \`task\` tool when:`,
        `  ${agent.escalate.when}`,
        target?.specialist ? `It is best at: ${target.specialist}` : "",
        "",
        "It is a separate agent CLI with its own model and its own tools. Give it a",
        "self-contained brief — it cannot see this conversation. Do the rest yourself.",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    )
  }

  // `always` berlaku untuk semua agent; `agent.skills` menambahkan yang khusus
  // agent ini. Keduanya dimuat UTUH — sisanya cukup dikatalogkan, karena memuat
  // semuanya menghabiskan context window sebelum kerja dimulai.
  //
  // Yang tidak ketemu dilewati tanpa suara DI SINI dengan sengaja: yang melapor
  // adalah `renderSkillReport`, yang dibaca `/skills` dan `titah doctor`.
  // Menyusun prompt bukan tempat untuk mengeluh, dan dua penghitung untuk hal
  // yang sama berarti salah satunya pasti ketinggalan zaman.
  /*
   * Penutup jawaban, dan siapa yang menentukan panjangnya.
   *
   * Urutannya: pilihan LIVE user (ctrl+r) mengalahkan `agent.effort`. Yang
   * ditekan barusan harus menang atas yang ditulis kemarin — kalau tidak,
   * sakelarnya terasa rusak pada agent yang kebetulan punya `effort` di config.
   *
   * `"default"` dipetakan ke `undefined`, bukan dilewati: ia PILIHAN untuk
   * kembali ke model yang menakar sendiri, bukan ketiadaan pilihan.
   */
  const effort = effortOverride === "default" ? undefined : (effortOverride ?? agent?.effort)
  sections.push(conclusionSection(effort))

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
