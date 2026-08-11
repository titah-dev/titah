import {
  COMPACT_SYSTEM,
  compactPrompt,
  estimateTokens,
  midTurnCut,
  overBudget,
  planAtCut,
  pruneToolOutputs,
  renderTranscript,
  tailStart,
  wrapSummary,
} from "./compact.ts"
import type { Compaction } from "./schema.ts"
import {
  latestCompaction,
  listModelRows,
  replaceModelMessage,
  saveCompaction,
} from "./storage/session.ts"

export interface AutoCompactInput {
  sessionID: string
  compaction: Compaction
  contextWindow: number | undefined
  lastStepTokens: number | undefined
  /** Peringkas: (system, prompt) => summary. Disuntik supaya bisa diuji tanpa provider. */
  summarise: (system: string, prompt: string) => Promise<string>
  /** Instruksi giliran berjalan, diteruskan sebagai `focus`. */
  focus?: string
  /** Batas potong mid-turn, dipakai Task 6. Antar-giliran biarkan undefined. */
  midTurnKeep?: number
}

export interface AutoCompactResult {
  ran: boolean
  prunedBytes: number
  summarised: boolean
}

const IDLE: AutoCompactResult = { ran: false, prunedBytes: 0, summarised: false }

/**
 * Memadatkan konteks sesi saat sudah mendekati batas jendela model.
 *
 * Satu jalur untuk dua situasi. Di tengah giliran, pemanggil sudah lebih dulu
 * menuliskan pesan giliran-sejauh-ini menjadi baris — sesuatu yang toh akan
 * ditulis di akhir giliran. Dengan begitu mesin pemadatan yang sudah ada (yang
 * bekerja atas baris dan batas air) dipakai apa adanya, alih-alih membangun
 * jalur kedua atas array di memori yang tidak meninggalkan jejak dan langsung
 * terhapus begitu gilirannya usai.
 */
export async function autoCompact(input: AutoCompactInput): Promise<AutoCompactResult> {
  const { compaction, sessionID } = input
  if (!compaction.auto) return IDLE
  if (!overBudget(input.lastStepTokens, input.contextWindow, compaction.reserved)) return IDLE

  const previous = latestCompaction(sessionID)
  const rows = listModelRows(sessionID).filter((row) => !previous || row.seq > previous.seq)
  if (rows.length === 0) return IDLE

  const messages = rows.map((row) => row.message)
  const cut =
    input.midTurnKeep === undefined
      ? tailStart(messages, compaction.tailTurns)
      : midTurnCut(messages, input.midTurnKeep)

  let prunedBytes = 0
  if (compaction.prune && cut > 0) {
    const pruned = pruneToolOutputs(messages, cut)
    prunedBytes = pruned.bytesFreed
    if (prunedBytes > 0) {
      for (const [index, message] of pruned.messages.entries()) {
        if (message === messages[index]) continue
        const row = rows[index]
        if (row) replaceModelMessage(sessionID, row.seq, message)
      }
    }
  }

  // Estimasi HANYA untuk keputusan tingkat kedua ini. Pemicunya sendiri tetap
  // memakai angka yang dilaporkan provider, tidak pernah taksiran.
  const remaining = (input.lastStepTokens ?? 0) - estimateTokens(prunedBytes)
  if (!overBudget(remaining, input.contextWindow, compaction.reserved)) {
    return { ran: true, prunedBytes, summarised: false }
  }

  // Batas potong yang SAMA dengan yang dipakai prune — satu aturan, bukan dua.
  const plan = planAtCut(rows, cut)
  if (plan.dropped.length === 0) return { ran: true, prunedBytes, summarised: false }

  // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk — menumpuk
  // membuat ringkasan tumbuh tanpa batas, persis masalah yang mau dipecahkan.
  const source = previous
    ? `${previous.summary}\n\n${renderTranscript(plan.dropped)}`
    : renderTranscript(plan.dropped)

  const summary = await input.summarise(COMPACT_SYSTEM, compactPrompt(source, input.focus))
  if (summary.trim() === "") return { ran: true, prunedBytes, summarised: false }

  saveCompaction(sessionID, plan.watermark, wrapSummary(summary))
  return { ran: true, prunedBytes, summarised: true }
}
