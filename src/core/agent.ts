import crypto from "node:crypto"
import {
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai"
import { loadConfig } from "./config.ts"
import type { Config } from "./schema.ts"
import { bus } from "./event.ts"
import type { Message, Part, Session, ToolState } from "./message.ts"
import { buildSystemPrompt, type Effort } from "./prompt.ts"
import { ensureDeclared, scaffoldNotice } from "./scaffold.ts"
import { hasOpenWork } from "./plan-progress.ts"
import {
  contextWindowFor,
  resolveModel,
  summariserModelFor,
  summariserWindowFor,
  turnModelFor,
  providerNpmFor,
} from "./provider.ts"
import { buildCachedRequest, shouldCache } from "./cag.ts"
import { loadMcpTools } from "./mcp.ts"
import { diagnoseFile, formatFile, renderDiagnostics } from "./lsp.ts"
import { loadPlugins, runAfter, runBefore, type LoadedPlugin } from "./plugin.ts"
import { throttleProgress } from "./progress.ts"
import { clearLoopWindow, noteCall } from "./loop.ts"
import { relative, resolveInside } from "./tool/types.ts"
import { askUser, NoOneToAsk } from "./question.ts"
import { setQuestionAsker } from "./tool/question.ts"
import { BUILD_MODES, setPlanExiter } from "./tool/exit-plan.ts"
import { autoCompact } from "./auto-compact.ts"
import { adapterFor, parseMention, listAgents, type Mention } from "./delegate/index.ts"
import { parseCommand, resolveCommand, isBuiltin, isSkillCommand, listCommands } from "./command.ts"
import { runConsensus, synthesizerFor } from "./consensus.ts"
import {
  growthTokens,
  messageBytes,
  MID_TURN_KEEP,
  overBudget,
  planCompaction,
  projectedContext,
  renderMessage,
  renderTranscript,
  summariseInChunks,
  summariserChunkBytes,
  tailBudgetBytes,
  wrapSummary,
} from "./compact.ts"
import {
  discoverSkills,
  renderSkill,
  renderSkillReport,
  skillById,
  skillCommandMessage,
} from "./skill.ts"
import {
  ask,
  clearTurn,
  effectivePermission,
  inheritedPermission,
  narrower,
  setAutoApprove,
  type EffectivePermission,
} from "./permission.ts"
import { externalSessionFor, rememberExternalSession } from "./storage/external.ts"
import { take } from "./snapshot.ts"
import { storeOutput } from "./storage/blob.ts"
import {
  appendModelMessages,
  lastContextTokens,
  latestCompaction,
  listModelRows,
  saveCompaction,
  createMessage,
  getSession,
  listModelMessages,
  readPlan,
  splitModelRequest,
  saveMessage,
  touchSession,
} from "./storage/session.ts"
import { allTools } from "./tool/index.ts"
import type { TitahTool } from "./tool/index.ts"
import { dispatchableAgents, teamAgents, teamSkipped } from "./subagent.ts"

/** Batas langkah bawaan, dipakai agent yang tidak menyatakan `steps` sendiri. */
/**
 * Plafon langkah ketika tidak ada anggaran token yang bisa dipakai.
 *
 * Naik dari 20, dan angkanya diukur bukan ditebak: dari 68 giliran nyata,
 * 13,2% mentok di 20 — sebarannya meluruh mulus dari 1 sampai 16 lalu MENUMPUK
 * di 19–20. Itu tembok, bukan sebaran alami. Ekor alaminya tipis (12, 14, dan
 * 16 langkah masing-masing hanya satu giliran), jadi 40 menutupnya dengan
 * kelonggaran.
 *
 * TIDAK dinaikkan lebih jauh, dan alasannya bukan biaya. Angka ini hanya
 * berlaku saat `contextWindow` model TIDAK dideklarasikan — dan tanpa itu
 * pemadatan otomatis juga mati. Giliran seratus langkah di sana akan meluapkan
 * jendela model dan gagal dengan error provider yang jauh lebih sulit dibaca
 * daripada "berhenti di batas". Selama jendelanya tidak diketahui, berhenti
 * lebih awal memang jawaban yang benar.
 */
const MAX_STEPS = 40

/**
 * Batas langkah ketika `limits.turnTokens` disetel.
 *
 * Tinggi dengan sengaja: begitu ada anggaran token, langkah berhenti jadi
 * kebijakan dan tinggal jadi jaring patologi. 200 cukup jauh untuk tidak pernah
 * tersentuh oleh pekerjaan yang wajar, dan cukup dekat untuk menghentikan
 * sesuatu yang benar-benar rusak sebelum ia berputar semalaman.
 */
const STEP_BACKSTOP = 200

/**
 * Anggaran giliran bawaan, sebagai KELIPATAN jendela model.
 *
 * # Kenapa relatif, bukan angka
 *
 * Anggaran absolut apa pun salah untuk salah satu ujung: 500.000 token adalah
 * empat giliran penuh di model 131k dan lima belas giliran di model 32k. Yang
 * sebanding antar model bukan jumlah tokennya, melainkan berapa kali isi
 * jendela boleh dikirim ulang — dan itulah yang sebenarnya menentukan berapa
 * langkah sebuah giliran dapat.
 *
 * Ini juga menjawab keberatan yang membuat sumbu ini lahir tanpa bawaan sama
 * sekali: Titah tidak tahu harga model dan kantong user, jadi ia tidak boleh
 * memilih angka rupiah. Tapi ia TAHU jendelanya — user sendiri yang
 * mendeklarasikannya — jadi ia boleh memilih angka yang diturunkan darinya.
 *
 * # Kenapa lima
 *
 * Diukur: pada `9router/ant` satu langkah memakan ~15.000 token, dan tembok 20
 * langkah memotong 13% giliran. Ekor alaminya mencapai sekitar 40 langkah, yang
 * berarti ~600.000 token — 4,6 kali jendela 131k. Lima menutupnya dengan
 * sedikit kelonggaran, tanpa membuka pintu ke giliran yang berjalan berjam-jam.
 *
 * # Kenapa `undefined` kalau jendelanya tidak diketahui
 *
 * Tidak ada yang bisa diturunkan dari sesuatu yang tidak dinyatakan, dan
 * menebaknya persis kesalahan yang `contextWindow` sendiri menolak lakukan.
 * Di sana `MAX_STEPS` yang menjaga.
 */
const TURN_BUDGET_WINDOWS = 5

function derivedTurnBudget(contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined) return undefined
  return contextWindow * TURN_BUDGET_WINDOWS
}

/**
 * Yang dikirim ke model pada giliran lanjutan.
 *
 * Menunjuk ke RENCANA, bukan mengulang permintaan asli. Mengulang teks aslinya
 * membuat model memulai dari nol — membaca ulang berkas yang sudah dibaca,
 * merencanakan ulang yang sudah direncanakan. Rencananya sudah memuat apa yang
 * tersisa, dan ia satu-satunya bagian yang dijamin utuh menyeberangi batas
 * giliran.
 *
 * Diawali penyebutan Titah dengan sengaja. Kalimat ini masuk ke `model_message`
 * dan akan terbaca lagi di giliran-giliran berikutnya; tanpa penanda, model
 * membacanya sebagai perintah yang pernah diketik user — dan itu tidak benar.
 * Bentuknya mengikuti `planPair`, yang juga menjelaskan asal-usulnya sendiri di
 * dalam teksnya.
 */
const CONTINUE_TEXT =
  "[titah] Your previous turn stopped at a limit, not because the work was done. " +
  "Continue the unfinished items in your plan. Do not restart work that is already " +
  "checked off. Update the plan as you complete each item."

/** Token yang sudah dibayar giliran ini: input + output, lintas semua langkah. */
function tokensSpent(steps: readonly { usage: LanguageModelUsage }[]): number {
  let total = 0
  for (const step of steps) {
    total += (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0)
  }
  return total
}

/** Ongkos langkah TERAKHIR, dipakai memperkirakan apakah satu langkah lagi muat. */
function lastStepCost(steps: readonly { usage: LanguageModelUsage }[]): number {
  const last = steps.at(-1)
  if (!last) return 0
  return (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0)
}

/**
 * Yang dikatakan ke model pada langkah terakhir.
 *
 * Ditulis sebagai kabar, bukan perintah kerja: yang diminta bukan "selesaikan
 * sekarang" — itu mustahil dan hanya menghasilkan klaim palsu — melainkan
 * berhenti dengan JUJUR. Giliran yang berakhir dengan "sisanya: X, Y" bisa
 * dilanjutkan; yang berakhir terpotong di tengah kalimat harus ditebak dulu
 * sampai mana ia sempat.
 */
const LAST_STEP_NOTE = [
  "--- last step ---",
  "You have reached this turn's step limit. No tools are available now, so this",
  "is your final message.",
  "",
  "Do not pretend the work is finished. Close by stating, in this order:",
  "  1. what you actually completed and verified",
  "  2. what you had started but did not finish",
  "  3. the exact next step, specific enough to resume from",
  "",
  "If you wrote a plan, update your account of it here — the next turn reads the",
  "plan, not this transcript.",
].join("\n")

/**
 * Ditambahkan ke system prompt HANYA untuk /tim. Sengaja tidak menyebut nama
 * agent satu per satu di sini — daftarnya berubah per config, dan menaruhnya
 * di prompt statis berarti dua sumber kebenaran yang bisa saling menyimpang.
 * `buildTeamPrompt` di bawah menempelkan roster sungguhan setelah teks ini.
 */
const TEAM_PROMPT = [
  "For this turn you are coordinating a team of SUPER AGENTS — other agent CLIs, each with",
  "its own model and its own strengths. Split the work by what each one is best at and",
  "dispatch them with the `task` tool; several calls in one step run at the same time.",
  "",
  "They are not Titah's own sub-agents: Titah's permission rules do not reach them, they",
  "have their own tools, and they will edit files on their own judgement. Give each one a",
  "self-contained brief — they cannot see this conversation.",
  "",
  "Do the work that is left over yourself rather than inventing an agent for it.",
].join("\n")

/** Ditunjukkan saat `/tim` dipanggil tanpa satu pun agent yang bisa dibawahi. */
const NO_ROSTER_MESSAGE =
  "No super agents are ready for /tim. Register one under `externalAgent` in titah.json, " +
  "with a `specialist` describing what it is best at — for example:\n\n" +
  '  "externalAgent": {\n' +
  '    "claude": {\n' +
  '      "command": "claude",\n' +
  '      "specialist": "deep architectural reasoning, cross-module refactors"\n' +
  "    }\n" +
  "  }\n\n" +
  "Run `titah doctor` for ready-made blocks for the CLIs found on this machine. " +
  "/tim dispatches only super agents; to coordinate Titah's own agents, just ask — " +
  "they are already listed in every turn."

/**
 * TEAM_PROMPT saja — rosternya TIDAK diulang di sini.
 *
 * Sejak roster masuk ke system prompt setiap giliran (`rosterSection` di
 * prompt.ts), mencantumkannya lagi berarti model membaca daftar yang sama dua
 * kali dalam satu permintaan. Yang ditambahkan `/tim` hanyalah instruksi untuk
 * MEMBAGI pekerjaan, yang memang tidak berlaku di giliran biasa.
 */
function buildTeamPrompt(config: Config, roster: string[], skipped: { id: string; why: string }[]): string {
  const lines = roster.map((id) => `  ${id} — ${config.externalAgent[id]?.specialist ?? ""}`)
  const parts = [TEAM_PROMPT, "", "Super agents you can dispatch with `task`:", ...lines]

  /*
   * Yang dilewati DISEBUTKAN, kepada model maupun lewat notice.
   *
   * Super agent yang terdaftar tapi diam-diam tidak dipakai adalah kegagalan
   * yang paling membingungkan: user melihat namanya di config, tidak melihatnya
   * bekerja, dan tidak ada apa pun yang menjelaskan kenapa.
   */
  if (skipped.length > 0) {
    parts.push("", `Not available this turn: ${skipped.map((entry) => entry.id).join(", ")}.`)
  }
  return parts.join("\n")
}

/**
 * Sesi yang sudah diberi tahu bahwa modelnya sempat berputar.
 *
 * Sekali per sesi, pola yang sama dengan peringatan auto-compaction di bawah:
 * kabar yang terulang setiap langkah berhenti dibaca justru ketika ia mulai
 * berarti.
 */
const loopNoticed = new Set<string>()

function noteLoop(sessionID: string, tool: string, streamSessionID: string): void {
  if (loopNoticed.has(sessionID)) return
  loopNoticed.add(sessionID)
  bus.publish({
    type: "session.notice",
    sessionID: streamSessionID,
    message:
      `The model repeated the same "${tool}" call. This mode does not stop for that ` +
      "(doom_loop is allowed), so it will keep going — press Esc if it is stuck.",
  })
}

export class AgentError extends Error {}

