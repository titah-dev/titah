/**
 * Kapan Titah melanjutkan sendiri, dengan kalimat apa, dan kapan ia mengerem.
 *
 * Dipisah dari `agent.ts` supaya keputusannya bisa diuji tanpa menjalankan
 * giliran: `prompt()` hanya mengumpulkan fakta akhir giliran, keputusannya
 * diambil di sini dari fakta itu saja.
 *
 * # Kenapa bukan hanya "mentok batas"
 *
 * Diukur dari sesi nyata: kebanyakan berhenti-sebelum-selesai bukan giliran
 * yang mentok, melainkan model yang mengakhiri gilirannya sendiri — teks yang
 * berakhir titik dua mengumumkan aksi yang tidak pernah diambil, atau tool
 * call yang ditulis sebagai teks dan karena itu tidak pernah dijalankan.
 */
import { hasOpenWork } from "./plan-progress.ts"

export type ContinueReason = "limit" | "open-plan" | "announced" | "text-tool-call"

export interface TurnEnding {
  stoppedAtLimit: boolean
  /** Teks part terakhir giliran, apa adanya. */
  lastText: string
  /** Langkah terakhir memanggil tool `question`. */
  calledQuestion: boolean
  plan: { text: string; updated: number } | undefined
  /** Waktu (ms) pesan user ASLI dimulai — bukan lanjutan yang sedang berjalan. */
  chainStarted: number
}

/**
 * Jaring lanjutan bawaan di client interaktif.
 *
 * Bukan target, melainkan ujung: rem yang sesungguhnya adalah `IDLE_LIMIT`.
 * Angka ini hanya ada supaya rencana yang tidak pernah dicentang tetap tidak
 * berputar sampai kuota provider habis.
 */
export const UNTIL_DONE_CEILING = 50

/** Lanjutan menganggur berturut-turut sebelum rangkaian dihentikan. */
export const IDLE_LIMIT = 2

/*
 * Urutannya bagian dari aturan: pengecualian selalu menang. Model yang
 * bertanya sedang menunggu user — melanjutkannya berarti menjawab atas nama
 * user, sekalipun gilirannya mentok dengan rencana terbuka.
 */
export function continueReason(ending: TurnEnding): ContinueReason | undefined {
  const text = ending.lastText.trimEnd()
  if (ending.calledQuestion || text.endsWith("?")) return undefined
  /*
   * Rencana yang tidak disentuh rangkaian ini bisa saja usang dari pekerjaan
   * kemarin. Berlaku juga untuk giliran yang mentok: pertanyaan sampingan yang
   * kebetulan mentok batas di sesi dengan rencana setengah jadi tidak boleh
   * membangunkan rencana itu — melanjutkannya berarti mengerjakan sesuatu yang
   * tidak diminta hari ini.
   */
  const freshPlan =
    ending.plan !== undefined &&
    hasOpenWork(ending.plan.text) &&
    ending.plan.updated >= ending.chainStarted
  if (ending.stoppedAtLimit && freshPlan) return "limit"
  if (/<tool_call>|<function=/.test(ending.lastText)) return "text-tool-call"
  if (text.endsWith(":")) return "announced"
  if (freshPlan) return "open-plan"
  return undefined
}

/**
 * Teks yang menutup giliran: teks langkah TERAKHIR saja, dan kosong kalau
 * langkah itu memanggil tool.
 *
 * Teks dari langkah sebelumnya sudah dijawab oleh tool call sesudahnya —
 * "Let me read the file:" yang diikuti `read` bukan pengumuman tanpa aksi.
 * Giliran yang mentok batas berakhir pada tool call, jadi membaca teks
 * terakhir seluruh giliran membuat setiap giliran mentok terlihat "announced".
 */
export function closingText(
  steps: readonly { text: string; toolCalls: readonly unknown[] }[],
): string {
  const last = steps.at(-1)
  if (!last || last.toolCalls.length > 0) return ""
  return last.text
}

/**
 * Tool call yang dihitung kemajuan oleh rem menganggur: yang mengubah sesuatu,
 * atau yang mendelegasikan. `task` sendiri tidak `mutates` — yang menulis
 * adalah sub-agentnya, di sesi lain — jadi lanjutan yang hanya mendelegasikan
 * akan terlihat diam padahal pekerjaannya sedang dikerjakan.
 */
export function isProgressCall(toolName: string, mutating: ReadonlySet<string>): boolean {
  return toolName === "task" || mutating.has(toolName)
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

export function continuationText(reason: ContinueReason): string {
  switch (reason) {
    case "limit":
    case "open-plan":
      return CONTINUE_TEXT
    case "announced":
      return (
        "[titah] Your previous message announced a next step but ended without doing it. " +
        "Do it now, then continue with the plan."
      )
    case "text-tool-call":
      return (
        "[titah] Your previous message contained a tool call written as text, which was " +
        "not executed. Call the tool properly and continue."
      )
  }
}

/**
 * Apakah satu giliran lanjutan tidak menghasilkan kemajuan.
 *
 * "Tanpa tool" saja tidak cukup: model yang terus membaca berkas tanpa menulis
 * apa pun dan tanpa mencentang rencana juga berputar di tempat. Sebaliknya,
 * giliran yang terus menulis berkas tanpa memperbarui rencana tetap dihitung
 * kemajuan — banyak model jarang menyentuh rencananya sendiri.
 */
export function isIdleContinuation(
  toolCalls: number,
  mutatingCalls: number,
  planBefore: string | undefined,
  planAfter: string | undefined,
): boolean {
  return toolCalls === 0 || (mutatingCalls === 0 && planBefore === planAfter)
}
