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
  /**
   * Batas ekor untuk pemadatan DI TENGAH giliran. Antar-giliran biarkan
   * undefined — di sana batasnya dihitung per giliran user (`tailStart`),
   * bukan per pesan, karena batas giliran memang masih ada untuk dihitung.
   */
  midTurn?: { keepMessages: number; budgetBytes: number }
  /** Tempat yang dipesan untuk pertumbuhan satu langkah — lihat `overBudget`. */
  growthMargin?: number
}

export interface AutoCompactResult {
  ran: boolean
  prunedBytes: number
  summarised: boolean
  /**
   * Apakah pemadatan SUNGGUH membebaskan sesuatu.
   *
   * `ran` saja tidak bisa membedakan "menyala dan menolong" dari "menyala dan
   * tidak bisa berbuat apa-apa" — dan justru yang kedua itu yang membuat
   * kegagalan mid-turn tak terlihat begitu lama: pemanggilnya menyusun ulang
   * riwayat, melaporkan sukses, dan mengirim konteks yang sama besarnya.
   */
  changed: boolean
}

const IDLE: AutoCompactResult = { ran: false, prunedBytes: 0, summarised: false, changed: false }

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
  const growth = input.growthMargin ?? 0
  if (!overBudget(input.lastStepTokens, input.contextWindow, compaction.reserved, growth)) {
    return IDLE
  }

  const previous = latestCompaction(sessionID)
  const rows = listModelRows(sessionID).filter((row) => !previous || row.seq > previous.seq)
  if (rows.length === 0) return IDLE

  const messages = rows.map((row) => row.message)
  const cut =
    input.midTurn === undefined
      ? tailStart(messages, compaction.tailTurns)
      : midTurnCut(messages, input.midTurn.keepMessages, input.midTurn.budgetBytes)

  // Versi termutakhir tiap pesan. Prune tahap kedua bekerja di atas hasil tahap
  // pertama, supaya byte yang sudah dibebaskan tidak terhitung dua kali.
  let current = messages
  let prunedBytes = 0

  const prune = (from: number, upTo: number): void => {
    const result = pruneToolOutputs(current, upTo, from)
    if (result.bytesFreed === 0) return
    for (const [index, message] of result.messages.entries()) {
      if (message === current[index]) continue
      const row = rows[index]
      if (row) replaceModelMessage(sessionID, row.seq, message)
    }
    current = result.messages
    prunedBytes += result.bytesFreed
  }

  if (compaction.prune && cut > 0) prune(0, cut)

  // Estimasi HANYA untuk keputusan tingkat kedua ini. Pemicunya sendiri tetap
  // memakai angka yang dilaporkan provider, tidak pernah taksiran.
  const stillOver = (freedBytes: number): boolean =>
    overBudget(
      (input.lastStepTokens ?? 0) - estimateTokens(freedBytes),
      input.contextWindow,
      compaction.reserved,
      growth,
    )

  const done = (summarised: boolean): AutoCompactResult => ({
    ran: true,
    prunedBytes,
    summarised,
    changed: prunedBytes > 0 || summarised,
  })

  if (!stillOver(prunedBytes)) return done(false)

  // Batas potong yang SAMA dengan yang dipakai prune — satu aturan, bukan dua.
  const plan = planAtCut(rows, cut)
  let summarised = false
  let summaryFreed = 0

  if (plan.dropped.length > 0) {
    // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk — menumpuk
    // membuat ringkasan tumbuh tanpa batas, persis masalah yang mau dipecahkan.
    const droppedText = renderTranscript(plan.dropped)
    const source = previous ? `${previous.summary}\n\n${droppedText}` : droppedText

    const summary = await input.summarise(COMPACT_SYSTEM, compactPrompt(source, input.focus))
    if (summary.trim() !== "") {
      saveCompaction(sessionID, plan.watermark, wrapSummary(summary))
      summarised = true
      summaryFreed = Math.max(
        0,
        Buffer.byteLength(droppedText) - Buffer.byteLength(wrapSummary(summary)),
      )
    }
  }

  // Upaya terakhir: pangkas hasil tool DI DALAM ekor juga.
  //
  // Ekor dipertahankan apa adanya justru supaya model bisa melanjutkan, tapi
  // satu hasil tool yang lebih besar dari seluruh anggaran membuat ekor itu
  // sendiri jadi penyebab luapan — dan tidak ada pemotongan maupun peringkasan
  // yang bisa menjangkaunya. Aman dilakukan karena prune tidak pernah MENGHAPUS
  // pesan: tidak ada hasil yang jadi yatim, dan model bisa membaca ulang
  // berkasnya. Baru dijalankan paling akhir, setelah dua mekanisme yang lebih
  // murah terbukti tidak cukup.
  if (compaction.prune && stillOver(prunedBytes + summaryFreed)) prune(cut, current.length)

  return done(summarised)
}