/** Satu turn berjalan per sesi. Dipakai `abort()` dan penolakan prompt ganda. */
const running = new Map<string, AbortController>()

/**
 * Sesi yang sudah diberi tahu bahwa auto-compaction mati untuk model ini.
 *
 * Sekali per sesi, bukan sekali per giliran: ini fakta konfigurasi yang tidak
 * berubah di tengah jalan, dan mengulanginya tiap giliran berubah dari
 * informasi menjadi gangguan yang orang latih diri untuk abaikan.
 */
const noticed = new Set<string>()

/**
 * Sesi yang sudah diperiksa kelengkapan berkasnya.
 *
 * Sekali per sesi, bukan sekali per giliran: config tidak berubah di tengah
 * sesi, dan menyentuh disk tiap giliran adalah ongkos tanpa imbalan.
 */
const scaffolded = new Set<string>()

/**
 * Peringatan sekali-per-sesi bahwa jendela konteks model belum dideklarasikan.
 *
 * Tanpa ini "mati diam-diam" — persis yang tabel keputusan spesifikasi ini
 * tolak — karena `titah doctor` hanya dibaca orang yang sudah curiga, dan
 * satu-satunya gejala lain adalah sesi yang mati di tengah kerja.
 */
function warnUndeclaredWindow(session: Session, config: Config, modelID: string | undefined): void {
  if (config.compaction.auto !== true) return
  if (session.parentID !== undefined) return
  if (noticed.has(session.id)) return
  noticed.add(session.id)

  const named = modelID ?? config.model
  const where = named === undefined ? "" : ` for "${named}"`
  bus.publish({
    type: "session.notice",
    sessionID: session.id,
    message:
      `Automatic compaction is off${where}: no contextWindow is declared. ` +
      "Run `titah doctor` for the exact config path to add. /compact still works.",
  })
}

type ModelResolver = (config: Config, id?: string) => LanguageModel

let resolver: ModelResolver = resolveModel

/**
 * Satu-satunya jalan menyuntikkan model palsu ke dalam loop.
 *
 * Ada supaya agent loop bisa diuji secara deterministik tanpa memanggil LLM
 * sungguhan (Q25) — test yang membakar token tidak akan pernah dijalankan orang.
 * Mengembalikan fungsi pemulih.
 */
export function setModelResolver(next: ModelResolver): () => void {
  const previous = resolver
  resolver = next
  return () => {
    resolver = previous
  }
}

export function isRunning(sessionID: string): boolean {
  return running.has(sessionID)
}

/**
 * Handle pembatalan untuk sesi yang TIDAK menjalankan loop model Titah sendiri.
 *
 * `running` hanya terisi oleh `prompt()`. Sub-agent yang mesinnya CLI eksternal
 * (`delegate`) tidak pernah lewat sana, jadi `x` di panel — yang membatalkan
 * lewat sessionID ANAK — tidak menemukan apa pun untuk dihentikan: `abort()`
 * mengembalikan false, CLI-nya terus membakar kuota sampai timeout-nya sendiri,
 * dan satu-satunya jalan keluar user adalah membatalkan seluruh giliran
 * koordinator — persis yang panel ini ada untuk dihindari.
 */
const cancellable = new Map<string, AbortController>()

/** Mendaftarkan handle pembatalan sesi; mengembalikan fungsi pencabutnya. */
export function registerCancel(sessionID: string, controller: AbortController): () => void {
  cancellable.set(sessionID, controller)
  return () => {
    // Hanya mencabut milik SENDIRI: sesi anak yang dipakai ulang oleh
    // pendaftaran berikutnya tidak boleh kehilangan handle yang masih hidup.
    if (cancellable.get(sessionID) === controller) cancellable.delete(sessionID)
  }
}

/** `Esc` di TUI membatalkan SELURUH turn, bukan hanya tool yang sedang jalan (Q17). */
export function abort(sessionID: string): boolean {
  const controller = running.get(sessionID)
  const handle = cancellable.get(sessionID)
  controller?.abort()
  handle?.abort()
  return controller !== undefined || handle !== undefined
}

export interface PromptInput {
  sessionID: string
  text: string
  model?: string
  /** Nama agent internal (Q21). Mengubah prompt, model, dan tool yang tersedia. */
  agent?: string
  /**
   * Panjang kesimpulan untuk giliran ini, dipilih user lewat ctrl+r.
   *
   * Mengalahkan `agent.effort` — yang ditekan barusan menang atas yang ditulis
   * kemarin. `"default"` adalah pilihan yang sah, bukan ketiadaan pilihan: ia
   * mengembalikan penakaran ke model walau config agent-nya menyetel sesuatu.
   */
  effort?: Effort | "default"
  /** Menyetujui otomatis izin yang tidak ditolak eksplisit oleh config. */
  auto?: boolean
  /**
   * Batas atas izin, diwariskan dari giliran yang mendelegasikan ini.
   *
   * Diisi HANYA oleh `runSubagent`. Izin efektif giliran ini menjadi yang
   * paling ketat antara ini dan izin agent-nya sendiri — induk tidak pernah
   * bisa memberi lebih dari yang ia punya. Lihat `narrower`.
   */
  permissionCeiling?: EffectivePermission
  /**
   * Sudah berapa kali giliran ini dilanjutkan Titah sendiri.
   *
   * Diisi HANYA oleh `prompt()` saat ia memanggil dirinya sendiri. Ia bagian
   * dari keadaan loop, bukan sesuatu yang pantas diminta pemanggil luar —
   * server dan TUI tidak punya cara tahu berapa nilai yang benar, dan menebaknya
   * berarti batas lanjutan bisa dilewati dari luar.
   */
  continuation?: number
  /**
   * Model yang SUDAH diputuskan pemanggil, melewati `turnModelFor`.
   *
   * Dibutuhkan karena `turnModelFor` membuat `agent.<id>.model` menang atas
   * `model` biasa — dan itu memang benar untuk `-m` yang diketik user. Tapi
   * `runSubagent` memakai jalur ini justru ketika `agent.model` TIDAK BISA
   * dipakai: kalau ia tetap menang, jatuh-balik ke model induk tidak akan
   * pernah berlaku dan sub-agent gagal dengan model yang sudah diketahui rusak.
   *
   * Hanya `runSubagent` yang mengisinya.
   */
  resolvedModel?: string
}

