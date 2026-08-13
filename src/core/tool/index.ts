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
import { planTool } from "./plan.ts"
import { webfetchTool } from "./webfetch.ts"
import { websearchTool } from "./websearch.ts"
import { patchTool } from "./patch.ts"
import { moveTool, removeTool } from "./fileops.ts"
import { bashOutputTool, bashStartTool, bashStopTool } from "./background.ts"
import { diagnosticsTool } from "./diagnostics.ts"
import { memoryTool } from "./memory.ts"
import { questionTool } from "./question.ts"
import { exitPlanTool } from "./exit-plan.ts"

/**
 * Tool baca berjalan tanpa izin. Tool yang mengubah sesuatu (`mutates: true`)
 * selalu lewat permission engine, dan selalu didahului snapshot supaya `/undo`
 * mungkin — lihat DESIGN.md §3.
 *
 * `taskTool` ikut terdaftar di sini seperti tool lain — penjaga kedalaman yang
 * mencegahnya diwariskan ke sub-agent hidup di `agent.ts` (`buildTools`), bukan
 * di sini, supaya satu-satunya tempat menegakkannya tetap satu-satunya tempat.
 */
let cached: TitahTool[] | undefined

/**
 * Daftar tool, dibangun saat DIPANGGIL, bukan saat modul ini dievaluasi.
 *
 * `task.ts` menutup siklus modul balik ke sini lewat subagent.ts → agent.ts.
 * Array literal di level atas modul akan membaca `taskTool` sebelum body
 * task.ts sempat berjalan kalau `task.ts` adalah modul PERTAMA yang dimuat —
 * TDZ ReferenceError yang tidak bergantung pada `task.ts` maupun siklusnya
 * sama sekali, melainkan pada urutan impor siapa pun yang memuat modul ini.
 * Menunda pembacaannya ke titik panggilan menghilangkan urutan itu dari
 * persamaan: pada saat fungsi ini benar-benar dipanggil, seluruh grafik modul
 * sudah selesai dimuat, jadi `taskTool` — dan tool apa pun lainnya — sudah
 * pasti terisi, tidak peduli modul mana yang dimuat lebih dulu.
 */
export function allTools(): TitahTool[] {
  cached ??= [
    readTool,
    listTool,
    globTool,
    grepTool,
    editTool,
    writeTool,
    bashTool,
    skillTool,
    taskTool,
    planTool,
    webfetchTool,
    websearchTool,
    patchTool,
    moveTool,
    removeTool,
    bashStartTool,
    bashOutputTool,
    bashStopTool,
    diagnosticsTool,
    memoryTool,
    questionTool,
    exitPlanTool,
  ]
  return cached
}

export function toolByName(name: string): TitahTool | undefined {
  return allTools().find((tool) => tool.name === name)
}

export {
  readTool,
  listTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  bashTool,
  skillTool,
  taskTool,
  planTool,
  webfetchTool,
  websearchTool,
  patchTool,
  moveTool,
  removeTool,
  bashStartTool,
  bashOutputTool,
  bashStopTool,
  diagnosticsTool,
  memoryTool,
  questionTool,
  exitPlanTool,
}
export * from "./types.ts"
