import { spawn } from "node:child_process"
import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 256 * 1024

const inputSchema = z.object({
  command: z.string().describe("Shell command to run"),
  description: z
    .string()
    .optional()
    .describe("Short 5-10 word explanation of what this command does"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Timeout in milliseconds, default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}`),
})

/**
 * Kata pertama perintah dipakai sebagai pola allowlist, sehingga jawaban
 * "selalu izinkan" untuk `git status` menjadi `git *` — bukan izin buta untuk
 * seluruh shell.
 */
export function allowlistPattern(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command
  return `${first} *`
}

export const bashTool: TitahTool<typeof inputSchema> = {
  name: "bash",
  description:
    "Run a shell command in the session working directory. Returns stdout, stderr, " +
    "and exit code. To find files use glob/grep, not find/rg through this tool.",
  inputSchema,
  mutates: true,
  permission(input) {
    return {
      kind: "bash",
      title: `bash: ${input.command.split("\n")[0]?.slice(0, 80)}`,
      detail: input.description ? `${input.description}\n\n${input.command}` : input.command,
      pattern: allowlistPattern(input.command),
    }
  },
  async execute(input, ctx) {
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    return new Promise((resolve, reject) => {
      const child = spawn(input.command, {
        cwd: ctx.cwd,
        shell: true,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
      })

      let stdout = ""
      let stderr = ""
      let truncated = false
      let timedOut = false

      const append = (target: "out" | "err", chunk: Buffer) => {
        const text = chunk.toString("utf8")
        if (stdout.length + stderr.length > MAX_OUTPUT) {
          truncated = true
          return
        }
        if (target === "out") stdout += text
        else stderr += text
      }

      child.stdout.on("data", (chunk: Buffer) => append("out", chunk))
      child.stderr.on("data", (chunk: Buffer) => append("err", chunk))

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeout)

      const onAbort = () => child.kill("SIGKILL")
      ctx.signal.addEventListener("abort", onAbort, { once: true })

      const finish = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onAbort)
      }

      child.on("error", (error) => {
        finish()
        reject(new ToolError(`Failed to run command: ${error.message}`))
      })

      child.on("close", (code) => {
        finish()

        if (timedOut) {
          return reject(
            new ToolError(`Command exceeded the ${timeout} ms timeout and was killed: ${input.command}`),
          )
        }
        if (ctx.signal.aborted) return reject(new ToolError("Cancelled."))

        const sections: string[] = []
        if (stdout.trim() !== "") sections.push(stdout.trimEnd())
        if (stderr.trim() !== "") sections.push(`--- stderr ---\n${stderr.trimEnd()}`)
        if (truncated) sections.push(`[output truncated at ${MAX_OUTPUT} bytes]`)
        if (code !== 0) sections.push(`[exit code ${code}]`)

        resolve({
          title: `bash: ${input.command.split("\n")[0]?.slice(0, 60)}${code === 0 ? "" : ` (exit ${code})`}`,
          output: sections.length === 0 ? "(no output, exit 0)" : sections.join("\n"),
          metadata: { exitCode: code, truncated },
        })
      })
    })
  },
}