export async function prompt(input: PromptInput): Promise<Message> {
  const session = getSession(input.sessionID)
  if (!session) throw new AgentError(`Session not found: ${input.sessionID}`)
  if (running.has(session.id)) {
    throw new AgentError("This session is already processing another turn.")
  }

  // Sesi anak tidak pernah mendapat `task`. Kedalaman tepat satu tingkat —
  // tanpa ini, satu sub-agent bisa memanggil sub-agent lagi, dan seterusnya,
  // membakar token provider user tanpa satu pun tempat untuk menghentikannya.
  const isChild = session.parentID !== undefined

  // "always" harus menutup seluruh giliran INDUK, bukan hanya sub-agent yang
  // bertanya — sama seperti `isChild`, ini dibaca dari state sesi tersimpan,
  // bukan diteruskan lewat argumen `runSubagent`, supaya tidak ada jalur yang
  // bisa lupa mengisinya.
  const allowlistSessionID = session.parentID ?? session.id

  // Konsep BEDA dari `allowlistSessionID` di atas, meski rumusnya sama pada
  // kedalaman satu tingkat yang diizinkan sistem: ini menjawab "klien mana
  // yang benar-benar mendengarkan", bukan "izin ini milik giliran siapa".
  // TUI/CLI/server hanya berlangganan stream sesi PALING ATAS — lihat
  // komentar `streamSessionID` di `AskOptions`, src/core/permission.ts.
  const streamSessionID = session.parentID ?? session.id

  const { config } = loadConfig(session.directory)

  // Delegasi diperiksa SEBELUM model di-resolve: `@claude ...` tidak butuh
  // provider Titah sama sekali, dan harus tetap jalan meski model belum diset.
  const mention = parseMention(input.text)
  if (mention) return delegateTurn(session, config, mention, input.text)

  // Command diperiksa berikutnya. Sebagian mengubah ALUR (konsensus, daftar),
  // sebagian hanya memperluas prompt lalu menempuh jalur LLM biasa.
  let text = input.text
  let agentID = input.agent ?? config.defaultAgent
  let modelOverride = input.model
  // Pesan siap-pakai untuk jalur skill: isi skill BESERTA penanda identitas
  // yang dibaca pagar "sudah dimuat". Penanda itu harus ikut ke riwayat, jadi
  // pesannya dirakit di sini sekali dan dipakai untuk mengirim maupun menyimpan.
  let skillMessage: ModelMessage | undefined
  // Ditambahkan ke system prompt HANYA oleh /tim — lihat cabangnya di bawah.
  let teamPrompt: string | undefined

  const command = parseCommand(input.text)
  if (command) {
    // Skill dipanggil langsung: `/superpowers:brainstorming pesan`. Isinya masuk
    // ke pesan yang DIKIRIM, sementara transkrip tetap menampilkan yang diketik.
    if (isSkillCommand(command.name)) {
      const skills = discoverSkills(config, session.directory)
      const skill = skillById(skills, command.name)
      if (!skill) {
        const sameNamespace = skills
          .filter((entry) => entry.namespace === command.name.split(":")[0])
          .map((entry) => `  /${entry.id}`)
        return infoTurn(
          session,
          input.text,
          sameNamespace.length > 0
            ? `Unknown skill "${command.name}". Available in that namespace:\n${sameNamespace.join("\n")}`
            : `Unknown skill "${command.name}". Run /skills to see what is available.`,
          true,
        )
      }
      text = renderSkill(skill, command.args)
      skillMessage = skillCommandMessage(skill, command.args)
    } else if (command.name === "tim") {
      // /tim TIDAK lewat `builtinTurn`: builtinTurn selalu mengembalikan Message
      // dan mengakhiri giliran di tempat, sedangkan /tim justru harus menempuh
      // giliran LLM BIASA (streamText, tool task, dst) — cuma dengan tambahan
      // di system prompt. Menyalin mesin giliran itu ke sini lagi persis jenis
      // "mesin sendiri" yang titik desainnya melarang.
      /*
       * `/tim` memakai SUPER AGENT saja, bukan agent internal Titah.
       *
       * Agent internal sudah didaftar di system prompt setiap giliran
       * (`rosterSection`), jadi mengoordinasinya tidak perlu perintah khusus —
       * cukup diminta. Yang tidak bisa diminta begitu saja adalah membagi
       * pekerjaan ke beberapa CLI agent lain sekaligus, dan itulah yang
       * disediakan perintah ini.
       */
      const roster = teamAgents(config)
      const skipped = teamSkipped(config)
      if (roster.length === 0) {
        return infoTurn(session, input.text, NO_ROSTER_MESSAGE, true)
      }
      if (command.args === "") {
        return infoTurn(session, input.text, "Usage: /tim <task>", true)
      }
      for (const entry of skipped) {
        bus.publish({
          type: "session.notice",
          sessionID: session.id,
          message: `/tim skipped "${entry.id}": ${entry.why}`,
        })
      }
      text = command.args
      teamPrompt = buildTeamPrompt(config, roster, skipped)
    } else if (isBuiltin(command.name)) {
      return builtinTurn(
        session,
        config,
        command.name,
        command.args,
        input,
        input.resolvedModel ?? turnModelFor(config, agentID, modelOverride),
      )
    } else {
      const CLI_HINT: Record<string, string> = {
        model: "From the CLI, pass --model instead. See `titah models`.",
        agent: "From the CLI, pass --agent instead. See `titah run \"/agents\"`.",
        skill: 'From the CLI, name the skill directly in your prompt. See `titah run "/skills"`.',
        session: "From the CLI, use `titah sessions list` and `titah run -s <id>`.",
        new: "From the CLI, `titah run` without -s already starts a new session.",
      }
      const hint = CLI_HINT[command.name]
      if (hint) {
        return infoTurn(
          session,
          input.text,
          `/${command.name} only works inside the TUI, where it opens a picker.\n${hint}`,
          true,
        )
      }

      const resolved = resolveCommand(config, command)
      if (!resolved) {
        return infoTurn(
          session,
          input.text,
          `Unknown command "/${command.name}".\n\n${renderCommands(config)}`,
          true,
        )
      }
      text = resolved.prompt
      agentID = resolved.agent ?? agentID
      modelOverride = resolved.model ?? modelOverride
    }
  }

  const agentDef = agentID ? config.agent[agentID] : undefined
  if (agentID && !agentDef) {
    return infoTurn(session, input.text, `Agent "${agentID}" is not defined in the config.`, true)
  }

  /*
   * SATU perhitungan model untuk giliran ini, dipakai keduanya.
   *
   * Sebelumnya ada dua yang berjalan sendiri-sendiri: `resolver(config,
   * agentDef?.model ?? modelOverride)` di sini untuk model yang benar-benar
   * dipanggil, dan `turnModelFor(...)` di bawah untuk jendela konteks serta
   * pemilihan peringkas. Keduanya kebetulan sepakat selama tidak ada yang
   * memberi model dari jalur ketiga — dan berhenti sepakat begitu
   * `resolvedModel` ada: sub-agent memakai model warisan induk untuk mengukur,
   * lalu memanggil `config.model` untuk mengerjakan.
   *
   * Kelas kesalahan yang sama dengan "yang diukur bukan yang dikirim", dan
   * obatnya sama: satu definisi, dua pemakai.
   */
  const turnModel = input.resolvedModel ?? turnModelFor(config, agentID, modelOverride)
  const model = resolver(config, turnModel)

  /*
   * Apa yang config JANJIKAN ada, dibuat sebelum prompt pertama dirakit.
   *
   * Letaknya di sini, bukan saat config dimuat, dan bukan di `titah init`.
   *
   * Bukan saat config dimuat: config dibaca puluhan kali per sesi — oleh
   * `/config`, oleh setiap sub-agent, oleh setiap pengecekan izin. Menulis ke
   * disk dari jalur yang dianggap murni akan mengejutkan setiap pemanggilnya.
   *
   * Bukan di `titah init`: config berubah sesudah init, dan sumbu yang hanya
   * disiapkan sekali seumur hidup akan berhenti berlaku persis saat user
   * menambah instruksi baru — momen yang paling ingin ditangkap.
   *
   * Jadi di sini: sekali, pada giliran PERTAMA sebuah sesi, tepat sebelum
   * `buildSystemPrompt` membaca berkas-berkas itu. Giliran kedua dan seterusnya
   * melewatinya, karena config tidak berubah di tengah sesi dan menyentuh disk
   * tiap giliran adalah ongkos tanpa imbalan.
   */
  if (!scaffolded.has(session.id)) {
    scaffolded.add(session.id)
    const made = ensureDeclared(config, session.directory)
    const notice = scaffoldNotice(made, session.directory)
    // Menulis ke disk tidak boleh terjadi diam-diam, sekalipun yang ditulis
    // persis yang diminta config.
    if (notice) bus.publish({ type: "session.notice", sessionID: session.id, message: notice })
  }

  const built = buildSystemPrompt(config, session.directory, agentID, input.effort)
  const system = teamPrompt ? `${built.system}\n\n${teamPrompt}` : built.system

  /*
   * Giliran lanjutan TIDAK menulis pesan user.
   *
   * Ia tetap butuh giliran user di PERMINTAAN — model harus menerima sesuatu
   * untuk dijawab, dan permintaan yang berakhir pada pesan assistant tidak
   * diperlakukan sama oleh setiap endpoint openai-compatible. Yang tidak ia
   * butuhkan adalah barisnya masuk tabel `message`.
   *
   * Bedanya bukan kerapian. Tabel itu yang dibaca layar DAN `promptHistory`,
   * jadi versi pertama fitur ini membuat kalimat karangan Titah muncul di
   * riwayat sebagai kalimat yang seolah user ketik — termasuk saat ia menekan
   * panah atas untuk memanggil promptnya sendiri.
   *
   * Polanya sudah ada di repo ini dan dipakai tiga kali: `planPair`,
   * `summaryPair`, dan memori semuanya mengirim pasangan user+assistant yang
   * hanya pernah dilihat model. Ini pemakai keempat, dan seharusnya sejak awal.
   *
   * Alasan lanjutannya tetap terlihat: `session.notice` yang berbunyi
   * "Continuing on its own (1 of 3)". Itu Titah berbicara sebagai Titah, bukan
   * pesan yang berpura-pura datang dari user.
   */
  const isContinuation = (input.continuation ?? 0) > 0
  if (!isContinuation) {
    const userMessage = createMessage(session.id, "user", [{ type: "text", text: input.text }])
    bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })
  }

  if (session.title === "") {
    const title = input.text.replace(/\s+/g, " ").slice(0, 80)
    const updated = touchSession(session.id, { title })
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
  }

  const assistant = createMessage(session.id, "assistant", [])
  assistant.model = agentDef?.model ?? modelOverride ?? config.model
  // Dipasang SEBELUM publish pertama, jadi penanda di layar sudah benar sejak
  // giliran muncul — bukan menyusul setelah jawaban pertama mengalir.
  if (agentID) assistant.agent = agentID
  bus.publish({ type: "message.updated", sessionID: session.id, message: assistant })

  /**
   * Apakah giliran ini berhenti karena batas, bukan karena selesai.
   *
   * Diisi dari DUA tempat, dan itu disengaja — tapi keduanya harus jadi
   * pemakai dari satu keputusan, bukan dua perhitungan yang kebetulan sepakat.
   * Lihat `budgetNearlyGone`: anggaran menghentikan giliran lewat PERKIRAAN
   * (satu langkah lagi tidak muat), sementara perbandingan telanjang
   * `spent >= budget` tidak pernah benar dalam kasus itu — 118.900 dari 120.000
   * bukan pelampauan, tapi gilirannya sudah berakhir karena ia.
   */
  let stoppedAtLimit = false
  /** Diputuskan di `finally`, dipakai dua kali: menahan `idle`, lalu melanjutkan. */
  let willContinue = false

  const controller = new AbortController()
  running.set(session.id, controller)
  if (input.auto === true) setAutoApprove(session.id, true)

  const publishSnapshot = () => {
    saveMessage(assistant)
    // Wajib disalin. `assistant` terus dimutasi sepanjang giliran, jadi
    // menyiarkan referensinya berarti setiap pelanggan in-process melihat state
    // TERAKHIR, bukan state saat event itu terjadi — snapshot "running" akan
    // berubah sendiri menjadi "completed" di tangan penerima.
    bus.publish({
      type: "message.updated",
      sessionID: session.id,
      message: structuredClone(assistant),
    })
  }

  /** Menyisipkan atau memperbarui part tool berdasarkan callID. */
  const upsertTool = (callID: string, name: string, state: ToolState) => {
    const existing = assistant.parts.find(
      (part): part is Extract<Part, { type: "tool" }> =>
        part.type === "tool" && part.callID === callID,
    )
    if (existing) existing.state = state
    else assistant.parts.push({ type: "tool", callID, tool: name, state })
    publishSnapshot()
  }

  // Ambang dibaca dari giliran SEBELUMNYA: `usage.context` pesan assistant
  // terakhir yang PUNYA angka itu. Bukan sekadar yang terakhir — giliran yang
  // gagal atau dibatalkan tidak pernah sempat mengukur apa pun, dan memakainya
  // akan mematikan pemadatan otomatis sampai ada giliran yang sukses.
  const lastMeasured = lastContextTokens(session.id)
  const modelID = turnModel
  const contextWindow = contextWindowFor(config, modelID)
  if (contextWindow === undefined) warnUndeclaredWindow(session, config, modelID)
  // Diresolusi LAMBAT: `resolver` baru dipanggil dari DALAM `autoCompact`, dan
  // hanya kalau prune saja tidak cukup sehingga ia benar-benar sampai ke
  // langkah meringkas. `smallModel` sebelum ini TIDAK PERNAH dipakai di mana
  // pun di `src/`, jadi nilai siapa pun belum pernah tervalidasi — provider
  // tak dikenal atau kredensial hilang di sana akan melempar pada SETIAP
  // giliran kalau diresolusi di sini, termasuk giliran yang tidak punya apa
  // pun untuk dipadatkan.
  //
  // `controller.signal` ikut diteruskan: peringkas ini tidak diminta user, jadi
  // satu-satunya jalan keluar dari smallModel yang menggantung adalah `Esc` —
  // dan tanpa sinyal, `Esc` melapor berhasil sementara gilirannya tetap hidup.
  // Bagian permintaan yang TIDAK ada di daftar baris, dalam byte. `autoCompact`
  // memerlukannya untuk mengukur permintaan yang akan dikirim; tanpanya
  // pengukuran itu meremehkan, dan meremehkan ukuran permintaan berarti
  // mengirim yang kebesaran.
  //
  // Dua bagian, bukan satu: system prompt, DAN pesan user giliran ini. Yang
  // kedua mudah terlewat — `autoCompact` antar-giliran berjalan SEBELUM giliran
  // ini ditulis jadi baris, jadi ia tidak ada di `current` sama sekali. Sebuah
  // paste berkas 40 KB sebagai prompt karena itu tidak terlihat oleh keputusan
  // "masih perlu diringkas?" yang justru diambil karenanya.
  const userTurn: ModelMessage = skillMessage ?? { role: "user", content: text }
  const systemBytes = Buffer.byteLength(system) + messageBytes(userTurn)
  // Model peringkas dihitung SEKALI, lalu dipakai untuk dua hal yang wajib
  // sepakat: me-resolve modelnya di bawah, dan menentukan jendela yang membatasi
  // promptnya. Dua ekspresi berbeda untuk satu keputusan adalah bug yang
  // menunggu — dan sudah terjadi sekali (lihat `summariserModelFor`).
  // `modelID`, BUKAN `input.model`: model giliran yang sebenarnya sudah memuat
  // `agentDef.model` dan override dari slash command. `subagent.ts` memanggil
  // `prompt()` tanpa `model`, jadi memakai `input.model` membuat sebuah agent yang
  // menyatakan modelnya sendiri diringkas oleh model BAWAAN — sementara jendelanya
  // datang dari model agent itu. Divergensi yang sama, lewat pintu lain.
  const summariserModel = summariserModelFor(config, modelID)
  const summariserWindow = summariserWindowFor(config, modelID)

  const summarise = (system: string, userPrompt: string): Promise<string> =>
    synthesizerFor(resolver(config, summariserModel), controller.signal)(system, userPrompt)

  try {
    try {
      await autoCompact({
        sessionID: session.id,
        compaction: config.compaction,
        contextWindow,
        lastStepTokens: lastMeasured,
        systemBytes,
        summariserWindow,
        summarise,
        focus: text,
      })
    } catch {
      // Gagal memadatkan berarti "lewati pemadatan giliran ini", bukan
      // "gagalkan giliran ini". SENGAJA tidak memakai `session.error`: event
      // itu berarti giliran GAGAL, sementara giliran ini justru lanjut dan
      // berhasil. Pembersihan `running` sendiri TIDAK bergantung pada
      // tangkapan ini — panggilan di atas berada di dalam `try` utama, jadi
      // `finally`-nya menjangkaunya apa pun yang dilempar di sini.
    }

    /*
     * CAG: permintaan dirakit stabil→volatil, dan `system` ikut MASUK sebagai
     * pesan pertama alih-alih parameter tersendiri.
     *
     * Itu bukan kosmetik. `cache_control` melekat pada blok pesan, dan system
     * prompt yang dikirim lewat parameter terpisah tidak punya tempat untuk
     * membawanya — jadi bagian terbesar dan paling stabil dari permintaan
     * justru bagian yang tidak bisa ditandai. Lihat src/core/cag.ts.
     */
    // Perulangan adalah properti SATU giliran. Membawa hitungannya lintas
    // giliran berarti user yang sengaja menjalankan perintah sama tiga kali
    // di tiga giliran akan disela seolah model macet.
    clearLoopWindow(session.id)

    const split = splitModelRequest(session.id)
    const cacheDecision = shouldCache({
      npm: providerNpmFor(config, modelID) ?? "@ai-sdk/openai-compatible",
      systemText: system,
      historyLength: split.tail.length,
    })
    const cached = buildCachedRequest({
      protectedBlock: split.protectedBlock,
      tail: [...split.tail, userTurn],
      decision: cacheDecision,
    })
    const messages: ModelMessage[] = cached.messages

    // Berapa pesan giliran ini yang SUDAH tertulis jadi baris. Pemadatan mid-turn
    // harus menuliskannya lebih dulu supaya mesin pemadatan berbasis baris bisa
    // dipakai apa adanya; tanpa penghitung ini, penulisan di akhir giliran akan
    // menduplikasi apa yang sudah tersimpan.
    let flushed = 0

    /**
     * Hasil tool TERBESAR di giliran INI, dalam token — tempat yang dipesan
     * untuk pertumbuhan satu langkah berikutnya.
     *
     * Per giliran, dan sengaja variabel lokal `prompt()`: ia tidak boleh bocor
     * ke giliran berikutnya (giliran baru mulai dari konteks yang sudah
     * dipadatkan) maupun antara sesi induk dan anaknya (mereka punya riwayat
     * dan model sendiri-sendiri).
     */
    let largestToolResult = 0

    // Per-agent, karena satu angka global tidak bisa pas untuk scout (butuh
    // sedikit iterasi) maupun refactor (butuh banyak) sekaligus.
    /*
     * Anggaran token milik giliran ini, dan batas langkah yang menyertainya.
     *
     * Urutannya disengaja: `agent.<id>.steps` yang ditulis user selalu menang.
     * Kalau tidak, menyetel anggaran token akan diam-diam membuang batas langkah
     * yang sengaja dipasang seseorang untuk agent tertentu.
     *
     * Tanpa `steps` eksplisit, adanya anggaran token menaikkan plafon langkah
     * ke `STEP_BACKSTOP`. Itu bukan bonus tersembunyi — itu maksudnya: user baru
     * saja memilih batas yang benar, jadi batas yang arbitrer minggir.
     */
    const turnBudget = config.limits.turnTokens ?? derivedTurnBudget(contextWindow)
    const maxSteps = agentDef?.steps ?? (turnBudget === undefined ? MAX_STEPS : STEP_BACKSTOP)

    /*
     * Asker dipasang PER GILIRAN, tepat sebelum tool dibangun.
     *
     * Yang dibutuhkannya semuanya milik giliran ini: berapa klien yang
     * mendengarkan, sesi mana yang stream-nya dilanggan (untuk sub-agent itu
     * sesi INDUK — lihat komentar `streamSessionID` di permission.ts), agent
     * mana yang bertanya, dan sinyal pembatalannya. Tool tidak bisa tahu satu
     * pun dari itu, dan menebaknya berarti pertanyaan sub-agent disiarkan ke
     * stream yang tidak didengarkan siapa pun lalu menggantung.
     */
    /*
     * Tool MCP dimuat SEBELUM giliran, bukan saat dibutuhkan.
     *
     * Model harus melihat daftar tool lengkap sejak permintaan pertama — tool
     * yang muncul di tengah giliran tidak akan pernah dipanggil, karena model
     * sudah memutuskan rencananya dari daftar yang ia lihat di awal.
     *
     * Server yang gagal TIDAK menjatuhkan giliran: ia kehilangan tool-nya, dan
     * user diberi tahu sekali lewat notice. Server MCP dipasang user dan bisa
     * rusak karena hal yang tidak berhubungan dengan Titah sama sekali.
     */
    const mcp = await loadMcpTools(config, session.directory)
    for (const failure of mcp.failures) {
      bus.publish({
        type: "session.notice",
        sessionID: streamSessionID,
        message: `MCP server "${failure.id}" is unavailable: ${failure.reason.split("\n")[0]}`,
      })
    }

    /*
     * Plugin, dengan aturan kegagalan yang SAMA seperti MCP: yang rusak
     * kehilangan kaitnya, sesinya tetap jalan, dan user diberi tahu sekali.
     *
     * Sesi yang menolak dimulai karena satu plugin pencatat-audit rusak
     * menghukum orang atas hal yang tidak ia minta saat itu.
     */
    const loaded = await loadPlugins(config, session.directory)
    for (const failure of loaded.failures) {
      bus.publish({
        type: "session.notice",
        sessionID: streamSessionID,
        message: `Plugin "${failure.spec}" did not load: ${failure.reason.split("\n")[0]}`,
      })
    }

    /*
     * Penawaran pindah mode memakai kanal yang SAMA dengan `question` — hanya
     * `intent`-nya berbeda, dan itu yang dibaca TUI untuk tahu bahwa jawabannya
     * adalah perintah untuk dirinya sendiri, bukan teks untuk model.
     */
    setPlanExiter(async (plan) => {
      try {
        return await askUser({
          sessionID: session.id,
          question: `You are in Plan mode, which cannot change anything.\n\n${plan}`,
          options: [...BUILD_MODES],
          listeners: bus.listenerCount(streamSessionID),
          signal: controller.signal,
          ...(agentID ? { agent: agentID } : {}),
          streamSessionID,
          intent: "switch-agent",
        })
      } catch (error) {
        // Tanpa klien tidak ada yang bisa berpindah mode. Diperlakukan sebagai
        // "tetap di Plan", bukan sebagai kegagalan — mode headless memang
        // dijalankan dengan agent yang sudah dipilih di baris perintah.
        if (error instanceof NoOneToAsk) return undefined
        throw error
      }
    })

    setQuestionAsker(async (ask) => {
      try {
        return await askUser({
          sessionID: session.id,
          question: ask.question,
          options: ask.options,
          listeners: bus.listenerCount(streamSessionID),
          signal: controller.signal,
          ...(agentID ? { agent: agentID } : {}),
          streamSessionID,
        })
      } catch (error) {
        // Tidak ada klien: JANGAN menggantung, dan jangan pula memperlakukannya
        // sebagai penolakan. `undefined` berarti "tidak dijawab", dan tool
        // menerjemahkannya jadi instruksi untuk melanjutkan dengan asumsi
        // terbaik — yang tepat untuk mode headless dan CI.
        if (error instanceof NoOneToAsk) return undefined
        throw error
      }
    })

    const result = streamText({
      model,
      system,
      messages,
      tools: buildTools({
        mcpTools: mcp.tools,
        ...(agentDef?.escalate ? { escalateTo: agentDef.escalate.to } : {}),
        ...(modelID ? { model: modelID } : {}),
        plugins: loaded.plugins,
        contextWindow,
        sessionID: session.id,
        cwd: session.directory,
        config,
        signal: controller.signal,
        upsert: upsertTool,
        permission: (() => {
          const ceiling = input.permissionCeiling
          // Tanpa induk, izin agent ini apa adanya di atas global.
          if (!ceiling) return effectivePermission(config, agentID, agentDef)
          /*
           * Dengan induk, DUA hal terjadi berurutan dan keduanya perlu:
           *
           *   1. sumbu yang tidak dinyatakan anak diambil dari INDUK, bukan
           *      dari global — kalau tidak, sub-agent di bawah `build-auto`
           *      bertanya untuk `ls` (lihat `inheritedPermission`)
           *   2. hasilnya dijepit `narrower`, jadi anak yang menyatakan lebih
           *      longgar dari induknya tetap tidak bisa melampauinya
           */
          return narrower(ceiling, inheritedPermission(ceiling, agentID, agentDef))
        })(),
        isChild,
        allowlistSessionID,
        streamSessionID,
        ...(agentID ? { agentID } : {}),
        ...(agentDef ? { toolFilter: agentDef.tools } : {}),
        onSnapshot: (commit) => {
          assistant.snapshot = commit
        },
        hasSnapshot: () => assistant.snapshot !== undefined,
      }),
      prepareStep: async ({ steps, stepNumber }) => {
        // Langkah terakhir dijalankan tanpa tool sama sekali, sehingga model
        // TIDAK PUNYA pilihan selain menjawab dengan teks. Tanpa ini, giliran
        // yang kehabisan langkah berakhir pada tool call dan user membaca
        // "try a different model" — padahal modelnya baik-baik saja, cuma
        // kehabisan langkah. Dihitung DI LUAR try/catch di bawah: harus tetap
        // berlaku baik pemadatan berhasil, dilewati, MAUPUN melempar error.
        /*
         * DUA sebab sebuah langkah jadi yang terakhir, dan keduanya harus
         * memberi penutupan yang sama.
         *
         * Yang kedua diperkirakan, bukan diketahui. `stopWhen` baru menilai
         * SESUDAH sebuah langkah selesai, jadi kalau anggaran ditunggu sampai
         * benar-benar terlampaui, `prepareStep` tidak akan pernah dipanggil lagi
         * — dan gilirannya berakhir persis seperti dulu: terpotong di tengah
         * kalimat, tanpa satu kata pun penutup.
         *
         * Perkiraannya memakai ongkos langkah TERAKHIR, bukan rata-rata:
         * langkah yang baru saja terjadi adalah tebakan terbaik untuk langkah
         * berikutnya, dan rata-rata sepanjang giliran justru meremehkan biaya
         * setelah konteksnya membengkak.
         */
        const spent = tokensSpent(steps)
        const budgetNearlyGone =
          turnBudget !== undefined &&
          steps.length > 0 &&
          spent + lastStepCost(steps) >= turnBudget

        /*
         * Ditandai DI SINI, di tempat keputusannya diambil.
         *
         * Versi pertama menghitungnya lagi sesudah stream sebagai
         * `spent >= turnBudget` — dan itu salah dengan cara yang hanya terlihat
         * pada giliran sungguhan: anggaran 120.000, terpakai 118.900, giliran
         * berhenti karena perkiraan, tapi perbandingan telanjangnya menjawab
         * "belum lewat". Akibatnya tidak ada notice dan tidak ada lanjutan,
         * padahal rencananya masih menyisakan dua butir.
         *
         * Kelas bug yang sama yang berulang di repo ini, dan yang ditulis di
         * AGENTS.md: yang diukur bukan yang dikirim. Obatnya juga sama — satu
         * keputusan, dua pemakai.
         */
        if (budgetNearlyGone) stoppedAtLimit = true

        const lastStep = stepNumber >= maxSteps - 1 || budgetNearlyGone

        /*
         * Pada langkah terakhir, model DIBERI TAHU — bukan cuma dicabuti
         * toolnya.
         *
         * Mencabut tool saja sudah memaksanya menjawab teks, dan itu memang
         * niat aslinya. Tapi ia tidak tahu kenapa toolnya hilang: ia sedang
         * menarasikan pekerjaan ("Step 12: Run tests"), mendapati tidak ada
         * yang bisa dipanggil, lalu menulis apa pun yang ada di ujung
         * kalimatnya. Empat giliran di database sesi ini berakhir persis
         * begitu — terpotong di tengah kalimat, tepat sebelum tool berikutnya.
         *
         * Lewat `instructions`, bukan pesan baru di riwayat: ini keadaan
         * giliran ini, bukan sesuatu yang pernah dikatakan siapa pun. Menaruhnya
         * sebagai pesan berarti ia ikut tersimpan dan terbaca lagi di giliran
         * berikutnya, sebagai perintah yang sudah kedaluwarsa.
         */
        const closing = (base: Record<string, unknown>): Record<string, unknown> =>
          lastStep
            ? {
                ...base,
                activeTools: [],
                instructions: `${system}\n\n${LAST_STEP_NOTE}`,
              }
            : base
        try {
          // Pesan langkah yang BARU selesai ditakar sekali di sini, untuk dua
          // besaran yang BEDA dan sempat tertukar:
          //
          //   - `arrived` — SELURUH pesan langkah itu. Mereka sudah di tangan
          //     dan pasti ikut di permintaan berikutnya, sementara `used` masih
          //     mengukur permintaan SEBELUMNYA. Ini fakta, jadi tidak dijepit.
          //   - `largestToolResult` — hasil tool TERBESAR sejauh giliran ini,
          //     dipakai memesan tempat untuk langkah yang BELUM terjadi. Ini
          //     taksiran, jadi `effectiveGrowth` menjepitnya.
          //
          // Cukup langkah terakhir saja: tiap panggilan prepareStep melihat
          // tepat satu langkah baru di ujung `steps`.
          let arrived = 0
          for (const message of steps.at(-1)?.response.messages ?? []) {
            const bytes = messageBytes(message)
            arrived += growthTokens(bytes)
            if (message.role !== "tool") continue
            largestToolResult = Math.max(largestToolResult, growthTokens(bytes))
          }

          // `config.compaction.auto` dicek DI SINI, bukan diserahkan ke
          // `autoCompact` saja: tanpa ini, flush di bawah masih jalan walau
          // auto-compaction dimatikan user — kerja mubazir yang murah untuk
          // dihindari lebih dulu.
          const used = steps.at(-1)?.usage?.inputTokens
          if (
            !config.compaction.auto ||
            !overBudget(
              projectedContext(used, arrived),
              contextWindow,
              config.compaction.reserved,
              largestToolResult,
            )
          ) {
            return closing({})
          }

          const soFar: ModelMessage[] = [
            userTurn,
            ...steps.flatMap((step) => step.response.messages),
          ]
          appendModelMessages(session.id, soFar.slice(flushed))
          flushed = soFar.length

          // `summarise` yang SAMA dengan jalur antar-giliran di atas — LAMBAT,
          // bukan diresolusi di sini sebagai argumen. Resolusi eager adalah bug
          // yang sudah diperbaiki sekali untuk jalur antar-giliran: smallModel
          // yang salah akan melempar SEBELUM `autoCompact` sempat memutuskan
          // apakah ada sesuatu untuk dipadatkan sama sekali.
          const compacted = await autoCompact({
            sessionID: session.id,
            compaction: config.compaction,
            contextWindow,
            lastStepTokens: used,
            arrivedTokens: arrived,
            // System prompt SAJA di sini: mid-turn, pesan user giliran ini sudah
            // tertulis jadi baris dan ikut di `current`, jadi menyertakannya lagi
            // berarti menghitungnya dua kali.
            systemBytes: Buffer.byteLength(system),
            summariserWindow,
            summarise,
            focus: text,
            midTurn: {
              keepMessages: MID_TURN_KEEP,
              // `contextWindow` pasti terdefinisi di sini: `overBudget` di atas
              // sudah pulang false kalau tidak.
              budgetBytes: tailBudgetBytes(contextWindow ?? 0, config.compaction.reserved),
            },
            growthMargin: largestToolResult,
          })
          // `changed`, bukan `ran`: pemadatan yang menyala tanpa membebaskan
          // apa pun tidak punya riwayat baru untuk dikirim, dan menyusunnya
          // ulang cuma menyamarkan kegagalan itu sebagai keberhasilan.
          if (!compacted.changed) return closing({})

          /*
           * Dirakit ulang lewat jalur CAG yang SAMA, bukan lewat
           * `listModelMessages` langsung.
           *
           * Riwayatnya baru saja berubah, jadi titik potong cache harus
           * dipasang ulang pada batas stabil yang BARU. Mengembalikan daftar
           * mentah akan menaruh tanda pada pesan yang sudah bukan ujung awalan
           * lagi — cache ditulis di tempat yang tidak akan pernah cocok, dan
           * satu-satunya gejalanya adalah tagihan yang tidak turun.
           */
          const after = splitModelRequest(session.id)
          const rebuilt = buildCachedRequest({
            protectedBlock: after.protectedBlock,
            tail: after.tail,
            decision: shouldCache({
              npm: providerNpmFor(config, modelID) ?? "@ai-sdk/openai-compatible",
              systemText: system,
              historyLength: after.tail.length,
            }),
          }).messages

          return closing({ messages: rebuilt })
        } catch {
          // Gagal memadatkan DI TENGAH giliran berarti "lewati pemadatan
          // langkah ini", bukan "jatuhkan seluruh giliran yang sudah
          // menempuh beberapa tool". Tanpa tangkapan ini, resolver smallModel
          // yang salah melempar DI SINI dan giliran berakhir dengan error
          // serta jawaban kosong, padahal beberapa tool sudah berhasil jalan
          // — pasangan persis `catch {}` di jalur antar-giliran di atas.
          // `lastStep` tetap dihormati: kegagalan memadatkan tidak boleh
          // membiarkan giliran berakhir pada tool call lagi.
          return closing({})
        }
      },
      /*
       * Dua kondisi berhenti, dan yang mana pun lebih dulu tercapai menang.
       *
       * `stepCountIs` tinggal jaring patologi; anggaran token yang jadi
       * kebijakan sesungguhnya — lihat `limits.turnTokens` di schema.
       */
      stopWhen:
        turnBudget === undefined
          ? stepCountIs(maxSteps)
          : [
              stepCountIs(maxSteps),
              ({ steps }: { steps: readonly { usage: LanguageModelUsage }[] }) =>
                tokensSpent(steps) >= turnBudget,
            ],
      abortSignal: controller.signal,
    })

    // Input token langkah TERAKHIR — ukuran konteks, bukan total penagihan.
    let lastStepTokens: number | undefined

    for await (const part of result.fullStream) {
      switch (part.type) {
        /*
         * Penalaran model, kalau ia mengirimkannya.
         *
         * Ditangani dengan pola yang PERSIS sama dengan `text-delta` di bawah,
         * dan itu disengaja: keduanya aliran teks yang tumbuh, dan menulis dua
         * mekanisme untuk satu bentuk berarti yang kedua akan tertinggal saat
         * yang pertama diperbaiki.
         *
         * Model yang tidak mengirim reasoning tidak melewati cabang ini sama
         * sekali — tidak ada part yang dibuat, dan riwayatnya identik dengan
         * sebelum perubahan ini.
         */
        case "reasoning-delta": {
          if (part.text === "") break
          const last = assistant.parts.at(-1)
          if (last?.type === "reasoning") last.text += part.text
          else assistant.parts.push({ type: "reasoning", text: part.text })
          bus.publish({
            type: "reasoning.delta",
            sessionID: session.id,
            messageID: assistant.id,
            text: part.text,
          })
          break
        }

        case "text-delta": {
          if (part.text === "") break
          const last = assistant.parts.at(-1)
          if (last?.type === "text") last.text += part.text
          else assistant.parts.push({ type: "text", text: part.text })
          // Delta, bukan snapshot — inilah yang membuat jawaban terasa mengalir.
          bus.publish({
            type: "text.delta",
            sessionID: session.id,
            messageID: assistant.id,
            text: part.text,
          })
          break
        }

        case "abort": {
          // Provider sungguhan mengakhiri stream dengan part ini alih-alih
          // melempar error, sehingga blok catch tidak pernah jalan. Tanpa
          // penanganan ini, giliran yang dibatalkan tersimpan dan terlihat
          // persis seperti giliran yang selesai normal.
          assistant.error = "Cancelled by user."
          publishSnapshot()
          break
        }

        case "error": {
          const message = part.error instanceof Error ? part.error.message : String(part.error)
          assistant.error = message
          publishSnapshot()
          bus.publish({ type: "session.error", sessionID: session.id, message })
          break
        }

        case "finish-step": {
          const input = part.usage?.inputTokens
          if (input !== undefined) lastStepTokens = input
          break
        }

        case "finish": {
          assistant.usage = {
            ...(part.totalUsage.inputTokens !== undefined
              ? { input: part.totalUsage.inputTokens }
              : {}),
            ...(part.totalUsage.outputTokens !== undefined
              ? { output: part.totalUsage.outputTokens }
              : {}),
            ...(lastStepTokens !== undefined ? { context: lastStepTokens } : {}),
          }
          break
        }

        default:
          // Sisa event stream (tool-call, start-step, reasoning, ...) tidak perlu
          // dilaporkan sendiri: state tool sudah dipublikasikan dari dalam execute.
          // `finish-step` ditangani di atas — direkam ke `lastStepTokens`, bukan
          // dipublikasikan — jadi ia tidak pernah sampai ke sini.
          break
      }
    }

    // JANGAN pakai `result.response.messages`: untuk giliran multi-step ia hanya
    // berisi pesan step TERAKHIR, sehingga seluruh pasangan tool-call/tool-result
    // dan pesan user hilang dari riwayat. Giliran berikutnya lalu kehilangan
    // konteks dan mengulang pekerjaan yang sudah dilakukan.
    // Model kadang menghabiskan giliran pada tool call lalu berhenti tanpa teks.
    // Tanpa penanda ini, user melihat daftar tool lalu... tidak ada apa-apa.
    if (!assistant.parts.some((part) => part.type === "text") && assistant.error === undefined) {
      const note =
        "(the model stopped without giving a text answer — try again, " +
        "or use a different model with --model)"
      bus.publish({
        type: "text.delta",
        sessionID: session.id,
        messageID: assistant.id,
        text: note,
      })
      assistant.parts.push({ type: "text", text: note })
    }

    const steps = await result.steps

    /*
     * Giliran yang berhenti karena kehabisan langkah MENGATAKANNYA.
     *
     * Diukur dari 68 giliran nyata: sebarannya meluruh mulus dari 1 sampai 16
     * langkah, lalu menumpuk sembilan giliran di 19–20. Itu bukan sebaran
     * alami, itu tembok — 13% giliran berhenti bukan karena selesai.
     *
     * Sebelum ini tidak ada satu pun tanda. Model menutup dengan kalimat
     * terpotong, dan dari layar itu terlihat persis seperti Titah menyerah di
     * tengah jalan tanpa sebab. Kegagalan yang tidak bisa dibedakan dari
     * keberhasilan adalah kegagalan yang paling mahal, karena langkah
     * berikutnya dibangun di atas pekerjaan yang tidak pernah terjadi.
     *
     * `>= maxSteps`, bukan `finishReason`: batasnya milik Titah, jadi Titah
     * yang tahu pasti — sementara `finishReason` datang dari provider dan
     * bentuknya berbeda-beda antar endpoint.
     */
    /*
     * Anggaran diperiksa LEBIH DULU dari batas langkah.
     *
     * Keduanya bisa tercapai di langkah yang sama, dan yang perlu diperbaiki
     * user berbeda: menaikkan `steps` tidak menolong sedikit pun kalau yang
     * habis adalah tokennya. Kabar yang menyuruh memutar tombol yang salah
     * lebih buruk daripada tidak ada kabar.
     */
    const spentTokens = tokensSpent(steps)
    const outOfBudget = stoppedAtLimit || (turnBudget !== undefined && spentTokens >= turnBudget)
    if (steps.length >= maxSteps) stoppedAtLimit = true

    if (turnBudget !== undefined && outOfBudget) {
      bus.publish({
        type: "session.notice",
        sessionID: streamSessionID,
        message:
          `Stopped at this turn's token budget — ${spentTokens.toLocaleString()} of ` +
          `${turnBudget.toLocaleString()} spent across ${steps.length} steps. ` +
          // Anggaran turunan harus MENYEBUT dirinya turunan. Angka yang tidak
          // pernah ditulis user, muncul tanpa penjelasan, terbaca sebagai batas
          // misterius alih-alih sebagai sesuatu yang bisa ia ubah.
          (config.limits.turnTokens === undefined
            ? `That is the default: ${TURN_BUDGET_WINDOWS}× the model's context window. `
            : "") +
          'The work may not be finished. Raise it with "limits.turnTokens", or send another ' +
          "prompt to continue from where it stopped.",
      })
    } else if (steps.length >= maxSteps) {
      bus.publish({
        type: "session.notice",
        sessionID: streamSessionID,
        message:
          `Stopped at the ${maxSteps}-step limit for this turn — the work may not be ` +
          `finished. Raise it with "agent.${agentID ?? "build"}.steps" in the config, or ` +
          "send another prompt to continue from where it stopped.",
      })
    }

    const all: ModelMessage[] = [userTurn, ...steps.flatMap((step) => step.response.messages)]
    appendModelMessages(session.id, all.slice(flushed))
    flushed = all.length
    publishSnapshot()
  } catch (error) {
    const message =
      controller.signal.aborted && !(error instanceof Error && error.name === "TimeoutError")
        ? "Cancelled by user."
        : error instanceof Error
          ? error.message
          : String(error)
    assistant.error = message
    publishSnapshot()
    bus.publish({ type: "session.error", sessionID: session.id, message })
  } finally {
    running.delete(session.id)
    // Hanya giliran TOP-LEVEL yang membersihkan — sub-agent yang selesai lebih
    // dulu tidak boleh menghapus allowlist giliran yang masih dipakai sub-agent
    // LAIN di giliran INDUK yang sama. Ini pasangan `finally` untuk komentar
    // `turnAllowlist` di permission.ts: grant yang bertahan lewat gilirannya
    // sendiri adalah bug yang dipatok di sini, jadi harus jalan meski giliran
    // gagal atau dibatalkan — bukan cuma pada jalur sukses.
    if (!isChild) clearTurn(session.id)
    const updated = touchSession(session.id)
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })

    /*
     * `session.idle` DITAHAN kalau giliran berikutnya sudah pasti menyusul.
     *
     * Bukan kosmetik. Klien memakai idle sebagai tanda "sudah selesai, berhenti
     * mendengarkan": `titah run` memutus streamnya di situ, dan TUI
     * mengembalikan statusnya ke diam. Menerbitkannya di antara dua giliran
     * yang sebenarnya satu pekerjaan membuat lanjutannya berjalan TANPA
     * PENONTON — tool-nya tidak muncul, izinnya tidak bisa dijawab, dan
     * layarnya bilang selesai sementara Titah masih menulis berkas.
     *
     * Dihitung di sini, bukan sesudah `finally`, karena di sinilah urutannya
     * masih bisa diatur: keputusannya butuh `assistant.error` dan
     * `stoppedAtLimit` yang keduanya sudah terisi, dan idle harus tahu
     * jawabannya sebelum memutuskan terbit atau tidak.
     */
    const allowed = config.limits.continueTurns
    const done = input.continuation ?? 0
    willContinue =
      allowed > 0 &&
      done < allowed &&
      stoppedAtLimit &&
      !isChild &&
      !controller.signal.aborted &&
      assistant.error === undefined &&
      hasOpenWork(readPlan(session.id)?.text)

    if (!willContinue) bus.publish({ type: "session.idle", sessionID: session.id })
  }


  /*
   * LANJUT SENDIRI, kalau rencananya masih punya pekerjaan.
   *
   * Inilah "jalan sampai semua task selesai" — dan bentuknya sengaja LOOP DARI
   * GILIRAN, bukan satu giliran tanpa batas.
   *
   * Giliran seribu langkah akan dipadatkan berkali-kali; di langkah ke-400
   * model bekerja dari ringkasan atas ringkasan, terus jalan sambil pelan-pelan
   * lupa. Giliran BARU mulai dengan transkrip bersih dan membaca ulang rencana
   * utuh dari tabel `plan`, satu-satunya tabel yang tidak disentuh pemadatan.
   * Jadi loop ini memperbaiki masalah lupa, sementara langkah tanpa batas
   * memperburuknya.
   *
   * SEMUA syarat di bawah harus benar, dan tiap satunya menutup satu cara loop
   * ini bisa berubah jadi pemborosan:
   *
   *   - dinyalakan user           — ia membelanjakan uang tanpa bertanya
   *   - berhenti karena BATAS     — giliran yang selesai wajar memang sudah selesai
   *   - bukan sub-agent           — anak tidak mengatur nasibnya sendiri; induknya yang mengatur
   *   - tidak dibatalkan          — Esc berarti berhenti, bukan berhenti lalu mulai lagi
   *   - tidak error               — mengulang kegagalan yang sama tidak membuatnya berhasil
   *   - rencananya punya sisa     — satu-satunya definisi "belum selesai" yang bisa dinilai mesin
   *   - jatah lanjutan masih ada  — batas keras, supaya "sampai selesai" tetap punya ujung
   */
  if (willContinue) {
    bus.publish({
      type: "session.notice",
      sessionID: streamSessionID,
      message:
        `Continuing on its own (${(input.continuation ?? 0) + 1} of ` +
        `${config.limits.continueTurns}) — the plan still has unfinished items. ` +
        "Press Esc to stop.",
    })

    return prompt({
      ...input,
      continuation: (input.continuation ?? 0) + 1,
      text: CONTINUE_TEXT,
    })
  }

  return assistant
}

