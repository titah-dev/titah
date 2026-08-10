import type { TitahTool } from "./types.ts"
import { readTool } from "./read.ts"
import { listTool } from "./list.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { editTool } from "./edit.ts"
import { writeTool } from "./write.ts"
import { bashTool } from "./bash.ts"
import { skillTool } from "./skill.ts"
import { taskTool } from "./task.ts"

/**
 * Tool baca berjalan tanpa izin. Tool yang mengubah sesuatu (`mutates: true`)
 * selalu lewat permission engine, dan selalu didahului snapshot supaya `/undo`
 * mungkin — lihat DESIGN.md §3.
 *
 * `taskTool` ikut terdaftar di sini seperti tool lain — penjaga kedalaman yang
 * mencegahnya diwariskan ke sub-agent hidup di `agent.ts` (`buildTools`), bukan
 * di sini, supaya satu-satunya tempat menegakkannya tetap satu-satunya tempat.
 */
export const TOOLS: TitahTool[] = [
  readTool,
  listTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  bashTool,
  skillTool,
  taskTool,
]

export function toolByName(name: string): TitahTool | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export { readTool, listTool, globTool, grepTool, editTool, writeTool, bashTool, skillTool, taskTool }
export * from "./types.ts"
