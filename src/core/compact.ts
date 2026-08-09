import type { ModelMessage } from "ai"
import type { ModelRow } from "./storage/session.ts"

/**
 * Manajemen konteks: memadatkan percakapan yang sudah panjang menjadi ringkasan,
 * supaya giliran berikutnya tidak melewati jendela konteks model.
 *
 * Jendela yang terlampaui adalah penyebab halusinasi yang paling senyap. Provider
 * tidak menolak permintaannya — mereka MEMOTONG bagian paling awal, dan model
 * lalu menjawab dengan percaya diri tentang keputusan yang sudah tidak dilihatnya.
 * ollama bahkan memotong di `num_ctx` 4096 tanpa satu pun peringatan.
 */

/**
 * Berapa pesan terakhir yang tetap dikirim apa adanya.
 *
 * Ringkasan selalu kehilangan sesuatu. Menyisakan pertukaran terakhir secara
 * utuh membuat jawaban tepat SETELAH pemadatan tidak mendadak kehilangan detail
 * dari kalimat yang barusan diketik user.
 */
export const KEEP_TAIL = 4

/**
 * Batas potong: indeks pesan pertama yang dipertahankan.
 *
 * Wajib jatuh di pesan `user`. Memotong di tengah pasangan tool-call/tool-result
 * meninggalkan tool-result yatim di awal riwayat, dan provider menolak itu
 * dengan error yang tidak menyebut pemadatan sama sekali.
 */
export function tailStart(messages: ModelMessage[], keepTail = KEEP_TAIL): number {
  // Percakapan yang lebih pendek dari ekor tidak punya apa pun untuk dipadatkan.
  // Ini BEDA dari "tidak ada batas aman" di bawah, walau keduanya sama-sama
  // berarti tidak ada yang dipotong di tengah — yang satu mempertahankan semua,
  // yang satu meringkas semua.
  if (messages.length <= keepTail) return 0

  for (let index = messages.length - keepTail; index > 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  // Ekor tidak punya batas aman — ringkas semuanya daripada meninggalkan yatim.
  return messages.length
}

export interface CompactionPlan {
  /** Pesan yang akan diringkas. Kosong berarti tidak ada yang perlu dipadatkan. */
  dropped: ModelMessage[]
  /** seq terakhir yang diwakili ringkasan, untuk disimpan sebagai batas air. */
  watermark: number
  /** Berapa pesan yang tetap dikirim apa adanya. */
  kept: number
}

/**
 * Menyusun rencana pemadatan dari baris yang BELUM dipadatkan.
 *
 * `rows` harus sudah disaring ke atas batas air sebelumnya, sehingga pemadatan
 * berulang tidak pernah meringkas dua kali hal yang sama.
 */
export function planCompaction(rows: ModelRow[], keepTail = KEEP_TAIL): CompactionPlan {
  const messages = rows.map((row) => row.message)
  const cut = tailStart(messages, keepTail)
  const dropped = messages.slice(0, cut)

  // Batas air = seq terakhir yang diringkas. Kalau semuanya diringkas, itu seq
  // baris terakhir; kalau tidak, satu di bawah baris pertama yang dipertahankan.
  const firstKept = rows[cut]
  const lastRow = rows.at(-1)
  const watermark = firstKept ? firstKept.seq - 1 : (lastRow?.seq ?? -1)

  return { dropped, watermark, kept: rows.length - cut }
}

/** Menjadikan satu pesan model teks datar yang bisa dibaca peringkas. */
export function renderMessage(message: ModelMessage): string {
  const { role, content } = message
  if (typeof content === "string") return `${role}: ${content}`

  const parts: string[] = []
  for (const part of content as { type: string; [key: string]: unknown }[]) {
    if (part["type"] === "text") parts.push(String(part["text"]))
    else if (part["type"] === "tool-call") {
      parts.push(`[calls ${String(part["toolName"])} ${JSON.stringify(part["input"] ?? {})}]`)
    } else if (part["type"] === "tool-result") {
      const output = JSON.stringify(part["output"] ?? "")
      parts.push(`[result of ${String(part["toolName"])}: ${output.slice(0, 400)}]`)
    } else if (part["type"] === "reasoning") {
      // Penalaran sengaja dibuang: ia panjang, dan ia PROSES menuju keputusan,
      // bukan keputusannya. Meringkasnya membuang ruang untuk fakta.
      continue
    }
  }
  return `${role}: ${parts.join("\n")}`
}

export function renderTranscript(messages: ModelMessage[]): string {
  return messages.map(renderMessage).join("\n\n")
}

/**
 * Instruksi peringkas.
 *
 * Ditulis seluruhnya seputar satu kegagalan: ringkasan yang mengarang. Ringkasan
 * yang meleset lebih berbahaya daripada tidak ada ringkasan, karena ia terbaca
 * sebagai catatan yang sudah disepakati dan model tidak punya cara memeriksanya.
 */
export const COMPACT_SYSTEM = [
  "You compress a coding session's history into a briefing for the same assistant to continue from.",
  "",
  "Rules, in order of importance:",
  "1. Never invent. Every file path, command, identifier, number, and decision must appear in the transcript. If you are unsure whether something was decided, write that it is unresolved.",
  "2. Copy identifiers verbatim — file paths, function names, flags, error messages, versions. Do not normalise, translate, or tidy them.",
  "3. Preserve what constrains future work: decisions and the reasoning behind them, constraints the user stated, things that were tried and failed and why, and anything the user explicitly asked for or refused.",
  "4. Drop what is reconstructible: tool output that can be re-read, exploration that led nowhere, restatements.",
  "5. A <skill name=\"…\"> block is loaded instructions, not conversation. Record which skills were loaded and any decision made because of them — never copy the skill text itself.",
  "6. Record unfinished work explicitly, including what the next step was.",
  "",
  "Write it under these headings, omitting any that have no content:",
  "  Goal · Decisions · Constraints · Files touched · Done · Not done · Open questions",
  "",
  "Write plain prose and short lists. No preamble, no closing remarks, no offer to help.",
].join("\n")

export function compactPrompt(transcript: string, focus?: string): string {
  const instruction = focus?.trim()
    ? `\n\nThe user asked you to pay particular attention to: ${focus.trim()}\nKeep that material in full detail. Summarise the rest normally — do not drop it.`
    : ""
  return `Here is the session transcript to compress.\n\n<transcript>\n${transcript}\n</transcript>${instruction}`
}

/** Membungkus ringkasan supaya model tahu ini catatan, bukan ucapan user. */
export function wrapSummary(summary: string): string {
  return [
    "<context-summary>",
    "This is a compacted summary of the earlier part of this session, not a new request.",
    "Treat it as the record of what happened. If something you need is not in it, say so and ask — do not assume.",
    "",
    summary.trim(),
    "</context-summary>",
  ].join("\n")
}