const PROGRESS_INTERVAL = 2000

/**
 * Giliran delegasi: `@claude tolong review ini`.
 *
 * Jalur ini sengaja TIDAK melewati model Titah sama sekali. Yang masuk ke
 * riwayat hanyalah pertanyaan user dan jawaban final agent eksternal (Q12) —
 * transkrip penuhnya ditulis ke tool-output/ dan cukup disebut lewat path,
 * karena menyuntikkannya utuh akan meledakkan context window dalam 2-3 delegasi.
 */
async function delegateTurn(
  session: Session,
  config: Config,
  mention: Mention,
  rawText: string,
): Promise<Message> {
  const userMessage = createMessage(session.id, "user", [{ type: "text", text: rawText }])
  bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })

  if (session.title === "") {
    const updated = touchSession(session.id, { title: rawText.replace(/\s+/g, " ").slice(0, 80) })
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
  }

  const assistant = createMessage(session.id, "assistant", [])
  assistant.model = `@${mention.agentID}`
  const callID = `del_${crypto.randomUUID()}`
  const started = Date.now()

  const publish = () => {
    saveMessage(assistant)
    bus.publish({
      type: "message.updated",
      sessionID: session.id,
      message: structuredClone(assistant),
    })
  }

  const setPart = (state: ToolState) => {
    const existing = assistant.parts.find(
      (part): part is Extract<Part, { type: "tool" }> => part.type === "tool",
    )
    if (existing) existing.state = state
    else assistant.parts.push({ type: "tool", callID, tool: `@${mention.agentID}`, state })
    publish()
  }

  const controller = new AbortController()
  running.set(session.id, controller)

  const input = { agent: mention.agentID, prompt: mention.prompt }
  setPart({ status: "running", input, started, title: `@${mention.agentID} …` })

  const fail = (message: string): Message => {
    setPart({ status: "error", input, error: message, started, ended: Date.now() })
    assistant.error = message
    publish()
    bus.publish({ type: "session.error", sessionID: session.id, message })
    return assistant
  }

  try {
    const adapter = adapterFor(config, mention.agentID)
    if (!adapter) {
      const known = Object.keys(config.externalAgent).join(", ") || "(belum ada)"
      return fail(`Unknown agent "@${mention.agentID}". Registered: ${known}.`)
    }
    if (!adapter.available) {
      return fail(
        `Agent "@${mention.agentID}" is unavailable — "${config.externalAgent[mention.agentID]?.command}" ` +
          "was not found in PATH. Install its CLI first, then retry.",
      )
    }

    const resume = externalSessionFor(session.id, mention.agentID)
    let lastNote = resume ? "resuming session" : "starting session"
    let lastPublish = Date.now()

    const result = await adapter.prompt({
      prompt: mention.prompt,
      cwd: session.directory,
      ...(resume ? { resumeSessionID: resume } : {}),
      signal: controller.signal,
      onUpdate: (update) => {
        if (update.kind === "session") {
          rememberExternalSession(session.id, mention.agentID, update.sessionID)
          return
        }
        if (update.kind === "tool") lastNote = `running ${update.name}`
        if (update.kind === "progress") lastNote = update.note

        // Timeout diam adalah pengalaman terburuk (Q24): denyutkan status supaya
        // user melihat agent eksternal masih hidup, tanpa membanjiri klien.
        const now = Date.now()
        if (now - lastPublish < PROGRESS_INTERVAL) return
        lastPublish = now
        setPart({
          status: "running",
          input,
          started,
          title: `@${mention.agentID} · ${Math.round((now - started) / 1000)}s · ${lastNote}`,
        })
      },
    })

    if (result.externalSessionID) {
      rememberExternalSession(session.id, mention.agentID, result.externalSessionID)
    }

    const stored = storeOutput(callID, result.transcript)
    const seconds = (result.durationMs / 1000).toFixed(1)
    const tokens = `${result.usage.input ?? "?"} in / ${result.usage.output ?? "?"} out`
    // "≈" disengaja: angka ini ekuivalen harga API yang dilaporkan agent
    // eksternal, bukan tagihan. User berlangganan membayar dengan kuota.
    const cost = result.usage.cost === undefined ? "" : ` · ≈$${result.usage.cost.toFixed(4)}`

    if (result.isError) {
      return fail(
        `${result.errorMessage ?? `Agent "@${mention.agentID}" failed.`} ` +
          `Raw transcript: ${stored.outputRef ?? "(inline)"}`,
      )
    }

    setPart({
      status: "completed",
      input,
      title: `@${mention.agentID} · ${seconds}s · ${tokens}${cost}`,
      output: result.answer,
      ...(stored.outputRef ? { outputRef: stored.outputRef } : {}),
      truncated: stored.truncated,
      started,
      ended: Date.now(),
    })

    // Delta dulu, baru snapshot — urutan yang sama dengan jalur LLM. Tanpa
    // delta, klien yang hanya mendengarkan `text.delta` (mis. `titah run`)
    // menampilkan metrik delegasi tapi tidak pernah menampilkan jawabannya.
    bus.publish({
      type: "text.delta",
      sessionID: session.id,
      messageID: assistant.id,
      text: result.answer,
    })
    assistant.parts.push({ type: "text", text: result.answer })
    assistant.externalUsage = result.usage
    publish()

    // Hanya jawaban final yang masuk riwayat model, bukan transkripnya.
    appendModelMessages(session.id, [
      { role: "user", content: rawText },
      {
        role: "assistant",
        content: `[answer from @${mention.agentID}]\n${result.answer}`,
      },
    ])

    return assistant
  } catch (error) {
    const message =
      controller.signal.aborted && !(error instanceof Error && error.name === "TimeoutError")
        ? "Cancelled by user."
        : error instanceof Error
          ? error.message
          : String(error)
    return fail(message)
  } finally {
    running.delete(session.id)
    const updated = touchSession(session.id)
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
    bus.publish({ type: "session.idle", sessionID: session.id })
  }
}

