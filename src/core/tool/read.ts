import fs from "node:fs"
import { z } from "zod"
import { relative, resolveInside, splitLines, ToolError, type TitahTool } from "./types.ts"

const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

const inputSchema = z.object({
  path: z.string().describe("File path, relative to the working directory"),
  offset: z.number().int().min(0).optional().describe("Start line (0-indexed)"),
  limit: z.number().int().positive().optional().describe(`Number of lines, max ${MAX_LINES}`),
})

/** Deteksi biner sederhana: byte NUL di 8 KB pertama. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

export const readTool: TitahTool<typeof inputSchema> = {
  name: "read",
  description:
    "Read a text file. Output is line-numbered. Large files are truncated — " +
    "use offset/limit to read the next chunk.",
  inputSchema,
  async execute(input, ctx) {
    const file = resolveInside(ctx.cwd, input.path)

    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      throw new ToolError(`File not found: ${input.path}`)
    }
    if (stat.isDirectory()) {
      throw new ToolError(`"${input.path}" is a directory. Use the list tool.`)
    }

    const buffer = fs.readFileSync(file)
    if (isBinary(buffer)) {
      throw new ToolError(`"${input.path}" appears to be binary (${stat.size} bytes), not read.`)
    }

    const lines = splitLines(buffer.toString("utf8"))
    const offset = input.offset ?? 0
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES)
    const slice = lines.slice(offset, offset + limit)

    const numbered = slice
      .map((line, index) => {
        const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
        return `${String(offset + index + 1).padStart(5)}\t${text}`
      })
      .join("\n")

    const shown = offset + slice.length
    const more =
      shown < lines.length
        ? `\n\n[${lines.length - shown} more lines. Continue with offset=${shown}.]`
        : ""

    return {
      title: `read ${relative(ctx.cwd, file)} (${slice.length} lines)`,
      output: numbered + more,
      metadata: { totalLines: lines.length, offset, shown: slice.length },
    }
  },
}
