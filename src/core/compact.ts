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
 * Berapa GILIRAN user terakhir yang tetap dikirim apa adanya.
 *
 * Dihitung dalam giliran, bukan pesan: satu giliran agentic bisa berisi dua
 * puluh pesan, jadi "4 pesan terakhir" bisa berarti empat hasil tool dari
 * tengah giliran — instruksinya sudah hilang, dan tidak satu pun pertukaran
 * tersisa utuh. Giliran adalah satuan yang bisa dibayangkan user.
 */
export const KEEP_TURNS = 2

/**
 * Batas potong: indeks pesan pertama yang dipertahankan.
 *
 * Wajib jatuh di pesan `user`. Memotong di tengah pasangan tool-call/tool-result
 * meninggalkan tool-result yatim di awal riwayat, dan provider menolak itu
 * dengan error yang tidak menyebut pemadatan sama sekali.
 */
export function tailStart(messages: ModelMessage[], keepTurns = KEEP_TURNS): number {
  // keepTurns <= 0 berarti TIDAK ADA giliran yang disisakan — ringkas semuanya,
  // jadi kembalikan panjang penuh. Ini KEBALIKAN dari fallback `return 0` di
  // bawah: keduanya angka "batas", tapi 0 di sana berarti giliran yang ADA
  // lebih sedikit dari yang diminta, jadi justru pertahankan semuanya apa
  // adanya. Sama-sama "tidak ada yang dipotong di tengah", tapi satu berarti
  // ringkas total, satu berarti simpan total.
  if (keepTurns <= 0) return messages.length

  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue
    seen += 1
    if (seen === keepTurns) return index
  }
  // Giliran yang ada lebih sedikit dari yang diminta — pertahankan semuanya.
  return 0
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
export function planCompaction(rows: ModelRow[], keepTurns = KEEP_TURNS): CompactionPlan {
  const messages = rows.map((row) => row.message)
  const cut = tailStart(messages, keepTurns)
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

/**
 * Apakah konteks sudah cukup penuh untuk dipadatkan.
 *
 * `lastStepTokens` WAJIB input token satu langkah, bukan `totalUsage` yang
 * menjumlahkan seluruh langkah. Giliran 20 langkah dengan konteks tetap 15k
 * melaporkan totalUsage ~300k; memakainya di sini memicu pemadatan terus-menerus
 * sambil terlihat persis seperti fitur yang sedang bekerja.
 *
 * Batas yang tidak dideklarasikan berarti mati, bukan ditebak — lihat
 * `contextWindowFor`.
 */
export function overBudget(
  lastStepTokens: number | undefined,
  contextWindow: number | undefined,
  reserved: number,
): boolean {
  if (lastStepTokens === undefined || contextWindow === undefined) return false
  return lastStepTokens >= contextWindow - reserved
}
