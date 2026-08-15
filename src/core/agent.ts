import crypto from "node:crypto"
import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { loadConfig } from "./config.ts"
import type { Config } from "./schema.ts"
import { bus } from "./event.ts"
import type { Message, Part, Session, ToolState } from "./message.ts"
import { buildSystemPrompt } from "./prompt.ts"
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
  splitModelRequest,
  saveMessage,
  touchSession,
} from "./storage/session.ts"
import { allTools } from "./tool/index.ts"
import type { TitahTool } from "./tool/index.ts"
import { dispatchableAgents } from "./subagent.ts"

/** Batas langkah bawaan, dipakai agent yang tidak menyatakan `steps` sendiri. */
const MAX_STEPS = 20

/**
 * Ditambahkan ke system prompt HANYA untuk /tim. Sengaja tidak menyebut nama
 * agent satu per satu di sini — daftarnya berubah per config, dan menaruhnya
 * di prompt statis berarti dua sumber kebenaran yang bisa saling menyimpang.
 * `buildTeamPrompt` di bawah menempelkan roster sungguhan setelah teks ini.
 */
const TEAM_PROMPT = [
  "For this turn you are coordinating a team. Split the work across these sub-agents and",
  "dispatch them with the `task` tool; several calls in one step run at the same time.",
  "Agents that may write files are serialised for you — do not try to order them yourself.",
  "Do the work that is left over yourself rather than inventing an agent for it.",
].join("\n")

/** Ditunjukkan saat `/tim` dipanggil tanpa satu pun agent yang bisa dibawahi. */
const NO_ROSTER_MESSAGE =
  'No sub-agents are configured yet. Add `"mode": "subagent"` (or `"all"`) to an `agent` ' +
  'block in titah.json — for example `"agent": { "explore": { "mode": "subagent" } }` — ' +
  "then run /tim again."

/** Roster + TEAM_PROMPT, dirakit sekali di sini supaya /tim sendiri tetap tanpa mesin. */
function buildTeamPrompt(config: Config, roster: string[]): string {
  const lines = roster.map((id) => {
    const description = config.agent[id]?.description
    return description ? `  ${id} — ${description}` : `  ${id}`
  })
  return [TEAM_PROMPT, "", "Sub-agents you can dispatch with `task`:", ...lines].join("\n")
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
  /** Menyetujui otomatis izin yang tidak ditolak eksplisit oleh config. */
  auto?: boolean
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
      const roster = dispatchableAgents(config)
      if (roster.length === 0) {
        return infoTurn(session, input.text, NO_ROSTER_MESSAGE, true)
      }
      if (command.args === "") {
        return infoTurn(session, input.text, "Usage: /tim <task>", true)
      }
      text = command.args
      teamPrompt = buildTeamPrompt(config, roster)
    } else if (isBuiltin(command.name)) {
      return builtinTurn(
        session,
        config,
        command.name,
        command.args,
        input,
        turnModelFor(config, agentID, modelOverride),
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

  const model = resolver(config, agentDef?.model ?? modelOverride)
  const built = buildSystemPrompt(config, session.directory, agentID)
  const system = teamPrompt ? `${built.system}\n\n${teamPrompt}` : built.system

  const userMessage = createMessage(session.id, "user", [{ type: "text", text: input.text }])
  bus.publish({ type: "message.updated", sessionID: session.id, message: userMessage })

  if (session.title === "") {
    const title = input.text.replace(/\s+/g, " ").slice(0, 80)
    const updated = touchSession(session.id, { title })
    if (updated) bus.publish({ type: "session.updated", sessionID: session.id, session: updated })
  }

  const assistant = createMessage(session.id, "assistant", [])
  assistant.model = agentDef?.model ?? modelOverride ?? config.model
  bus.publish({ type: "message.updated", sessionID: session.id, message: assistant })

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
  const modelID = turnModelFor(config, agentID, modelOverride)
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
    const maxSteps = agentDef?.steps ?? MAX_STEPS

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
        plugins: loaded.plugins,
        contextWindow,
        sessionID: session.id,
        cwd: session.directory,
        config,
        signal: controller.signal,
        upsert: upsertTool,
        permission: effectivePermission(config, agentID, agentDef),
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
        const lastStep = stepNumber >= maxSteps - 1
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
            return lastStep ? { activeTools: [] } : {}
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
          if (!compacted.changed) return lastStep ? { activeTools: [] } : {}

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

          return lastStep ? { activeTools: [], messages: rebuilt } : { messages: rebuilt }
        } catch {
          // Gagal memadatkan DI TENGAH giliran berarti "lewati pemadatan
          // langkah ini", bukan "jatuhkan seluruh giliran yang sudah
          // menempuh beberapa tool". Tanpa tangkapan ini, resolver smallModel
          // yang salah melempar DI SINI dan giliran berakhir dengan error
          // serta jawaban kosong, padahal beberapa tool sudah berhasil jalan
          // — pasangan persis `catch {}` di jalur antar-giliran di atas.
          // `lastStep` tetap dihormati: kegagalan memadatkan tidak boleh
          // membiarkan giliran berakhir pada tool call lagi.
          return lastStep ? { activeTools: [] } : {}
        }
      },
      stopWhen: stepCountIs(maxSteps),
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
    bus.publish({ type: "session.idle", sessionID: session.id })
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
  toolFilter?: Record<string, boolean>
  /** Tool dari server MCP, sudah dibungkus. Kosong kalau tidak ada yang dikonfigurasi. */
  extra?: TitahTool[]
}): TitahTool[] {
  return [...allTools(), ...(options.extra ?? [])].filter((definition) => {
    if (definition.name === "task" && options.isChild) return false
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
