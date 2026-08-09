import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { relative, resolveInside, ToolError, type TitahTool } from "./types.ts"
import { isIgnored } from "./glob.ts"

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINE_LENGTH = 500

const inputSchema = z.object({
  pattern: z.string().describe("Regular expression (JavaScript syntax)"),
  path: z.string().optional().describe("Starting directory. Defaults to the working directory."),
  include: z.string().optional().describe('Restrict to a glob pattern, e.g. "**/*.ts"'),
  ignoreCase: z.boolean().optional(),
})

export const grepTool: TitahTool<typeof inputSchema> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns file, line number, and " +
    "the matching line. Binary files and build directories are skipped.",
  inputSchema,
  async execute(input, ctx) {
    const root = resolveInside(ctx.cwd, input.path ?? ".")

    let regex: RegExp
    try {
      regex = new RegExp(input.pattern, input.ignoreCase === true ? "i" : "")
    } catch (error) {
      throw new ToolError(
        `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const candidates = fs
      .globSync(input.include ?? "**/*", { cwd: root })
      .filter((match) => !isIgnored(match))
      .map((match) => path.join(root, match))

    const lines: string[] = []
    let matchCount = 0
    let fileCount = 0

    for (const file of candidates) {
      if (matchCount >= MAX_MATCHES) break
      if (ctx.signal.aborted) throw new ToolError("Cancelled.")

      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue

      const buffer = fs.readFileSync(file)
      if (buffer.subarray(0, 8192).includes(0)) continue

      const content = buffer.toString("utf8")
      // Cek murah dulu: kalau regex tidak kena di seluruh isi, lewati split per baris.
      regex.lastIndex = 0
      if (!regex.test(content)) continue

      let hitInFile = false
      const fileLines = content.split("\n")
      for (const [index, line] of fileLines.entries()) {
        if (matchCount >= MAX_MATCHES) break
        regex.lastIndex = 0
        if (!regex.test(line)) continue
        const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
        lines.push(`${relative(ctx.cwd, file)}:${index + 1}: ${text.trimEnd()}`)
        matchCount += 1
        hitInFile = true
      }
      if (hitInFile) fileCount += 1
    }

    const capped =
      matchCount >= MAX_MATCHES ? `\n\n[truncated at ${MAX_MATCHES} matches]` : ""

    return {
      title: `grep "${input.pattern}" (${matchCount} matches in ${fileCount} files)`,
      output: matchCount === 0 ? "No matches." : lines.join("\n") + capped,
      metadata: { matches: matchCount, files: fileCount },
    }
  },
}
