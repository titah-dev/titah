import { spawn } from "node:child_process"
import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Menjalankan pemeriksa proyek dan mengembalikan keluarannya (gap 8).
 *
 * Setelah `edit`, tidak ada apa pun yang memberi tahu model bahwa ia baru saja
 * membuat type error. Ia harus kebetulan ingat menjalankan typecheck, dan sering
 * tidak — itu penyebab pola yang sudah terlihat berkali-kali: perubahan tampak
 * benar, suite hijau, rusaknya baru ketahuan belakangan.
 *
 * Ini BUKAN LSP. Ia tidak tahu simbol, tidak melacak berkas, dan tidak
 * memberikan diagnosis per baris tanpa menjalankan apa pun. Yang ia lakukan
 * adalah membuat pemeriksaan itu semurah satu tool call, sehingga tidak ada lagi
 * alasan untuk melewatkannya. LSP sungguhan tetap butir yang terbuka.
 */

const DEFAULT_TIMEOUT = 180_000

const inputSchema = z.object({})

export const diagnosticsTool: TitahTool<typeof inputSchema> = {
  name: "diagnostics",
  description:
    "Run the project's checker (typecheck, lint, or whatever the user configured) and " +
    "return its output. Run this after a batch of edits, before saying the work is done.",
  inputSchema,
  permission(_input, ctx) {
    const command = ctx.config.diagnostics?.command ?? "(not configured)"
    return {
      // Sumbu `bash`: ia menjalankan perintah shell. Bahwa perintahnya datang
      // dari config user, bukan dari model, membuatnya lebih AMAN — tapi tidak
      // membuatnya bukan perintah shell.
      kind: "bash",
      title: `diagnostics: ${command.slice(0, 60)}`,
      detail: `Run the configured project checker:\n\n${command}`,
      pattern: "diagnostics",
    }
  },
  async execute(_input, ctx) {
    const command = ctx.config.diagnostics?.command
    if (command === undefined || command.trim() === "") {
      // Tidak menebak `tsc`, `eslint`, atau apa pun dari isi package.json.
      // Aturan yang sama dengan `contextWindow`: yang tidak dinyatakan tidak
      // ditebak — perintah yang salah tebak gagal dengan cara yang jauh lebih
      // membingungkan daripada tidak ada perintah sama sekali.
      throw new ToolError(
        "No checker is configured. Add diagnostics.command to titah.json, " +
          'for example {"diagnostics": {"command": "npm run typecheck"}}. ' +
          "Titah does not guess this — a wrongly guessed command fails in ways that are " +
          "harder to read than no command at all.",
      )
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", FORCE_COLOR: "0" },
      })

      let output = ""
      const append = (chunk: Buffer) => {
        if (output.length < 128 * 1024) output += chunk.toString("utf8")
      }
      child.stdout?.on("data", append)
      child.stderr?.on("data", append)

      const timer = setTimeout(() => child.kill("SIGKILL"), DEFAULT_TIMEOUT)
      const onAbort = () => child.kill("SIGKILL")
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      child.on("error", (error) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onAbort)
        reject(new ToolError(`Could not run "${command}": ${error.message}`))
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onAbort)
        if (ctx.signal.aborted) return reject(new ToolError("Cancelled."))

        const clean = output.trim()
        // Exit non-nol BUKAN error tool: temuan adalah hasil yang benar, dan
        // melemparnya akan membuat "ada tiga type error" terlihat sama dengan
        // "checker-nya sendiri rusak".
        resolve({
          title: code === 0 ? "diagnostics: clean" : `diagnostics: ${code === null ? "killed" : "findings"}`,
          output:
            code === 0
              ? clean === ""
                ? "Clean — the checker reported nothing."
                : `Clean.\n${clean}`
              : `The checker exited ${code}. Its output:\n${"-".repeat(40)}\n${clean || "(no output)"}`,
          metadata: { exitCode: code, clean: code === 0 },
        })
      })
    })
  },
}
