import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { finalize, parserFor, type Format } from "./parse.ts"
import { DelegationError, type DelegateAdapter, type DelegationRequest, type DelegationResult } from "./types.ts"
import { which } from "../which.ts"
import type { ExternalAgent } from "../schema.ts"

/**
 * Adapter subprocess: satu implementasi untuk semua agent CLI, dibentuk oleh
 * konfigurasi (Q7). Menambah agent ketiga = menyunting `externalAgent` di
 * titah.json, bukan menyentuh core.
 */

const MAX_TRANSCRIPT = 4 * 1024 * 1024

function substitute(args: string[], values: { prompt: string; session: string }): string[] {
  return args.map((arg) =>
    arg.replaceAll("{prompt}", values.prompt).replaceAll("{session}", values.session),
  )
}

export function createSubprocessAdapter(id: string, config: ExternalAgent): DelegateAdapter {
  const executable = which(config.command)

  return {
    id,
    ...(executable ? { executable } : {}),
    available: executable !== undefined && config.enabled,
    timeoutMs: config.timeout,

    async prompt(request: DelegationRequest): Promise<DelegationResult> {
      if (!executable) {
        throw new DelegationError(
          `Agent "${id}" is unavailable: "${config.command}" was not found in PATH.`,
        )
      }

      const resuming = request.resumeSessionID !== undefined
      // Dua mode sesi. "generate": kita yang membuat id lalu memberikannya ke
      // CLI (cara Claude Code). "discover": id baru diketahui dari outputnya
      // (cara opencode), jadi panggilan pertama tidak membawa id sama sekali.
      const sessionValue =
        request.resumeSessionID ??
        (config.sessionMode === "generate" ? crypto.randomUUID() : "")

      const template = resuming && config.resumeArgs.length > 0 ? config.resumeArgs : config.args
      const args = substitute(template, { prompt: request.prompt, session: sessionValue })

      const parser = parserFor(config.format as Format, id)
      const started = Date.now()

      return new Promise<DelegationResult>((resolve, reject) => {
        const child = spawn(executable, args, {
          cwd: request.cwd,
          // Environment diwariskan UTUH, dan itu disengaja: agent eksternal
          // memakai kredensialnya sendiri, yang pada banyak mesin memang hidup
          // di env (`ANTHROPIC_API_KEY` dan sejenisnya). Menyaringnya justru
          // merusak CLI yang mengandalkan itu.
          //
          // Konsekuensinya jujur disebut di sini: kunci provider Titah yang
          // kebetulan ada di env ikut terwariskan. Itu sama seperti menjalankan
          // CLI-nya sendiri dari shell yang sama — bukan pelonggaran batas.
          //
          // `TITAH_DELEGATED` supaya agent yang peduli bisa tahu ia dipanggil
          // Titah, bukan manusia.
          env: { ...process.env, TITAH_DELEGATED: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        })

        let transcript = ""
        let stderr = ""
        let pending = ""
        let timedOut = false

        const consume = (chunk: string) => {
          if (transcript.length < MAX_TRANSCRIPT) transcript += chunk
          pending += chunk
          let index = pending.indexOf("\n")
          while (index !== -1) {
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            index = pending.indexOf("\n")
            for (const update of parser.line(line)) request.onUpdate?.(update)
          }
        }

        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => consume(chunk))
        child.stderr.setEncoding("utf8")
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk
          if (transcript.length < MAX_TRANSCRIPT) transcript += chunk
        })

        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, config.timeout)

        const onAbort = () => child.kill("SIGKILL")
        request.signal.addEventListener("abort", onAbort, { once: true })

        const cleanup = () => {
          clearTimeout(timer)
          request.signal.removeEventListener("abort", onAbort)
        }

        child.on("error", (error) => {
          cleanup()
          reject(new DelegationError(`Failed to run "${config.command}": ${error.message}`))
        })

        child.on("close", (code) => {
          cleanup()
          if (pending !== "") for (const update of parser.line(pending)) request.onUpdate?.(update)

          if (timedOut) {
            return reject(
              new DelegationError(
                `Agent "${id}" exceeded its ${Math.round(config.timeout / 1000)}s timeout and was killed.`,
              ),
            )
          }
          if (request.signal.aborted) return reject(new DelegationError("Cancelled."))

          const result = finalize(parser, transcript, Date.now() - started)

          // Parse toleran berarti kegagalan bisa lolos tanpa terdeteksi. Kalau
          // tidak ada jawaban sama sekali, exit code dan stderr yang bicara.
          if (result.answer === "" && !result.isError) {
            result.isError = true
            result.errorMessage =
              code === 0
                ? `Agent "${id}" finished without a readable answer. Check the raw transcript.`
                : `Agent "${id}" exited with code ${code}. ${stderr.trim().slice(0, 300)}`
          }

          resolve(result)
        })
      })
    },
  }
}
