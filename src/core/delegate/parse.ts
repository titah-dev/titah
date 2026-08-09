import type { DelegationResult, DelegationUpdate } from "./types.ts"

/**
 * Parser output agent eksternal.
 *
 * Semuanya TOLERAN dengan sengaja (Q24): baris yang tidak dikenal dilewati,
 * bukan menggagalkan seluruh delegasi. Versi CLI berubah lebih sering daripada
 * Titah dirilis, dan satu field baru tidak boleh mematikan fitur ini.
 */

export type Format = "stream-json" | "json" | "text"

export interface ParserState {
  answer: string
  externalSessionID?: string
  usage: { input?: number; output?: number; cost?: number }
  isError: boolean
  errorMessage?: string
}

export interface Parser {
  /** Dipanggil per baris output. Boleh mengembalikan update untuk di-stream. */
  line(raw: string): DelegationUpdate[]
  state(): ParserState
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Claude Code: `-p --output-format stream-json --verbose`.
 *
 * Event yang penting hanya `result`; sisanya (hook, system, rate_limit) sengaja
 * diabaikan. `--verbose` wajib — tanpa itu Claude menolak stream-json.
 */
export function claudeParser(): Parser {
  const state: ParserState = { answer: "", usage: {}, isError: false }

  return {
    line(raw) {
      const trimmed = raw.trim()
      if (!trimmed.startsWith("{")) return []

      let event: Record<string, unknown> | undefined
      try {
        event = asRecord(JSON.parse(trimmed))
      } catch {
        return []
      }
      if (!event) return []

      const updates: DelegationUpdate[] = []
      const sessionID = str(event["session_id"])
      if (sessionID && state.externalSessionID !== sessionID) {
        state.externalSessionID = sessionID
        updates.push({ kind: "session", sessionID })
      }

      if (event["type"] === "assistant") {
        const message = asRecord(event["message"])
        const content = Array.isArray(message?.["content"]) ? message["content"] : []
        for (const item of content) {
          const part = asRecord(item)
          if (part?.["type"] === "text") {
            const text = str(part["text"])
            if (text) updates.push({ kind: "text", text })
          }
          if (part?.["type"] === "tool_use") {
            const name = str(part["name"]) ?? "tool"
            updates.push({ kind: "tool", name })
          }
        }
      }

      if (event["type"] === "result") {
        state.isError = event["is_error"] === true || event["subtype"] !== "success"
        state.answer = str(event["result"]) ?? ""
        if (state.isError && state.answer === "") {
          state.errorMessage = `Claude returned subtype "${String(event["subtype"])}".`
        }
        state.usage.cost = num(event["total_cost_usd"])
        const usage = asRecord(event["usage"])
        if (usage) {
          state.usage.input = num(usage["input_tokens"])
          state.usage.output = num(usage["output_tokens"])
        }
      }

      return updates
    },
    state: () => state,
  }
}

/**
 * opencode: `run --format json`.
 *
 * Jawaban dirakit dari seluruh part bertipe `text`; token dan biaya datang di
 * `step_finish`.
 */
export function opencodeParser(): Parser {
  const state: ParserState = { answer: "", usage: {}, isError: false }
  const chunks: string[] = []

  return {
    line(raw) {
      const trimmed = raw.trim()
      if (!trimmed.startsWith("{")) return []

      let event: Record<string, unknown> | undefined
      try {
        event = asRecord(JSON.parse(trimmed))
      } catch {
        return []
      }
      if (!event) return []

      const updates: DelegationUpdate[] = []
      const sessionID = str(event["sessionID"])
      if (sessionID && state.externalSessionID !== sessionID) {
        state.externalSessionID = sessionID
        updates.push({ kind: "session", sessionID })
      }

      const part = asRecord(event["part"])

      if (event["type"] === "text" && part) {
        const text = str(part["text"])
        if (text) {
          chunks.push(text)
          state.answer = chunks.join("")
          updates.push({ kind: "text", text })
        }
      }

      if (event["type"] === "tool" && part) {
        updates.push({ kind: "tool", name: str(part["tool"]) ?? "tool" })
      }

      if (event["type"] === "step_finish" && part) {
        const tokens = asRecord(part["tokens"])
        if (tokens) {
          state.usage.input = num(tokens["input"])
          state.usage.output = num(tokens["output"])
        }
        state.usage.cost = num(part["cost"])
      }

      if (event["type"] === "error") {
        state.isError = true
        state.errorMessage = str(event["message"]) ?? "opencode reported an error."
      }

      return updates
    },
    state: () => state,
  }
}

/** Fallback: seluruh stdout dianggap sebagai jawaban. */
export function textParser(): Parser {
  const lines: string[] = []
  const state: ParserState = { answer: "", usage: {}, isError: false }

  return {
    line(raw) {
      lines.push(raw)
      state.answer = lines.join("\n").trim()
      return raw.trim() === "" ? [] : [{ kind: "text", text: `${raw}\n` }]
    },
    state: () => state,
  }
}

export function parserFor(format: Format, agentID: string): Parser {
  if (format === "stream-json") return agentID === "opencode" ? opencodeParser() : claudeParser()
  if (format === "json") return agentID === "claude" ? claudeParser() : opencodeParser()
  return textParser()
}

export function finalize(
  parser: Parser,
  transcript: string,
  durationMs: number,
): DelegationResult {
  const state = parser.state()
  return {
    answer: state.answer.trim(),
    ...(state.externalSessionID ? { externalSessionID: state.externalSessionID } : {}),
    usage: state.usage,
    durationMs,
    transcript,
    isError: state.isError,
    ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
  }
}
