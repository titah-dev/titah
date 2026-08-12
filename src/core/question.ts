import crypto from "node:crypto"
import { bus } from "./event.ts"

/**
 * Model bertanya balik kepada user, di tengah giliran.
 *
 * Sebelum ini, model yang menemui ambiguitas hanya punya dua pilihan: menebak,
 * atau berhenti dan mengarang jawaban tekstual yang berpura-pura sudah selesai.
 * Keduanya buruk, dan yang pertama lebih buruk karena tidak terlihat.
 *
 * # Kenapa ini bukan sekadar tool
 *
 * Sembilan belas tool lain selesai di dalam `execute`-nya. Yang ini harus
 * BERHENTI dan menunggu manusia mengetik — dan itu bentuk yang sudah ada di
 * Titah, di mesin izin: terbitkan event, simpan promise, tunggu jawaban.
 *
 * Yang TIDAK bisa dipinjam dari sana adalah bentuk jawabannya. `respond()`
 * menerima tiga pilihan tetap (`once`, `always`, `reject`), sementara pertanyaan
 * yang berguna justru yang jawabannya bebas: *"dua berkas cocok, yang mana?"*
 * Memaksakannya lewat dialog izin menghasilkan tool yang cuma bisa ya/tidak —
 * menutup butirnya di atas kertas dan membiarkan masalahnya hidup.
 *
 * Jadi kanalnya kedua, sejajar, dan sengaja mirip supaya klien yang sudah
 * memahami satu tidak perlu mempelajari yang lain dari nol.
 */

export interface QuestionRequest {
  id: string
  sessionID: string
  question: string
  /**
   * Pilihan yang ditawarkan model, kalau ada. Klien boleh merendernya bernomor
   * supaya user cukup menekan satu tombol; jawaban bebas TETAP diterima, karena
   * daftar pilihan model tidak selalu memuat jawaban yang benar.
   */
  options: string[]
  created: number
  /** Agent yang bertanya, supaya dialog bisa membedakan sub-agent mana. */
  agent?: string
}

interface Pending {
  request: QuestionRequest
  resolve: (answer: string | undefined) => void
}

const pending = new Map<string, Pending>()

export function listPendingQuestions(sessionID?: string): QuestionRequest[] {
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => sessionID === undefined || request.sessionID === sessionID)
}

export interface AskUserOptions {
  sessionID: string
  question: string
  options: string[]
  /** Jumlah klien yang mendengarkan. Nol berarti tidak ada yang bisa menjawab. */
  listeners: number
  signal?: AbortSignal
  agent?: string
  /** Sesi yang stream-nya benar-benar didengarkan klien — lihat permission.ts. */
  streamSessionID?: string
}

export class NoOneToAsk extends Error {}

/**
 * Bertanya, lalu menunggu.
 *
 * Mengembalikan `undefined` kalau dibatalkan. Melempar `NoOneToAsk` kalau tidak
 * ada klien yang mendengarkan — aturan yang sama dengan izin, dan alasannya
 * sama: menggantung selamanya di CI lebih buruk daripada gagal cepat. Bedanya,
 * di sini kegagalan itu BUKAN penolakan; pemanggil menerjemahkannya jadi
 * instruksi untuk melanjutkan dengan asumsi terbaik dan menyebutkan asumsinya.
 */
export function askUser(options: AskUserOptions): Promise<string | undefined> {
  if (options.listeners === 0) throw new NoOneToAsk("No client is connected to answer.")

  const streamSessionID = options.streamSessionID ?? options.sessionID
  const request: QuestionRequest = {
    id: `qst_${crypto.randomUUID()}`,
    sessionID: streamSessionID,
    question: options.question,
    options: options.options,
    created: Date.now(),
    ...(options.agent ? { agent: options.agent } : {}),
  }

  return new Promise<string | undefined>((resolve) => {
    const settle = (answer: string | undefined) => {
      pending.delete(request.id)
      bus.publish({ type: "question.resolved", sessionID: request.sessionID, questionID: request.id })
      resolve(answer)
    }

    pending.set(request.id, { request, resolve: settle })
    options.signal?.addEventListener(
      "abort",
      () => {
        if (pending.has(request.id)) settle(undefined)
      },
      { once: true },
    )

    bus.publish({ type: "question.request", sessionID: request.sessionID, request })
  })
}

/** Menjawab. `false` kalau id-nya tidak dikenal atau sudah terjawab. */
export function answerQuestion(questionID: string, answer: string): boolean {
  const entry = pending.get(questionID)
  if (!entry) return false
  entry.resolve(answer)
  return true
}

/** Membatalkan tanpa jawaban — dipakai saat sesi berakhir atau user menekan Esc. */
export function cancelQuestion(questionID: string): boolean {
  const entry = pending.get(questionID)
  if (!entry) return false
  entry.resolve(undefined)
  return true
}

export function clearQuestions(sessionID: string): void {
  for (const [id, entry] of pending) {
    if (entry.request.sessionID !== sessionID) continue
    entry.resolve(undefined)
    pending.delete(id)
  }
}
