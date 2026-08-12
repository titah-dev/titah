import { streamText } from "ai"
import { buildAdapters } from "./delegate/index.ts"
import type { DelegationResult } from "./delegate/types.ts"
import type { Config } from "./schema.ts"

/**
 * Mode konsensus (Q23): satu pertanyaan disebar ke semua agent eksternal yang
 * tersedia, lalu jawabannya disintesis dan ketidaksepakatannya ditandai.
 *
 * Ini melanggar semangat "tanpa konkurensi" di Q21, tapi konkurensinya DATAR
 * dan berbatas jumlah agent — bukan rekursif seperti subagent. Itu perbedaan
 * yang membuatnya aman.
 */

export interface AgentAnswer {
  agentID: string
  answer: string
  durationMs: number
  usage: DelegationResult["usage"]
  error?: string
}

export interface ConsensusResult {
  answers: AgentAnswer[]
  synthesis: string
  /** Agent yang gagal tetap dilaporkan — diam-diam menghilang lebih buruk. */
  failed: string[]
}

const SYNTHESIS_PROMPT = `You are comparing answers from several coding agents to the same question.

Your job:
1. State briefly what ALL of them agree on.
2. Mark explicitly where they DISAGREE, and say which agent said what.
3. If any answer is clearly wrong or does not answer the question, say so.
4. Close with a one-paragraph recommendation.

Do not invent agreement that is not there. The disagreements are the most
valuable information here — they are the reason the user asked several agents at
once. Reply in the language of the question.`

export interface ConsensusOptions {
  config: Config
  question: string
  cwd: string
  signal: AbortSignal
  /** Model Titah untuk sintesis. Tanpa ini, hanya jawaban mentah yang dikembalikan. */
  synthesize?: (system: string, prompt: string) => Promise<string>
  onUpdate?: (agentID: string, note: string) => void
  /**
   * Dipanggil segera setelah SATU agent selesai, tanpa menunggu yang lain.
   *
   * Tanpa ini, agent yang rampung lebih dulu tetap terlihat "berjalan" sampai
   * agent paling lambat selesai — dan pada praktiknya selisihnya bisa menit.
   */
  onAnswer?: (answer: AgentAnswer) => void
}

export function buildComparison(answers: AgentAnswer[], question: string): string {
  const sections = answers
    .filter((answer) => answer.error === undefined)
    .map((answer) => `### Answer from @${answer.agentID}\n${answer.answer}`)
  return `Question:\n${question}\n\n${sections.join("\n\n")}`
}

export async function runConsensus(options: ConsensusOptions): Promise<ConsensusResult> {
  const adapters = [...buildAdapters(options.config).values()].filter(
    (adapter) => adapter.available,
  )

  if (adapters.length === 0) {
    return {
      answers: [],
      synthesis:
        "No external agents are available. Install `claude` or `opencode`, " +
        "then check with `titah doctor`.",
      failed: [],
    }
  }

  // Sengaja tidak memakai pemetaan sesi: konsensus harus membandingkan jawaban
  // atas pertanyaan YANG SAMA, bukan jawaban yang bias oleh riwayat masing-masing.
  const settled = await Promise.all(
    adapters.map(async (adapter): Promise<AgentAnswer> => {
      const started = Date.now()
      options.onUpdate?.(adapter.id, "started")
      try {
        const result = await adapter.prompt({
          prompt: options.question,
          cwd: options.cwd,
          signal: options.signal,
        })
        options.onUpdate?.(adapter.id, result.isError ? "failed" : "done")
        const answer: AgentAnswer = {
          agentID: adapter.id,
          answer: result.answer,
          durationMs: result.durationMs,
          usage: result.usage,
          ...(result.isError ? { error: result.errorMessage ?? "failed without explanation" } : {}),
        }
        options.onAnswer?.(answer)
        return answer
      } catch (error) {
        options.onUpdate?.(adapter.id, "failed")
        const answer: AgentAnswer = {
          agentID: adapter.id,
          answer: "",
          durationMs: Date.now() - started,
          usage: {},
          error: error instanceof Error ? error.message : String(error),
        }
        options.onAnswer?.(answer)
        return answer
      }
    }),
  )

  const failed = settled.filter((answer) => answer.error !== undefined).map((a) => a.agentID)
  const usable = settled.filter((answer) => answer.error === undefined && answer.answer !== "")

  if (usable.length === 0) {
    return { answers: settled, synthesis: "No agent managed to answer.", failed }
  }

  if (usable.length === 1) {
    const only = usable[0] as AgentAnswer
    return {
      answers: settled,
      synthesis: `Only @${only.agentID} answered, so there is nothing to compare.`,
      failed,
    }
  }

  if (!options.synthesize) {
    return {
      answers: settled,
      synthesis: "(synthesis skipped: no Titah model configured)",
      failed,
    }
  }

  const synthesis = await options.synthesize(
    SYNTHESIS_PROMPT,
    buildComparison(usable, options.question),
  )
  return { answers: settled, synthesis, failed }
}

/**
 * Pembungkus pemanggilan model, dipisah supaya `runConsensus` bisa diuji tanpa LLM.
 *
 * Memakai `streamText`, BUKAN `generateText`: sebagian endpoint OpenAI-compatible
 * (termasuk 9router di mesin pengembang) selalu membalas dalam bentuk SSE meski
 * diminta non-streaming, sehingga `generateText` gagal dengan "Invalid JSON
 * response". Seluruh jalur lain di Titah sudah streaming — ini yang tertinggal.
 *
 * `abortSignal` WAJIB diteruskan oleh pemanggil yang gilirannya bisa dibatalkan.
 * Sejak pemadatan berjalan otomatis, panggilan ini tidak lagi diminta user:
 * smallModel yang menggantung tanpanya membuat `Esc` mengembalikan "berhasil
 * dibatalkan" sementara gilirannya tetap hidup, dan sesi itu menolak SETIAP
 * prompt berikutnya sepanjang umur proses.
 */
export function synthesizerFor(
  model: Parameters<typeof streamText>[0]["model"],
  abortSignal?: AbortSignal,
) {
  return async (system: string, prompt: string): Promise<string> => {
    const result = streamText({ model, system, prompt, ...(abortSignal ? { abortSignal } : {}) })
    let text = ""
    for await (const chunk of result.textStream) text += chunk
    return text.trim()
  }
}
