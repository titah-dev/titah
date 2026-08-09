import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { DEFAULT_IGNORE, relative, resolveInside, type TitahTool } from "./types.ts"

const MAX_RESULTS = 200

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe("Starting directory. Defaults to the working directory."),
})

export function isIgnored(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => DEFAULT_IGNORE.has(segment))
}

export const globTool: TitahTool<typeof inputSchema> = {
  name: "glob",
  description:
    "Find files by glob pattern. Results are sorted by most recently modified. " +
    "Use this when you know the file name shape; use grep to search contents.",
  inputSchema,
  async execute(input, ctx) {
    const root = resolveInside(ctx.cwd, input.path ?? ".")

    const matches = fs
      .globSync(input.pattern, { cwd: root })
      .filter((match) => !isIgnored(match))
      .map((match) => path.join(root, match))
      .filter((full) => {
        try {
          return fs.statSync(full).isFile()
        } catch {
          return false
        }
      })

    const sorted = matches
      .map((full) => ({ full, mtime: fs.statSync(full).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_RESULTS)
      .map((entry) => relative(ctx.cwd, entry.full))

    const capped =
      matches.length > MAX_RESULTS
        ? `\n\n[${matches.length} matches, showing the ${MAX_RESULTS} most recent]`
        : ""

    return {
      title: `glob ${input.pattern} (${matches.length} matches)`,
      output: sorted.length === 0 ? "No matching files." : sorted.join("\n") + capped,
      metadata: { count: matches.length },
    }
  },
}
