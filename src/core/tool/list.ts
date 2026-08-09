import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { DEFAULT_IGNORE, relative, resolveInside, ToolError, type TitahTool } from "./types.ts"

const MAX_ENTRIES = 500

const inputSchema = z.object({
  path: z.string().optional().describe("Directory to list. Defaults to the working directory."),
  depth: z.number().int().min(1).max(5).optional().describe("Recursion depth, default 2"),
})

interface Entry {
  path: string
  isDir: boolean
  size: number
}

function walk(root: string, dir: string, depth: number, out: Entry[]): void {
  if (out.length >= MAX_ENTRIES || depth < 0) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (entry.name.startsWith(".") && entry.name !== ".github") continue
    if (DEFAULT_IGNORE.has(entry.name)) continue

    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push({ path: relative(root, full), isDir: true, size: 0 })
      walk(root, full, depth - 1, out)
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      out.push({ path: relative(root, full), isDir: false, size })
    }
  }
}

export const listTool: TitahTool<typeof inputSchema> = {
  name: "list",
  description:
    "List directory contents recursively. Hidden files and build directories " +
    "(node_modules, dist, .git, ...) are skipped.",
  inputSchema,
  async execute(input, ctx) {
    const dir = resolveInside(ctx.cwd, input.path ?? ".")
    if (!fs.existsSync(dir)) throw new ToolError(`Directory not found: ${input.path ?? "."}`)
    if (!fs.statSync(dir).isDirectory()) {
      throw new ToolError(`"${input.path}" is not a directory. Use the read tool.`)
    }

    const entries: Entry[] = []
    walk(ctx.cwd, dir, (input.depth ?? 2) - 1, entries)

    const body = entries
      .map((entry) => (entry.isDir ? `${entry.path}/` : `${entry.path}  (${entry.size} B)`))
      .join("\n")
    const capped =
      entries.length >= MAX_ENTRIES ? `\n\n[truncated at ${MAX_ENTRIES} entries]` : ""

    return {
      title: `list ${relative(ctx.cwd, dir)} (${entries.length} entries)`,
      output: entries.length === 0 ? "(empty)" : body + capped,
      metadata: { count: entries.length },
    }
  },
}
