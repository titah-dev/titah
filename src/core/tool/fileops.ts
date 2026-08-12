import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { relative, resolveInside, ToolError, type TitahTool } from "./types.ts"

/**
 * `move` dan `remove`.
 *
 * Keduanya bisa dikerjakan `bash`, dan itu justru alasannya ada di sini:
 * membuka SELURUH shell demi satu `mv` adalah pertukaran izin yang buruk. Agent
 * yang cuma perlu memindahkan berkas tidak seharusnya menerima kemampuan
 * menjalankan apa pun.
 *
 * Keduanya juga dibatasi `resolveInside`, sama seperti tool berkas lain — jadi
 * tidak ada jalan keluar dari cwd lewat sini.
 */

const moveInput = z.object({
  from: z.string().describe("Existing path, relative to the working directory"),
  to: z.string().describe("Destination path, relative to the working directory"),
})

export const moveTool: TitahTool<typeof moveInput> = {
  name: "move",
  description:
    "Move or rename a file or directory inside the working directory. Refuses to " +
    "overwrite an existing destination — delete it first if that is really what you want.",
  inputSchema: moveInput,
  mutates: true,
  permission(input) {
    return {
      kind: "write",
      title: `move ${input.from} → ${input.to}`,
      detail: `Move ${input.from}\n    to ${input.to}\n\nNothing is overwritten: if the destination exists, this fails.`,
      pattern: "write",
    }
  },
  async execute(input, ctx) {
    const from = resolveInside(ctx.cwd, input.from)
    const to = resolveInside(ctx.cwd, input.to)

    if (!fs.existsSync(from)) {
      throw new ToolError(`Nothing at ${relative(ctx.cwd, from)} to move.`)
    }
    /*
     * Menolak menimpa, dan itu yang membuat `move` cukup di sumbu `write`.
     *
     * Kalau ia boleh menimpa, ia bisa menghancurkan berkas tanpa lewat sumbu
     * `delete` sama sekali — sumbu itu jadi pagar yang bisa dilangkahi lewat
     * pintu sebelah. Menolak membuat janjinya sederhana: `move` tidak pernah
     * menghilangkan apa pun.
     */
    if (fs.existsSync(to)) {
      throw new ToolError(
        `${relative(ctx.cwd, to)} already exists. move never overwrites — ` +
          "remove the destination first, or pick another name.",
      )
    }

    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return {
      title: `move ${relative(ctx.cwd, from)} → ${relative(ctx.cwd, to)}`,
      output: `Moved ${relative(ctx.cwd, from)} to ${relative(ctx.cwd, to)}.`,
    }
  },
}

const removeInput = z.object({
  path: z.string().describe("Path to delete, relative to the working directory"),
  recursive: z
    .boolean()
    .default(false)
    .describe("Required to delete a directory. Deleting a directory deletes everything in it."),
})

export const removeTool: TitahTool<typeof removeInput> = {
  name: "remove",
  description:
    "Delete a file, or a directory with recursive: true. This is not undoable through " +
    "/undo unless the path was tracked by git — prefer leaving deletion to the user " +
    "when you are not certain.",
  inputSchema: removeInput,
  mutates: true,
  permission(input) {
    return {
      // Sumbu SENDIRI, bukan `write`. Agent dengan `write: allow` yang
      // dimaksudkan sebagai "boleh membuat berkas baru" tidak pernah
      // dimaksudkan sebagai "boleh menghapus berkas saya".
      kind: "delete",
      title: `remove ${input.path}${input.recursive ? " (recursive)" : ""}`,
      detail: input.recursive
        ? `Delete ${input.path} AND EVERYTHING INSIDE IT.`
        : `Delete ${input.path}.`,
      pattern: "delete",
    }
  },
  async execute(input, ctx) {
    const target = resolveInside(ctx.cwd, input.path)

    // Menghapus cwd sendiri lolos `resolveInside` — ia memang "di dalam" cwd
    // menurut definisi apa pun yang masuk akal, dan hasilnya menghapus seluruh
    // proyek dari bawah sesi yang sedang berjalan.
    if (path.resolve(target) === path.resolve(ctx.cwd)) {
      throw new ToolError("Refusing to delete the working directory itself.")
    }

    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      throw new ToolError(`Nothing at ${relative(ctx.cwd, target)} to remove.`)
    }

    if (stat.isDirectory() && !input.recursive) {
      const count = fs.readdirSync(target).length
      throw new ToolError(
        `${relative(ctx.cwd, target)} is a directory with ${count} ` +
          `entr${count === 1 ? "y" : "ies"}. Pass recursive: true if you really mean to delete it.`,
      )
    }

    fs.rmSync(target, { recursive: input.recursive, force: false })
    return {
      title: `remove ${relative(ctx.cwd, target)}`,
      output: `Deleted ${relative(ctx.cwd, target)}.`,
    }
  },
}
