import fs from "node:fs"
import { z } from "zod"
import { countLines, relative, resolveInside, ToolError, type TitahTool } from "./types.ts"

const inputSchema = z.object({
  path: z.string().describe("Path of the file to edit, relative to the working directory"),
  oldString: z.string().describe("Exact text to replace, including indentation"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence. Without this, oldString must be unique."),
})

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Konteks singkat di sekitar kecocokan, untuk judul yang informatif. */
function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length
}

export const editTool: TitahTool<typeof inputSchema> = {
  name: "edit",
  description:
    "Replace exact text inside a file. `oldString` must match character for character " +
    "including indentation, and must be unique unless `replaceAll` is given. " +
    "On no match this tool FAILS and writes nothing.",
  inputSchema,
  mutates: true,
  permission(input) {
    return {
      kind: "edit",
      title: `edit ${input.path}`,
      detail: `--- lama\n${input.oldString}\n--- baru\n${input.newString}`,
      pattern: "edit",
    }
  },
  async execute(input, ctx) {
    const file = resolveInside(ctx.cwd, input.path)

    if (input.oldString === input.newString) {
      throw new ToolError("oldString and newString are identical — nothing to change.")
    }
    if (input.oldString === "") {
      throw new ToolError("oldString is empty. To create a new file, use the write tool.")
    }
    if (!fs.existsSync(file)) throw new ToolError(`File not found: ${input.path}`)

    const before = fs.readFileSync(file, "utf8")
    const occurrences = countOccurrences(before, input.oldString)

    // Gagal keras adalah fitur: lebih baik menolak daripada menulis di tempat
    // yang salah secara diam-diam.
    if (occurrences === 0) {
      throw new ToolError(
        `oldString not found in ${input.path}. Match it exactly, including whitespace and indentation. ` +
          "Re-read the file if needed.",
      )
    }
    if (occurrences > 1 && input.replaceAll !== true) {
      throw new ToolError(
        `oldString appears ${occurrences} times in ${input.path}. Extend the context until it is unique, ` +
          "or pass replaceAll: true if you really mean to replace all of them.",
      )
    }

    const after =
      input.replaceAll === true
        ? before.split(input.oldString).join(input.newString)
        : before.replace(input.oldString, input.newString)

    fs.writeFileSync(file, after)

    const line = lineOf(before, before.indexOf(input.oldString))
    const replaced = input.replaceAll === true ? occurrences : 1

    return {
      title: `edit ${relative(ctx.cwd, file)} (${replaced}× at line ${line})`,
      output:
        `Replaced ${replaced} occurrence(s) in ${relative(ctx.cwd, file)}.\n` +
        `Line count went from ${countLines(before)} to ${countLines(after)}.`,
      metadata: { replaced, line },
    }
  },
}