/** Giliran tanpa LLM: menampilkan teks apa adanya sebagai jawaban. */
function infoTurn(session: Session, userText: string, body: string, isError = false): Message {
  const userMessage = createMessage(session.id, "user", [{ type: "text", text: userText }])
  bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })

  if (session.title === "") {
    const updated = touchSession(session.id, { title: userText.replace(/\s+/g, " ").slice(0, 80) })
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
  }

  const assistant = createMessage(session.id, "assistant", [{ type: "text", text: body }])
  if (isError) assistant.error = body.split("\n")[0] as string
  saveMessage(assistant)

  bus.publish({ type: "text.delta", sessionID: session.id, messageID: assistant.id, text: body })
  bus.publish({
    type: "message.updated",
    sessionID: session.id,
    message: structuredClone(assistant),
  })
  bus.publish({ type: "session.idle", sessionID: session.id })
  return assistant
}

function renderCommands(config: Config): string {
  return [
    "Available commands:",
    ...listCommands(config).map((entry) => `  /${entry.name.padEnd(14)} ${entry.description}`),
  ].join("\n")
}

function renderAgents(config: Config): string {
  const internal = Object.entries(config.agent)
  const external = listAgents(config)

  const lines = ["Internal agents (Tab to switch):"]
  if (internal.length === 0) lines.push("  (none yet — add an `agent` block to titah.json)")
  for (const [id, agent] of internal) {
    // "●", bukan "*": teks ini dirender sebagai markdown di TUI, dan bintang di
    // awal baris akan berubah jadi butir daftar.
    const marker = id === config.defaultAgent ? "●" : " "
    lines.push(`  ${marker} ${id.padEnd(22)} ${agent.description ?? ""}`)
  }

  lines.push("", "External agents (call with @name):")
  for (const agent of external) {
    lines.push(
      `    ${agent.id.padEnd(22)} ${agent.available ? "available" : `unavailable (${agent.command})`}`,
    )
  }
  return lines.join("\n")
}

