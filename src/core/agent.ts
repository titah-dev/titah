import crypto from "node:crypto"
import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai"
import { loadConfig } from "./config.ts"
import type { Config } from "./schema.ts"
import { bus } from "./event.ts"
import type { Message, Part, Session, ToolState } from "./message.ts"
import { buildSystemPrompt } from "./prompt.ts"
import { resolveModel } from "./provider.ts"
import { adapterFor, parseMention, listAgents, type Mention } from "./delegate/index.ts"
import { parseCommand, resolveCommand, isBuiltin, isSkillCommand, listCommands } from "./command.ts"
import { runConsensus, synthesizerFor } from "./consensus.ts"
import {
  COMPACT_SYSTEM,
  compactPrompt,
  planCompaction,
  renderTranscript,
  wrapSummary,
} from "./compact.ts"
import {
  discoverSkills,
  renderSkill,
  renderSkillReport,
  skillById,
  skillCommandMessage,
} from "./skill.ts"
import { ask, effectivePermission, setAutoApprove, type EffectivePermission } from "./permission.ts"
import { externalSessionFor, rememberExternalSession } from "./storage/external.ts"
import { take } from "./snapshot.ts"
import { storeOutput } from "./storage/blob.ts"
import {
  appendModelMessages,
  latestCompaction,
  listModelRows,
  saveCompaction,
  createMessage,
  getSession,
  listModelMessages,
  saveMessage,
  touchSession,
} from "./storage/session.ts"
import { TOOLS } from "./tool/index.ts"
import type { TitahTool } from "./tool/index.ts"

const MAX_STEPS = 20

export class AgentError extends Error {}

/** Satu turn berjalan per sesi. Dipakai `abort()` dan penolakan prompt ganda. */
const running = new Map<string, AbortController>()

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

/** `Esc` di TUI membatalkan SELURUH turn, bukan hanya tool yang sedang jalan (Q17). */
export function abort(sessionID: string): boolean {
  const controller = running.get(sessionID)
  if (!controller) return false
  controller.abort()
  return true
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
    } else if (isBuiltin(command.name)) {
      return builtinTurn(session, config, command.name, command.args, input)
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
  const { system } = buildSystemPrompt(config, session.directory, agentID)

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

  const history = listModelMessages(session.id)
  const userTurn: ModelMessage = skillMessage ?? { role: "user", content: text }
  const messages: ModelMessage[] = [...history, userTurn]

  try {
    const result = streamText({
      model,
      system,
      messages,
      tools: buildTools({
        sessionID: session.id,
        cwd: session.directory,
        config,
        signal: controller.signal,
        upsert: upsertTool,
        permission: effectivePermission(config, agentID, agentDef),
        isChild,
        ...(session.parentID ? { parentSessionID: session.parentID } : {}),
        ...(agentDef ? { toolFilter: agentDef.tools } : {}),
        onSnapshot: (commit) => {
          assistant.snapshot = commit
        },
        hasSnapshot: () => assistant.snapshot !== undefined,
      }),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: controller.signal,
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
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

        case "finish": {
          assistant.usage = {
            ...(part.totalUsage.inputTokens !== undefined
              ? { input: part.totalUsage.inputTokens }
              : {}),
            ...(part.totalUsage.outputTokens !== undefined
              ? { output: part.totalUsage.outputTokens }
              : {}),
          }
          break
        }

        default:
          // Sisa event stream (tool-call, start-step, reasoning, ...) tidak perlu
          // dilaporkan sendiri: state tool sudah dipublikasikan dari dalam execute.
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
    appendModelMessages(session.id, [
      userTurn,
      ...steps.flatMap((step) => step.response.messages),
    ])
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
): Promise<Message> {
  if (name === "compact") return compactTurn(session, config, args.trim(), input)
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
): Promise<Message> {
  const previous = latestCompaction(session.id)
  const rows = listModelRows(session.id).filter((row) => !previous || row.seq > previous.seq)
  const plan = planCompaction(rows)

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

    const summarise = synthesizerFor(resolver(config, input.model))
    const summary = await summarise(COMPACT_SYSTEM, compactPrompt(source, focus))

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
      synthesize = synthesizerFor(resolver(config, input.model))
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
  /** Terisi kalau `sessionID` sendiri adalah sesi anak. Diteruskan ke `ToolContext`. */
  parentSessionID?: string
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
}): TitahTool[] {
  return TOOLS.filter((definition) => {
    if (definition.name === "task" && options.isChild) return false
    if (options.toolFilter?.[definition.name] === false) return false
    return true
  })
}

/** Nama tool yang aktif untuk bentuk options tertentu — lihat `activeTools`. */
export function buildToolNames(options: { isChild: boolean }): string[] {
  return activeTools(options).map((definition) => definition.name)
}

function buildTools(options: BuildToolsOptions): ToolSet {
  const { sessionID, cwd, signal, upsert, parentSessionID } = options
  const set: ToolSet = {}

  for (const definition of activeTools(options)) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      async execute(input: unknown, options2: { toolCallId: string }) {
        const callID = options2.toolCallId
        const started = Date.now()
        const ctx = {
          cwd,
          sessionID,
          callID,
          signal,
          config: options.config,
          ...(parentSessionID ? { parentSessionID } : {}),
        }
        upsert(callID, definition.name, { status: "running", input, started })

        try {
          // 1. Izin dulu. Tool yang mengubah sesuatu tidak pernah jalan tanpa ini.
          if (definition.permission) {
            const need = definition.permission(input, ctx)
            const verdict = await ask({
              sessionID,
              permission: options.permission,
              kind: need.kind,
              title: need.title,
              detail: need.detail,
              pattern: need.pattern,
              listeners: bus.listenerCount(sessionID),
              signal,
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
          // Output besar ke filesystem; model hanya menerima potongannya (Q11).
          const stored = storeOutput(callID, result.output)
          upsert(callID, definition.name, {
            status: "completed",
            input,
            title: result.title,
            output: stored.output,
            ...(stored.outputRef ? { outputRef: stored.outputRef } : {}),
            truncated: stored.truncated,
            started,
            ended: Date.now(),
          })
          return stored.output
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          upsert(callID, definition.name, {
            status: "error",
            input,
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
