import type { TitahTool } from "./types.ts"
import { readTool } from "./read.ts"
import { listTool } from "./list.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { editTool } from "./edit.ts"
import { writeTool } from "./write.ts"
import { bashTool } from "./bash.ts"
import { skillTool } from "./skill.ts"

/**
 * Tool baca berjalan tanpa izin. Tool yang mengubah sesuatu (`mutates: true`)
 * selalu lewat permission engine, dan selalu didahului snapshot supaya `/undo`
 * mungkin — lihat DESIGN.md §3.
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
]

export function toolByName(name: string): TitahTool | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export { readTool, listTool, globTool, grepTool, editTool, writeTool, bashTool, skillTool }
export * from "./types.ts"