function renderSkills(config: Config, cwd: string): string {
  const report = renderSkillReport(config, cwd)
  const skills = discoverSkills(config, cwd)
  if (skills.length === 0) {
    return `${report}\n\nNo skills found. Add a directory to \`skills.paths\` in titah.json.`
  }
  return [
    report,
    "",
    `${skills.length} skills found:`,
    // Id lengkap, bukan `name`: nama telanjang tidak pernah bisa dipanggil, dan
    // daftar yang menampilkannya membuat user mengetik `/brainstorming` lalu
    // dijawab "Unknown command" oleh satu-satunya tempat yang menjelaskannya.
    ...skills.map((skill) => `  /${skill.id.padEnd(36)} ${skill.description}`),
  ].join("\n")
}

/**
 * Command bawaan. Dipisah dari command user karena mereka mengubah ALUR, bukan
 * sekadar memperluas prompt — dan karena itu tidak boleh bisa ditimpa config.
 */
async function builtinTurn(
  session: Session,
  config: Config,
  name: string,
  args: string,
  input: PromptInput,
  /** Model yang menjalankan giliran — lihat `turnModelFor`. */
  turnModel: string | undefined,
): Promise<Message> {
  if (name === "compact") return compactTurn(session, config, args.trim(), input, turnModel)
  if (name === "agents") return infoTurn(session, input.text, renderAgents(config))
  if (name === "commands") return infoTurn(session, input.text, renderCommands(config))
  if (name === "skills") return infoTurn(session, input.text, renderSkills(config, session.directory))

  // /consensus
  if (args.trim() === "") {
    return infoTurn(session, input.text, "Usage: /consensus <question>", true)
  }
  return consensusTurn(session, config, args.trim(), input)
}

/**
 * `/compact` — meringkas percakapan sejauh ini supaya konteks tidak meluap.
 *
 * Yang dipadatkan hanya riwayat yang DIKIRIM KE MODEL. Transkrip yang terlihat
 * di layar tidak disentuh: user tetap bisa menggulir ke atas dan membaca apa
 * yang sebenarnya terjadi, sementara model bekerja dari ringkasannya.
 */
