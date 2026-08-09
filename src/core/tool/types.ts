import path from "node:path"
import type { z } from "zod"
import type { Config } from "../schema.ts"

export interface ToolContext {
  /** Direktori kerja sesi. Semua path tool dibatasi di dalamnya. */
  cwd: string
  sessionID: string
  callID: string
  signal: AbortSignal
  /** Dibutuhkan tool yang membaca konfigurasi, mis. `skill`. */
  config: Config
}

export interface ToolResult {
  /** Label pendek untuk TUI, mis. "read src/cli.ts (120 baris)". */
  title: string
  /** Yang dikirim balik ke model. Blob besar dipotong di lapisan atas. */
  output: string
  metadata?: Record<string, unknown>
}

/** Izin yang harus diminta sebelum tool dijalankan (Q9). */
export interface PermissionNeed {
  kind: "edit" | "write" | "bash"
  title: string
  detail: string
  /** Pola yang masuk allowlist kalau user menjawab "selalu izinkan". */
  pattern: string
}

export interface TitahTool<Schema extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: Schema
  /**
   * Tool read-only membiarkan ini kosong. Tool yang mengubah sesuatu WAJIB
   * mengisinya — agent tidak akan pernah menjalankannya tanpa izin.
   */
  permission?(input: z.infer<Schema>, ctx: ToolContext): PermissionNeed
  /** Apakah tool ini perlu snapshot diambil dulu supaya `/undo` mungkin. */
  mutates?: boolean
  execute(input: z.infer<Schema>, ctx: ToolContext): Promise<ToolResult>
}

export class ToolError extends Error {}

/**
 * Semua akses filesystem lewat sini.
 *
 * Meski M1 hanya punya tool baca, batas ini dipasang sekarang: menambahkannya
 * belakangan berarti mengaudit ulang setiap tool yang sudah ada.
 */
export function resolveInside(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ToolError(
      `Path "${target}" is outside the session working directory (${root}). Refused.`,
    )
  }
  return resolved
}

export function relative(cwd: string, target: string): string {
  const rel = path.relative(cwd, target)
  return rel === "" ? "." : rel
}

/**
 * Memecah isi file menjadi baris seperti yang dilihat manusia.
 *
 * `"a\nb\n".split("\n")` menghasilkan 3 elemen karena newline terakhir
 * meninggalkan string kosong. Melaporkan "3 baris" untuk file dua baris membuat
 * setiap angka yang Titah tampilkan terasa meleset satu.
 */
export function splitLines(content: string): string[] {
  const lines = content.split("\n")
  if (lines.length > 1 && lines.at(-1) === "") lines.pop()
  return lines
}

export function countLines(content: string): number {
  return splitLines(content).length
}

/** Direktori yang dilewati oleh list/glob/grep kecuali diminta eksplisit. */
export const DEFAULT_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
])
