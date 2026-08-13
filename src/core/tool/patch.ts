import fs from "node:fs"
import { z } from "zod"
import { relative, resolveInside, ToolError, type TitahTool } from "./types.ts"

/**
 * Beberapa suntingan pada satu berkas, dalam satu panggilan (gap 17).
 *
 * Sepuluh perubahan kecil pada satu berkas lewat `edit` berarti sepuluh putaran
 * model, sepuluh dialog izin, dan sepuluh kesempatan bagi giliran itu untuk
 * terputus di tengah. Yang paling merugikan adalah yang terakhir: berkas yang
 * separuh tersunting lebih buruk daripada yang belum disentuh, karena ia
 * kompilasi-nya gagal dengan cara yang tidak jelas milik siapa.
 *
 * Karena itu SEMUA-ATAU-TIDAK-SAMA-SEKALI. Satu potongan yang tidak cocok
 * membatalkan seluruh panggilan, dan berkasnya tidak pernah ditulis.
 */

const hunk = z.object({
  find: z.string().min(1).describe("Exact text to replace. Must appear exactly once."),
  replace: z.string().describe("Replacement text. Empty string deletes the found text."),
})

const inputSchema = z.object({
  path: z.string().describe("File path, relative to the working directory"),
  edits: z
    .array(hunk)
    .min(1)
    .describe(
      "Edits applied in order, all or nothing. If any `find` is missing or ambiguous, " +
        "the file is left completely untouched.",
    ),
})

export interface PatchOutcome {
  text: string
  applied: number
}

/**
 * Menerapkan seluruh potongan ke satu teks, atau melempar.
 *
 * Dipisah dari I/O supaya aturannya bisa diuji tanpa menyentuh disk — dan
 * supaya jelas bahwa tidak ada satu pun jalur di sini yang menulis berkas
 * setengah jadi.
 */
export function applyEdits(source: string, edits: { find: string; replace: string }[]): PatchOutcome {
  let text = source

  for (const [index, edit] of edits.entries()) {
    const first = text.indexOf(edit.find)
    if (first === -1) {
      throw new ToolError(
        `Edit ${index + 1} of ${edits.length} does not match: its \`find\` text is not in the ` +
          `file${index > 0 ? " after the earlier edits were applied" : ""}. ` +
          "Nothing was written. Read the file again and retry with the exact text.",
      )
    }
    // Ambigu ditolak, tidak dipilih yang pertama. `edit` sudah memilih aturan
    // ini (DESIGN.md §3) dan menyimpang di sini berarti dua tool yang mengubah
    // berkas punya dua janji berbeda tentang hal yang sama.
    if (text.indexOf(edit.find, first + 1) !== -1) {
      throw new ToolError(
        `Edit ${index + 1} of ${edits.length} is ambiguous: its \`find\` text appears more than ` +
          "once. Nothing was written. Include more surrounding context to make it unique.",
      )
    }
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length)
  }

  return { text, applied: edits.length }
}

export const patchTool: TitahTool<typeof inputSchema> = {
  name: "patch",
  description:
    "Apply several edits to one file in a single call, all or nothing. Each edit " +
    "replaces exact text that must appear exactly once, and edits are applied in order. " +
    "If any of them does not match, the file is left untouched. Prefer this over " +
    "repeated `edit` calls on the same file.",
  inputSchema,
  mutates: true,
  permission(input) {
    return {
      kind: "edit",
      title: `patch ${input.path} (${input.edits.length} edits)`,
      detail: input.edits
        .map((edit, index) => `--- edit ${index + 1} ---\n- ${edit.find}\n+ ${edit.replace}`)
        .join("\n\n"),
      pattern: "edit",
      subject: input.path,
    }
  },
  async execute(input, ctx) {
    const file = resolveInside(ctx.cwd, input.path)

    let source: string
    try {
      source = fs.readFileSync(file, "utf8")
    } catch {
      throw new ToolError(`Cannot read ${relative(ctx.cwd, file)} — patch only edits existing files.`)
    }

    const { text, applied } = applyEdits(source, input.edits)
    if (text === source) {
      // Bisa terjadi kalau setiap `replace` identik dengan `find`-nya. Menulis
      // ulang berkas yang isinya sama akan menggerakkan mtime dan memicu
      // watcher orang lain tanpa alasan.
      return {
        title: `patch ${relative(ctx.cwd, file)} (no change)`,
        output: "Every edit matched but produced identical text. The file was not rewritten.",
      }
    }

    fs.writeFileSync(file, text, "utf8")
    return {
      title: `patch ${relative(ctx.cwd, file)} (${applied} edits)`,
      output: `Applied ${applied} edit${applied === 1 ? "" : "s"} to ${relative(ctx.cwd, file)}.`,
      metadata: { applied },
    }
  },
}
