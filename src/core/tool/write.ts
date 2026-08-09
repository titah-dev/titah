import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { countLines, relative, resolveInside, splitLines, ToolError, type TitahTool } from "./types.ts"

const inputSchema = z.object({
  path: z.string().describe("Path of the file to write, relative to the working directory"),
  content: z.string().describe("Full file contents"),
})

const PREVIEW_LINES = 30

export const writeTool: TitahTool<typeof inputSchema> = {
  name: "write",
  description:
    "Write full contents to a file, creating parent directories as needed. " +
    "Overwrites an existing file. For small changes to large files, use edit.",
  inputSchema,
  mutates: true,
  permission(input, ctx) {
    const file = path.resolve(ctx.cwd, input.path)
    const exists = fs.existsSync(file)
    const lines = splitLines(input.content)
    const preview = lines.slice(0, PREVIEW_LINES).join("\n")
    return {
      kind: "write",
      title: `${exists ? "overwrite" : "create"} ${input.path} (${lines.length} lines)`,
      detail:
        preview + (lines.length > PREVIEW_LINES ? `\n… ${lines.length - PREVIEW_LINES} more lines` : ""),
      pattern: "write",
    }
  },
  async execute(input, ctx) {
    const file = resolveInside(ctx.cwd, input.path)

    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      throw new ToolError(`"${input.path}" is a directory.`)
    }

    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existed = fs.existsSync(file)
    fs.writeFileSync(file, input.content)

    const lines = countLines(input.content)
    return {
      title: `write ${relative(ctx.cwd, file)} (${lines} lines)`,
      output: `${existed ? "Overwrote" : "Created"} ${relative(ctx.cwd, file)} — ${lines} lines, ${Buffer.byteLength(input.content)} bytes.`,
      metadata: { lines, existed },
    }
  },
}
