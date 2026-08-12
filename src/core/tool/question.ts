import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Model bertanya balik (gap 16 di docs/gap-analysis.md).
 *
 * Tanpa ini, model yang menemui ambiguitas punya dua pilihan dan keduanya
 * buruk: menebak, atau berhenti lalu mengarang jawaban tekstual yang
 * berpura-pura sudah selesai. Menebak lebih buruk karena tidak terlihat — user
 * baru tahu tebakannya salah setelah pekerjaannya dipakai.
 *
 * Eksekusinya dipasang dari `agent.ts` lewat `setQuestionAsker`, bukan
 * mengimpor `question.ts` langsung. Alasannya sama dengan `task`: tool ini
 * butuh hal-hal yang hanya diketahui pemanggil — berapa klien yang benar-benar
 * mendengarkan sesi ini, sesi mana yang stream-nya dilanggan, agent mana yang
 * bertanya — dan semuanya milik giliran, bukan milik tool.
 */

const inputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe("One clear question. State what you will do with each possible answer."),
  options: z
    .array(z.string())
    .max(9)
    .default([])
    .describe(
      "Optional shortlist the user can pick from by number. Offer these when you know the " +
        "plausible answers; the user can always type something else instead.",
    ),
})

export interface QuestionAsker {
  (input: { question: string; options: string[] }, sessionID: string): Promise<string | undefined>
}

let asker: QuestionAsker | undefined

/** Dipasang sekali oleh `agent.ts`. */
export function setQuestionAsker(next: QuestionAsker): void {
  asker = next
}

export const questionTool: TitahTool<typeof inputSchema> = {
  name: "question",
  description:
    "Ask the user a question and wait for their answer. Use it when the work forks on " +
    "something only they can decide — which of two files they meant, which of two designs " +
    "they want. Do NOT use it to ask permission to continue, or to ask something the " +
    "repository can answer: read the code instead. Every question costs the user their " +
    "attention, so ask one that changes what you do next.",
  inputSchema,
  // Tidak ada sumbu izin: bertanya tidak menyentuh berkas, shell, maupun
  // jaringan. Ongkosnya adalah perhatian user, dan itu dijaga oleh deskripsi
  // di atas plus fakta bahwa jawabannya harus ditunggu.
  async execute(input, ctx) {
    if (!asker) throw new ToolError("Questions are not available in this context.")

    const answer = await asker(
      { question: input.question, options: input.options },
      ctx.sessionID,
    )

    if (answer === undefined || answer.trim() === "") {
      // BUKAN error, dan bukan penolakan. User yang melewati pertanyaan sedang
      // mengatakan "putuskan sendiri" — dan model yang memperlakukannya sebagai
      // penolakan akan berhenti bekerja padahal ia justru diberi kebebasan.
      return {
        title: "question: skipped",
        output:
          "The user did not answer. Continue with your best assumption, and say plainly " +
          "which assumption you made so they can correct it.",
        metadata: { answered: false },
      }
    }

    return {
      title: `question: answered`,
      output: `The user answered:\n\n${answer}`,
      metadata: { answered: true },
    }
  },
}
