import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Model meminta user keluar dari mode Plan.
 *
 * # Masalah yang diselesaikannya
 *
 * Mode Plan menolak setiap perubahan, dan itu benar. Tapi user yang mengetik
 * "perbaiki bug ini" sambil berada di mode Plan tanpa sadar akan mendapat salah
 * satu dari dua hal, dan keduanya buruk:
 *
 *   - Model mencoba menyunting, ditolak, lalu melaporkan penolakannya. User
 *     membaca kegagalan untuk sesuatu yang tidak pernah ia salah lakukan.
 *   - Model diam-diam menulis rencana alih-alih mengerjakan permintaannya.
 *     Lebih buruk, karena terlihat seperti jawaban.
 *
 * Yang benar adalah **mengatakan keadaannya dan menawarkan jalan keluar** —
 * dan itu harus datang dari model, karena hanya model yang tahu permintaan ini
 * membutuhkan perubahan.
 *
 * # Kenapa ia menumpang kanal `question`
 *
 * Bentuknya persis sama: berhenti, tampilkan pilihan, tunggu manusia. Membangun
 * kanal ketiga berarti tiga tempat yang harus diajari cara menangani dialog
 * yang menunggu, dan yang ketiga akan tertinggal saat dua lainnya diperbaiki.
 *
 * Yang membedakannya cuma satu field: `intent`. TUI membacanya untuk tahu bahwa
 * jawabannya bukan teks untuk model, melainkan perintah untuk dirinya sendiri —
 * pindah mode.
 */

const inputSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      "What you would do if you could. State it before asking — the user is choosing " +
        "whether to let this happen, and they cannot choose well without seeing it.",
    ),
})

export interface PlanExiter {
  (plan: string, sessionID: string): Promise<string | undefined>
}

let exiter: PlanExiter | undefined

/** Dipasang sekali oleh `agent.ts`, sama seperti `question`. */
export function setPlanExiter(next: PlanExiter): void {
  exiter = next
}

/** Mode yang benar-benar bisa mengubah sesuatu, sesuai urutan penawaran. */
export const BUILD_MODES = ["build", "build-auto"] as const

export const exitPlanTool: TitahTool<typeof inputSchema> = {
  name: "exit_plan",
  description:
    "Use this when the user asked for a change but you are in Plan mode, which refuses " +
    "them. It tells the user they are in Plan mode and offers to switch. Say what you " +
    "would do in `plan` first. Do NOT use it to ask permission for one edit — that is " +
    "what the permission dialog is for — and do NOT use it outside Plan mode.",
  inputSchema,
  // Tanpa sumbu izin: ia tidak mengubah apa pun sendiri. Yang mengubah adalah
  // keputusan user sesudahnya, dan keputusan itu diambil di TUI.
  async execute(input, ctx) {
    if (!exiter) throw new ToolError("Mode switching is not available in this context.")

    const answer = await exiter(input.plan, ctx.sessionID)

    if (answer === undefined || answer.trim() === "" || !BUILD_MODES.includes(answer as never)) {
      // User memilih tetap di Plan, atau tidak menjawab. BUKAN kegagalan:
      // menolak berpindah adalah jawaban yang sah, dan model harus
      // melanjutkan sebagai perencana alih-alih mencoba lagi.
      return {
        title: "exit_plan: staying in Plan",
        output:
          "The user chose to stay in Plan mode. Do not attempt the change. " +
          "Finish the plan instead, and end with numbered steps they could run themselves.",
        metadata: { switched: false },
      }
    }

    return {
      title: `exit_plan: switched to ${answer}`,
      output:
        `The user switched to ${answer}. It takes effect on their NEXT message, not this turn — ` +
        "so finish this turn by stating the first step, and carry it out when they reply.",
      metadata: { switched: true, mode: answer },
    }
  },
}