async function compactTurn(
  session: Session,
  config: Config,
  focus: string,
  input: PromptInput,
  /**
   * Model yang menjalankan giliran ini. DITERIMA, bukan dihitung ulang dari
   * `input.model`: agent yang menyatakan modelnya sendiri harus meringkas dengan
   * model itu juga, sama seperti pemadatan otomatis di sesi yang sama.
   */
  turnModel: string | undefined,
): Promise<Message> {
  const previous = latestCompaction(session.id)
  const rows = listModelRows(session.id).filter((row) => !previous || row.seq > previous.seq)
  const plan = planCompaction(rows, config.compaction.tailTurns)

  if (plan.dropped.length === 0) {
    return infoTurn(
      session,
      input.text,
      previous
        ? "Nothing new to compact — everything before the last exchange is already summarised."
        : "Nothing to compact yet. This session is still short enough to send in full.",
    )
  }

  const userMessage = createMessage(session.id, "user", [{ type: "text", text: input.text }])
  bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })

  const assistant = createMessage(session.id, "assistant", [])
  assistant.model = "compact"
  bus.publish({ type: "message.updated", sessionID: session.id, message: assistant })

  const controller = new AbortController()
  running.set(session.id, controller)

  try {
    // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk. Menumpuk
    // membuat ringkasan tumbuh tanpa batas — persis masalah yang mau dipecahkan.
    const source = previous
      ? `${previous.summary}\n\n${renderTranscript(plan.dropped)}`
      : renderTranscript(plan.dropped)
    // Dipecah per PESAN untuk peringkasnya, sementara `source` di atas tetap
    // dipakai untuk melaporkan ukuran sebelum/sesudah ke user.
    const parts = [
      ...(previous ? [previous.summary] : []),
      ...plan.dropped.map((message) => renderMessage(message)),
    ]

    // `smallModel ?? input.model` — pilihan model yang SAMA dengan pemadatan
    // otomatis. Operasinya identik (instruksi, prompt, dan pembungkusnya sama
    // persis), jadi dua pilihan model berarti `/compact` diam-diam menghasilkan
    // ringkasan yang berbeda mutunya dari yang ditulis otomatis di sesi yang
    // sama — beda yang tidak pernah bisa dijelaskan ke user.
    const summariserModel = summariserModelFor(config, turnModel)
    const summarise = synthesizerFor(resolver(config, summariserModel), controller.signal)
    // Lewat `summariseInChunks`, sama dengan jalur otomatis: prompt peringkas
    // dibatasi jendela model yang MENULIS ringkasan. Jalur ini justru yang
    // paparannya paling lebar — memindahkan `/compact` ke `smallModel` membuat
    // transkrip sebesar jendela model giliran dikirim ke model yang jendelanya
    // bisa jauh lebih kecil.
    const summary = await summariseInChunks(
      summarise,
      parts,
      summariserChunkBytes(summariserWindowFor(config, turnModel), config.compaction.reserved),
      focus,
    )

    if (summary.trim() === "") throw new AgentError("The model returned an empty summary.")

    saveCompaction(session.id, plan.watermark, wrapSummary(summary))

    const before = source.length
    const after = summary.length
    const body = [
      `Compacted ${plan.dropped.length} messages into a summary` +
        (plan.kept > 0 ? `, keeping the last ${plan.kept} verbatim.` : "."),
      `Context text: ${before.toLocaleString()} → ${after.toLocaleString()} characters.`,
      "",
      "The full transcript is still on screen and on disk — only what the model sees was shrunk.",
      "",
      summary,
    ].join("\n")

    assistant.parts.push({ type: "text", text: body })
    saveMessage(assistant)
    bus.publish({ type: "text.delta", sessionID: session.id, messageID: assistant.id, text: body })
    bus.publish({
      type: "message.updated",
      sessionID: session.id,
      message: structuredClone(assistant),
    })
    return assistant
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assistant.error = message
    saveMessage(assistant)
    bus.publish({ type: "session.error", sessionID: session.id, message })
    bus.publish({
      type: "message.updated",
      sessionID: session.id,
      message: structuredClone(assistant),
    })
    return assistant
  } finally {
    running.delete(session.id)
    bus.publish({ type: "session.idle", sessionID: session.id })
  }
}

async function consensusTurn(
  session: Session,
  config: Config,
  question: string,
  input: PromptInput,
): Promise<Message> {
  const userMessage = createMessage(session.id, "user", [{ type: "text", text: input.text }])
  bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })

  if (session.title === "") {
    const updated = touchSession(session.id, { title: `consensus: ${question.slice(0, 60)}` })
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
  }

  const assistant = createMessage(session.id, "assistant", [])
  assistant.model = "consensus"
  const started = Date.now()

  const publish = () => {
    saveMessage(assistant)
    bus.publish({
      type: "message.updated",
      sessionID: session.id,
      message: structuredClone(assistant),
    })
  }

  const setPart = (callID: string, tool: string, state: ToolState) => {
    const existing = assistant.parts.find(
      (part): part is Extract<Part, { type: "tool" }> =>
        part.type === "tool" && part.callID === callID,
    )
    if (existing) existing.state = state
    else assistant.parts.push({ type: "tool", callID, tool, state })
    publish()
  }

  const renderAnswer = (answer: {
    agentID: string
    answer: string
    durationMs: number
    error?: string
  }) => {
    const callID = `cons_${answer.agentID}`
    if (answer.error !== undefined) {
      return setPart(callID, `@${answer.agentID}`, {
        status: "error",
        input: { question },
        error: answer.error,
        started,
        ended: Date.now(),
      })
    }
    setPart(callID, `@${answer.agentID}`, {
      status: "completed",
      input: { question },
      title: `@${answer.agentID} · ${(answer.durationMs / 1000).toFixed(1)}s`,
      output: answer.answer,
      truncated: false,
      started,
      ended: Date.now(),
    })
  }

  const controller = new AbortController()
  running.set(session.id, controller)

  // Status per agent, dipakai denyut di bawah. Tanpa denyut, agent yang lambat
  // terlihat membeku di "mulai" — masalah "timeout diam" yang sama dengan Q24,
  // hanya saja di sini terjadi pada beberapa agent sekaligus.
  const notes = new Map<string, string>()
  const beat = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000)
    for (const [agentID, note] of notes) {
      if (note === "selesai" || note === "gagal") continue
      setPart(`cons_${agentID}`, `@${agentID}`, {
        status: "running",
        input: { question },
        started,
        title: `@${agentID} · ${elapsed}s · ${note}`,
      })
    }
  }, PROGRESS_INTERVAL)
  beat.unref()

  try {
    // Model Titah hanya dipakai untuk MENYINTESIS. Kalau belum dikonfigurasi,
    // konsensus tetap berjalan dan mengembalikan jawaban mentah masing-masing.
    let synthesize: ((system: string, prompt: string) => Promise<string>) | undefined
    try {
      synthesize = synthesizerFor(resolver(config, input.model), controller.signal)
    } catch {
      synthesize = undefined
    }

    const result = await runConsensus({
      config,
      question,
      cwd: session.directory,
      signal: controller.signal,
      ...(synthesize ? { synthesize } : {}),
      onAnswer: (answer) => {
        // Segera tandai selesai/gagal, jangan tunggu agent paling lambat.
        notes.set(answer.agentID, answer.error === undefined ? "selesai" : "gagal")
        renderAnswer(answer)
      },
      onUpdate: (agentID, note) => {
        notes.set(agentID, note)
        setPart(`cons_${agentID}`, `@${agentID}`, {
          status: "running",
          input: { question },
          started,
          title: `@${agentID} · ${Math.round((Date.now() - started) / 1000)}s · ${note}`,
        })
      },
    })

    const totals = result.answers.reduce(
      (sum, answer) => ({
        input: sum.input + (answer.usage.input ?? 0),
        output: sum.output + (answer.usage.output ?? 0),
        cost: sum.cost + (answer.usage.cost ?? 0),
      }),
      { input: 0, output: 0, cost: 0 },
    )
    assistant.externalUsage = totals

    bus.publish({
      type: "text.delta",
      sessionID: session.id,
      messageID: assistant.id,
      text: result.synthesis,
    })
    assistant.parts.push({ type: "text", text: result.synthesis })
    publish()

    appendModelMessages(session.id, [
      { role: "user", content: input.text },
      { role: "assistant", content: `[consensus]\n${result.synthesis}` },
    ])

    return assistant
  } catch (error) {
    const message = controller.signal.aborted
      ? "Cancelled by user."
      : error instanceof Error
        ? error.message
        : String(error)
    assistant.error = message
    publish()
    bus.publish({ type: "session.error", sessionID: session.id, message })
    return assistant
  } finally {
    clearInterval(beat)
    running.delete(session.id)
    const updated = touchSession(session.id)
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
    bus.publish({ type: "session.idle", sessionID: session.id })
  }
}

interface BuildToolsOptions {
  sessionID: string
  cwd: string
  config: Config
  permission: EffectivePermission
  signal: AbortSignal
  upsert: (callID: string, name: string, state: ToolState) => void
  onSnapshot: (commit: string) => void
  hasSnapshot: () => boolean
  /** Filter tool per agent (Q21). Tool yang tidak disebut tetap aktif. */
  toolFilter?: Record<string, boolean>
  /** Sesi anak tidak pernah mendapat `task` — lihat komentar di `prompt()`. */
  isChild: boolean
  /** Nama agent yang menjalankan giliran ini, untuk dialog izin. */
  agentID?: string
  /** Sesi yang dipakai allowlist "always" — lihat komentar di `prompt()`. */
  allowlistSessionID: string
  /** Sesi yang stream event-nya benar-benar didengarkan klien — lihat komentar di `prompt()`. */
  streamSessionID: string
  /**
   * Jendela model giliran ini, kalau dideklarasikan. Diteruskan ke ToolContext
   * supaya `plan` bisa membatasi dirinya relatif jendela (issue #5).
   */
  contextWindow?: number
  /** Tool dari server MCP untuk giliran ini. */
  mcpTools?: TitahTool[]
  /** Plugin yang sudah dimuat untuk giliran ini. Kosong berarti tidak ada. */
  plugins?: LoadedPlugin[]
  /** Super agent yang boleh diminta giliran ini — lihat `Agent.escalate`. */
  escalateTo?: string
  /**
   * Model yang menjalankan giliran ini, sudah diresolusi.
   *
   * Diwariskan `task` ke sub-agent yang tidak menyebut modelnya sendiri.
   * Tanpa ini, anak jatuh ke `config.model` — jadi `-m` pada induk hanya
   * memindahkan induknya, dan delegasi diam-diam berjalan di model lain.
   */
  model?: string
}

/**
 * Daftar tool aktif untuk satu giliran, SEBELUM dibungkus jadi `ToolSet` AI SDK.
 *
 * Dipisah dari `buildTools` supaya penjaga kedalaman (`task` tidak diwariskan
 * ke anak) bisa diuji lewat `buildToolNames` tanpa menjalankan giliran
 * sungguhan — dan supaya test itu memeriksa jalur yang SAMA dengan yang
 * dipakai `buildTools`, bukan salinan yang bisa diam-diam menyimpang darinya.
 */
function activeTools(options: {
  isChild: boolean
  /** Super agent yang boleh diminta sub-agent ini. Lihat `Agent.escalate`. */
  escalateTo?: string
  toolFilter?: Record<string, boolean>
  /** Tool dari server MCP, sudah dibungkus. Kosong kalau tidak ada yang dikonfigurasi. */
  extra?: TitahTool[]
}): TitahTool[] {
  return [...allTools(), ...(options.extra ?? [])].filter((definition) => {
    /*
     * Sub-agent tidak punya `task` — kecuali ia punya `escalate`.
     *
     * Batas kedalaman ada untuk mencegah rekursi tanpa akhir: sub-agent yang
     * bisa memanggil sub-agent lagi, dan seterusnya. Pengecualian ini TIDAK
     * membukanya, karena satu-satunya yang boleh ia panggil adalah super agent
     * — CLI di luar Titah, yang tidak punya tool `task` untuk memanggil balik.
     * Rantainya berhenti di sana secara struktural, bukan karena dijaga.
     */
    if (definition.name === "task" && options.isChild && options.escalateTo === undefined) {
      return false
    }
    if (options.toolFilter?.[definition.name] === false) return false
    return true
  })
}

/** Nama tool yang aktif untuk bentuk options tertentu — lihat `activeTools`. */
export function buildToolNames(options: { isChild: boolean }): string[] {
  return activeTools(options).map((definition) => definition.name)
}

/** Tool yang menulis berkas, dan field mana yang memuat path-nya. */
const WRITES_FILE: Record<string, string> = { edit: "path", write: "path", patch: "path", move: "to" }

/** Rencana sependek ini dikerjakan sendiri; menanyakannya hanya menambah dialog. */
const PLAN_STEPS_WORTH_SPLITTING = 3

/** Sesi yang sudah pernah ditanyai soal cara mengerjakan. */
const delegationAsked = new Set<string>()

/**
 * Menghitung langkah dalam sebuah rencana.
 *
 * Dihitung dari BARIS yang terlihat seperti butir — bernomor atau berpoin —
 * bukan dari jumlah baris. Rencana yang ditulis sebagai satu paragraf panjang
 * memang bukan rencana bertahap, dan menghitungnya sebagai sepuluh langkah akan
 * memicu pertanyaan pada pekerjaan yang sebetulnya tunggal.
 */
export function planSteps(text: string): number {
  return text
    .split("\n")
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length
}

/**
 * Catatan yang ditempelkan ke hasil `plan`, menyuruh model MENIMBANG delegasi.
 *
 * # Pembagian tugasnya
 *
 * Titah tidak bisa menilai apakah sebuah rencana cocok dipecah — itu butuh
 * memahami isinya. Yang bisa ia nilai adalah apakah pertanyaannya LAYAK
 * DIAJUKAN: ada sub-agent yang tersedia, rencananya cukup panjang, dan sesi ini
 * belum pernah ditanyai. Sisanya — apakah pemisahan itu benar-benar menolong —
 * diserahkan ke model, yang memang sedang memegang isinya.
 *
 * Sekali per sesi, dengan alasan yang sama seperti peringatan lain di berkas
 * ini: pertanyaan yang berulang di setiap pembaruan rencana berhenti dibaca
 * justru ketika ia mulai berarti.
 */
