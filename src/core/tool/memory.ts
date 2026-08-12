import { z } from "zod"
import { forgetFact, listMemories, MAX_MEMORIES, rememberFact } from "../storage/session.ts"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Memory-Augmented Generation: sisi TULIS-nya.
 *
 * Sisi bacanya tidak ada di sini, dan itu disengaja. Memori dibacakan OTOMATIS
 * ke setiap permintaan lewat `memoryPair` — tidak ada tool untuk mengingat
 * kembali, karena store yang harus diingat untuk dibaca adalah store yang
 * menjawab pertanyaan yang salah. Lupa membacanya persis kegagalan yang mau
 * dihindari.
 *
 * # Bedanya dari `plan`
 *
 * Satu sumbu, dan ia menentukan segalanya: **berapa lama faktanya benar.**
 *
 *   `plan`   — niat untuk pekerjaan yang sedang berjalan. Mati bersama sesinya.
 *   `memory` — fakta tentang proyeknya. Masih benar besok pagi, di sesi lain.
 *
 * "Selanjutnya perbaiki test yang gagal" adalah rencana. "Suite ini butuh
 * Node 22 karena memakai node:sqlite" adalah memori.
 *
 * # Bedanya dari membaca repo
 *
 * Kalau jawabannya ada di dalam repo, `read` dan `grep` yang menjawabnya, dan
 * mereka selalu benar karena mereka membaca keadaan SEKARANG. Memori adalah
 * untuk yang TIDAK ada di repo: keputusan yang alasannya tidak pernah ditulis,
 * kendala yang datang dari luar, jalan buntu yang sudah pernah dicoba.
 *
 * Menyimpan isi repo ke memori adalah cara membuat dua sumber kebenaran, dan
 * yang di memori akan basi lebih dulu.
 */

const inputSchema = z.object({
  action: z
    .enum(["remember", "forget", "list"])
    .describe("remember stores a durable fact, forget removes one by id, list shows them"),
  text: z
    .string()
    .optional()
    .describe("For remember: one fact, one sentence. Required for remember."),
  id: z.string().optional().describe("For forget: the memory id shown in <project-memory>"),
})

export const memoryTool: TitahTool<typeof inputSchema> = {
  name: "memory",
  description:
    "Record a durable fact about this project that you would want to know at the start of " +
    "a future session. It is recalled into every request automatically — you never need " +
    "to read it back. Use it ONLY for things that stay true and are NOT in the repository: " +
    "constraints, decisions and their reasons, dead ends already tried. Anything the code " +
    "records belongs to read/grep, and anything about the task in front of you belongs to plan.",
  inputSchema,
  // Tidak ada `permission`: menulis fakta ke database Titah sendiri tidak
  // menyentuh berkas, shell, maupun jaringan — dan store-nya dibatasi. Sumbu
  // izin yang ada semuanya tentang membelanjakan sesuatu milik user.
  async execute(input, ctx) {
    if (input.action === "list") {
      const facts = listMemories(ctx.cwd)
      return {
        title: `memory: ${facts.length}/${MAX_MEMORIES}`,
        output:
          facts.length === 0
            ? "No memories for this project yet."
            : facts.map((fact) => `[${fact.id}] ${fact.text}`).join("\n"),
      }
    }

    if (input.action === "forget") {
      if (!input.id) throw new ToolError("forget needs the id of the memory to remove.")
      if (!forgetFact(ctx.cwd, input.id)) {
        throw new ToolError(`No memory ${input.id} in this project.`)
      }
      return { title: `memory: forgot ${input.id}`, output: `Forgot ${input.id}.` }
    }

    if (!input.text || input.text.trim() === "") {
      throw new ToolError("remember needs `text` — the fact to store.")
    }

    try {
      const fact = rememberFact(ctx.cwd, input.text)
      const total = listMemories(ctx.cwd).length
      return {
        title: `memory: remembered (${total}/${MAX_MEMORIES})`,
        output:
          `Remembered as ${fact.id}. It will be in every request for this project from now on, ` +
          `including in future sessions. Forget it when it stops being true.`,
        metadata: { id: fact.id, total },
      }
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
  },
}
