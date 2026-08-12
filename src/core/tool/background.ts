import { z } from "zod"
import { listProcesses, readProcess, startProcess, stopProcess } from "../process.ts"
import { allowlistPattern, commandSegments } from "./bash.ts"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Tiga tool, bukan satu dengan mode — dan alasannya izin.
 *
 * Menyalakan proses adalah `bash`: ia menjalankan perintah sembarang. Membaca
 * keluarannya dan menghentikannya tidak menjalankan apa pun, jadi keduanya tidak
 * meminta izin sama sekali. Satu tool bermode akan memaksa ketiganya memakai
 * sumbu yang paling ketat, dan user akan ditanya tiap kali model mengintip log.
 */

const startInput = z.object({
  command: z.string().describe("Shell command to start in the background"),
  description: z.string().optional().describe("Short 5-10 word explanation"),
})

export const bashStartTool: TitahTool<typeof startInput> = {
  name: "bash_start",
  description:
    "Start a long-running command in the background and return immediately with an id. " +
    "Use this for dev servers, watchers, and builds you want to keep working alongside. " +
    "Read its output with bash_output, stop it with bash_stop. For anything that finishes " +
    "on its own in under a couple of minutes, use bash instead.",
  inputSchema: startInput,
  mutates: true,
  permission(input) {
    // Sumbu, pola, dan segmentasi PERSIS sama dengan `bash`. Kalau berbeda,
    // `bash_start` jadi pintu belakang yang melewati aturan allowlist yang
    // baru saja diperbaiki di issue #12.
    return {
      kind: "bash",
      title: `bash_start: ${input.command.split("\n")[0]?.slice(0, 70)}`,
      detail:
        (input.description ? `${input.description}\n\n` : "") +
        `${input.command}\n\nThis keeps running after the tool call returns.`,
      pattern: allowlistPattern(input.command),
      segments: commandSegments(input.command) ?? [],
    }
  },
  async execute(input, ctx) {
    try {
      const { id, command } = startProcess(ctx.sessionID, input.command, ctx.cwd)
      return {
        title: `bash_start ${id}`,
        output:
          `Started ${id}: ${command}\n\n` +
          "It is running now. Call bash_output with this id to see what it printed — " +
          "give it a moment first, since nothing may have been written yet.",
        metadata: { id },
      }
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
  },
}

const outputInput = z.object({
  id: z.string().optional().describe("Process id from bash_start. Omit to list all of them."),
  all: z
    .boolean()
    .default(false)
    .describe("Return everything buffered instead of only what is new since the last read"),
})

export const bashOutputTool: TitahTool<typeof outputInput> = {
  name: "bash_output",
  description:
    "Read what a background process has printed since you last looked, and whether it is " +
    "still running. Call with no id to list every background process in this session.",
  inputSchema: outputInput,
  async execute(input, ctx) {
    if (input.id === undefined) {
      const all = listProcesses(ctx.sessionID)
      if (all.length === 0) {
        return { title: "bash_output: none", output: "No background processes in this session." }
      }
      return {
        title: `bash_output: ${all.length} processes`,
        output: all
          .map(
            (entry) =>
              `${entry.id}  ${entry.status}${entry.exitCode === null ? "" : ` (exit ${entry.exitCode})`}` +
              `  ${Math.round(entry.runningMs / 1000)}s  ${entry.command}`,
          )
          .join("\n"),
      }
    }

    let result
    try {
      result = readProcess(input.id, input.all)
    } catch (error) {
      throw new ToolError((error as Error).message)
    }

    const header =
      `${result.id} · ${result.status}` +
      (result.exitCode === null ? "" : ` · exit ${result.exitCode}`) +
      ` · ${Math.round(result.runningMs / 1000)}s`
    // Byte yang dibuang cincin DISEBUT. Output yang diam-diam kehilangan
    // awalnya membuat model menyimpulkan dari bukti yang tidak lengkap tanpa
    // pernah tahu bahwa ia tidak lengkap.
    const lost = result.dropped > 0 ? `\n[${result.dropped} earlier bytes dropped from the buffer]` : ""
    const body = result.text === "" ? "(nothing new)" : result.text

    return {
      title: `bash_output ${result.id} (${result.status})`,
      output: `${header}${lost}\n${"-".repeat(40)}\n${body}`,
      metadata: { status: result.status, exitCode: result.exitCode },
    }
  },
}

const stopInput = z.object({
  id: z.string().describe("Process id from bash_start"),
})

export const bashStopTool: TitahTool<typeof stopInput> = {
  name: "bash_stop",
  description:
    "Stop a background process and return whatever it printed last. Stopping something " +
    "already finished is not an error.",
  inputSchema: stopInput,
  async execute(input) {
    let result
    try {
      result = stopProcess(input.id)
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
    return {
      title: `bash_stop ${result.id}`,
      output:
        `${result.id} is now ${result.status}.\n${"-".repeat(40)}\n` +
        (result.text === "" ? "(nothing new before it stopped)" : result.text),
    }
  },
}