function delegationNote(config: Config, sessionID: string, planText: string): string {
  if (config.delegation !== "ask") return ""
  if (delegationAsked.has(sessionID)) return ""
  if (dispatchableAgents(config).length === 0) return ""
  if (planSteps(planText) < PLAN_STEPS_WORTH_SPLITTING) return ""

  delegationAsked.add(sessionID)
  return (
    "\n\n--- before you start ---\n" +
    "Look at the plan you just wrote against the sub-agents in your roster.\n\n" +
    "If two or more steps could be carried out by them — independently of each other, or " +
    "because they match a description more closely than your own job — call `question` " +
    "with exactly these two options, in this order:\n" +
    '  "Delegate: hand matching steps to the sub-agents"\n' +
    '  "Inline: do all of it yourself"\n\n' +
    "State in the question WHICH steps you would hand over and to whom, so the choice is " +
    "made with the split in front of them.\n\n" +
    "If the work does not divide — the steps depend on each other, or none of the agents " +
    "fit — do NOT ask. Just carry on. An unnecessary question costs more than a delegation " +
    "not made."
  )
}

/**
 * Menempelkan diagnostics ke hasil tool, kalau ada language server yang
 * menangani berkasnya.
 *
 * Tidak pernah melempar dan tidak pernah menunda lebih dari batasnya: language
 * server adalah proses milik orang lain, dan giliran yang gagal karena
 * pemeriksanya rusak lebih buruk daripada giliran tanpa pemeriksa.
 */
async function appendDiagnostics(
  config: Config,
  cwd: string,
  toolName: string,
  input: unknown,
  output: string,
): Promise<string> {
  const field = WRITES_FILE[toolName]
  if (field === undefined) return output
  const value = (input as Record<string, unknown> | null)?.[field]
  if (typeof value !== "string") return output

  try {
    const file = resolveInside(cwd, value)

    /*
     * Format DULU, periksa belakangan.
     *
     * Urutannya bukan selera. Memformat sesudah memeriksa berarti diagnostics
     * yang dilaporkan menunjuk ke nomor baris berkas SEBELUM dirapikan — dan
     * setiap baris di laporan itu meleset dari berkas yang sekarang ada di disk.
     */
    const formatter = await formatFile(config, cwd, file).catch(() => undefined)

    const found = await diagnoseFile(config, cwd, file)
    /*
     * Perapian DILAPORKAN, tidak diam-diam.
     *
     * Setelah diformat, isi di disk tidak lagi sama persis dengan yang ditulis
     * model. `edit` mencocokkan string secara persis, jadi suntingan berikutnya
     * terhadap baris yang barusan dirapikan akan gagal — dan tanpa baris ini,
     * kegagalan itu tidak punya sebab yang terlihat.
     */
    const note = formatter ? `\n\n--- formatted by ${formatter} ---` : ""

    // `undefined` berarti TIDAK TAHU — tidak ada server, atau ia belum sempat
    // menjawab. Dibedakan dari array kosong, yang berarti sudah diperiksa dan
    // bersih.
    if (found === undefined) return `${output}${note}`
    return `${output}${note}${renderDiagnostics(relative(cwd, file), found)}`
  } catch {
    return output
  }
}

function buildTools(options: BuildToolsOptions): ToolSet {
  const { sessionID, cwd, signal, upsert } = options
  const set: ToolSet = {}

  for (const definition of activeTools({ ...options, ...(options.mcpTools ? { extra: options.mcpTools } : {}) })) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      async execute(original: unknown, options2: { toolCallId: string }) {
        const callID = options2.toolCallId
        const started = Date.now()
        /*
         * Kabar dari tool yang sedang berjalan, dibatasi lajunya.
         *
         * Dibuat untuk SETIAP panggilan, bukan sekali per sesi: `buffer` di
         * dalamnya milik satu panggilan, dan berbagi satu pembatas antar tool
         * akan membuat keluaran `npm test` muncul di bawah `grep` yang
         * kebetulan berjalan sesudahnya.
         */
        const progress = throttleProgress((tail) => {
          upsert(callID, definition.name, {
            status: "running",
            input: original,
            started,
            output: tail,
          })
        })

        const ctx = {
          cwd,
          sessionID,
          callID,
          signal,
          config: options.config,
          progress: (chunk: string) => progress.push(chunk),
          // Diwariskan `task` sebagai batas atas sub-agent. Lihat `narrower`.
          permission: options.permission,
          ...(options.model ? { model: options.model } : {}),
          /*
           * Siapa yang boleh dimintai bantuan, dihitung DI SINI karena hanya di
           * sini semua faktanya ada: apakah giliran ini anak, dan apakah
           * agent-nya punya `escalate`.
           *
           * Giliran utama boleh memanggil super agent mana pun yang terdaftar —
           * ia yang dipilih user, dan user yang mendaftarkan mereka. Sub-agent
           * hanya boleh ke satu tujuan yang disebut `escalate.to`-nya.
           */
          supersAllowed: options.isChild
            ? options.escalateTo === undefined
              ? []
              : [options.escalateTo]
            : Object.entries(options.config.externalAgent)
                .filter(([, agent]) => agent.enabled !== false)
                .map(([id]) => id),
          ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
        }
        upsert(callID, definition.name, { status: "running", input: original, started })

        try {
          /*
           * 0. Plugin melihat panggilan ini SEBELUM izin ditanyakan.
           *
           * Urutannya menentukan arti dialog izin. Kalau plugin berjalan
           * sesudah, ia bisa mengubah masukan setelah user menyetujui yang
           * lama — dan yang disetujui bukan lagi yang dijalankan. Di sini,
           * apa pun yang plugin ubah ikut terlihat di dialog.
           */
          const plugins = options.plugins ?? []
          let input = original
          if (plugins.length > 0) {
            const verdict = await runBefore(plugins, {
              tool: definition.name,
              input,
              sessionID,
              cwd,
            })
            if (verdict.deny !== undefined) {
              upsert(callID, definition.name, {
                status: "denied",
                input,
                title: definition.name,
                reason: verdict.deny,
                started,
                ended: Date.now(),
              })
              return `REFUSED by plugin: ${verdict.deny} The "${definition.name}" tool was not run.`
            }
            input = verdict.input
          }

          // 1. Izin. Tool yang mengubah sesuatu tidak pernah jalan tanpa ini.
          if (definition.permission) {
            const need = definition.permission(input, ctx)
            // Dicatat SEBELUM tool jalan: kalau dicatat sesudah, panggilan yang
            // memicu deteksi adalah yang sudah terlanjur dijalankan.
            const looping = noteCall(sessionID, definition.name, input)

            /*
             * Loop yang TIDAK menyela tetap harus terdengar.
             *
             * `doom_loop: "allow"` — yang dipakai build-auto — membuat deteksi
             * ini lewat tanpa dialog, dan itu memang yang diminta. Tapi diam
             * sepenuhnya berarti model yang berputar membakar token sampai
             * seseorang kebetulan memperhatikan. Satu kabar, sekali per sesi:
             * cukup untuk tahu, tidak cukup untuk mengganggu.
             */
            if (looping && options.permission.doom_loop === "allow") {
              noteLoop(sessionID, definition.name, options.streamSessionID)
            }
            const verdict = await ask({
              sessionID,
              permission: options.permission,
              kind: need.kind,
              title: need.title,
              detail: need.detail,
              pattern: need.pattern,
              // Diteruskan apa adanya, TERMASUK array kosong: kosong adalah
              // bagaimana bash mengabarkan bahwa perintahnya tidak bisa dinilai
              // per bagian, dan allowlist tidak boleh menyala (issue #12).
              ...(need.segments === undefined ? {} : { segments: need.segments }),
              ...(need.subject === undefined ? {} : { subject: need.subject }),
              ...(looping ? { looping: true } : {}),
              // Dihitung dari `streamSessionID`, BUKAN `sessionID` milik anak
              // sendiri: klien (TUI/CLI/server) hanya berlangganan stream sesi
              // PALING ATAS, jadi `listenerCount(sessionID)` untuk giliran
              // sub-agent selalu nol dan setiap tulisannya auto-deny sebelum
              // dialognya sempat terbentuk — lihat komentar `streamSessionID`
              // di `AskOptions`, src/core/permission.ts.
              listeners: bus.listenerCount(options.streamSessionID),
              signal,
              agent: options.agentID,
              allowlistSessionID: options.allowlistSessionID,
              streamSessionID: options.streamSessionID,
              turnScoped: options.isChild,
            })

            if (!verdict.granted) {
              upsert(callID, definition.name, {
                status: "denied",
                input,
                title: need.title,
                reason: verdict.reason,
                started,
                ended: Date.now(),
              })
              return `REFUSED: ${verdict.reason} The "${definition.name}" tool was not run.`
            }
          }

          // 2. Snapshot sebelum perubahan PERTAMA di giliran ini, sehingga satu
          //    `/undo` mengembalikan seluruh giliran, bukan satu tool saja.
          if (definition.mutates === true && !options.hasSnapshot()) {
            const commit = await take(cwd)
            if (commit) options.onSnapshot(commit)
          }

          const result = await definition.execute(input, ctx)
          /*
           * WAJIB, dan di sini bukan di `finally`.
           *
           * Potongan yang datang di jendela terakhir belum terbit, dan justru
           * potongan itu yang biasanya berisi hasilnya. Diterbitkan SEBELUM
           * state `completed` menggantikannya — sesudahnya ia hanya akan
           * menimpa hasil akhir dengan kabar sekilas.
           */
          progress.flush()

          /*
           * Diagnostics OTOMATIS, ditempelkan ke hasil tool yang baru saja
           * menyunting berkas.
           *
           * Di SINI, bukan di dalam masing-masing tool, karena aturannya sama
           * untuk semuanya dan menyalinnya ke `edit`, `patch`, dan `write`
           * berarti tool keempat yang menulis berkas akan melupakannya. Yang
           * dilihat model jadi: hasil suntingannya, lalu error yang baru saja
           * ia buat — tanpa perlu ingat memanggil apa pun.
           */
          /*
           * Plugin membentuk keluaran SEBELUM pemeriksa bawaan berjalan.
           *
           * Dengan urutan ini, plugin yang menulis ulang berkas — pemformat
           * milik proyek, penambal lisensi — sudah selesai ketika diagnostics
           * dijalankan, jadi yang dilaporkan adalah keadaan berkas yang
           * sebenarnya, bukan keadaan sesaat sebelum plugin menyentuhnya.
           */
          let output = result.output
          if (plugins.length > 0) {
            const shaped = await runAfter(plugins, {
              tool: definition.name,
              input,
              sessionID,
              cwd,
              output,
              title: result.title,
            })
            output = shaped.output
            for (const failure of shaped.failures) {
              // Dilaporkan, tidak menjatuhkan: kait ini hanya membentuk
              // keluaran yang sudah terjadi.
              bus.publish({
                type: "session.notice",
                sessionID: options.streamSessionID,
                message: `plugin ${failure.spec}: ${failure.reason}`,
              })
            }
          }

          /*
           * Catatan delegasi ditempel ke hasil `plan`, bukan ke system prompt.
           *
           * Tempatnya menentukan. Di system prompt ia jadi satu paragraf lagi
           * yang dibaca setiap giliran lalu tenggelam; di sini ia tiba tepat
           * pada saat rencananya baru selesai ditulis dan model sedang
           * memutuskan langkah berikutnya. Itu satu-satunya saat pertanyaannya
           * masih bisa mengubah apa pun.
           */
          if (definition.name === "plan") {
            // `text`, bukan `plan` — nama fieldnya diperiksa ke skema tool,
            // karena salah nama di sini menghasilkan catatan yang tidak pernah
            // muncul dan tidak pernah error.
            const text = (input as { text?: unknown } | null)?.text
            if (typeof text === "string") {
              output += delegationNote(options.config, options.streamSessionID, text)
            }
          }

          const withDiagnostics = await appendDiagnostics(
            options.config,
            cwd,
            definition.name,
            input,
            output,
          )
          // Output besar ke filesystem; model hanya menerima potongannya (Q11).
          const stored = storeOutput(callID, withDiagnostics)
          upsert(callID, definition.name, {
            status: "completed",
            input,
            title: result.title,
            output: stored.output,
            ...(stored.outputRef ? { outputRef: stored.outputRef } : {}),
            ...(result.outcome ? { outcome: result.outcome } : {}),
            truncated: stored.truncated,
            started,
            ended: Date.now(),
          })
          return stored.output
        } catch (error) {
          progress.flush()
          const message = error instanceof Error ? error.message : String(error)
          upsert(callID, definition.name, {
            // Yang ASLI, bukan yang sudah diubah plugin: `input` hidup di dalam
            // `try` dan tidak terjangkau dari sini, dan yang dicatat untuk
            // kegagalan sebaiknya memang apa yang model kirim.
            input: original,
            status: "error",
            error: message,
            started,
            ended: Date.now(),
          })
          // Dikembalikan sebagai teks, bukan dilempar: model harus tahu apa yang
          // gagal supaya bisa mencoba jalan lain, bukan berhenti buta.
          return `ERROR: ${message}`
        }
      },
    })
  }

  return set
}
