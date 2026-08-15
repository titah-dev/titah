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
  /** Terisi kalau sesi ini sendiri adalah sesi anak — lihat `Session.parentID`. */
  parentSessionID?: string
  /**
   * Jendela konteks model yang menjalankan giliran ini, kalau dideklarasikan.
   *
   * `undefined` berarti user belum mendeklarasikannya, dan ia tetap `undefined`
   * di sini — tidak ditebak, sama seperti di seluruh sisa Titah. Dipakai `plan`
   * untuk membatasi dirinya relatif jendela (issue #5).
   */
  contextWindow?: number
  /**
   * Melaporkan keluaran yang sudah keluar SELAGI tool masih berjalan.
   *
   * Opsional dengan sengaja: dari dua puluh tiga tool, hanya `bash` yang punya
   * sesuatu untuk dilaporkan di tengah jalan. Mewajibkannya berarti dua puluh
   * dua tool harus tahu fitur ini ada tanpa pernah memakainya.
   *
   * Pemanggilnya boleh memanggil ini sesering apa pun — pembatasan lajunya ada
   * di sisi penerima, bukan di sini. Tool tidak boleh perlu tahu berapa kali
   * layar sanggup digambar ulang.
   */
  progress?(chunk: string): void
  /**
   * Izin efektif giliran yang menjalankan tool ini.
   *
   * Hanya `task` yang memakainya, dan hanya untuk satu hal: mewariskannya
   * sebagai BATAS ATAS ke sub-agent. Tanpa itu, agent read-only bisa
   * mendelegasikan pekerjaan tulis yang ia sendiri tidak boleh lakukan.
   *
   * Tipe sengaja `unknown`: `tool/types.ts` tidak boleh mengimpor
   * `permission.ts`, yang mengimpor `decide.ts`, yang pada gilirannya kembali
   * ke tipe tool. `task` yang menyempitkannya kembali, di satu tempat.
   */
  permission?: unknown
  /**
   * Super agent yang boleh dipanggil giliran ini lewat `task`.
   *
   * Dihitung di `buildTools`, bukan di tool: yang menentukan adalah apakah
   * giliran ini anak dan apakah agent-nya punya `escalate` — dua fakta yang
   * tidak dimiliki tool.
   */
  supersAllowed?: string[]
  /**
   * Model yang menjalankan giliran ini.
   *
   * Dipakai `task` untuk mewariskannya ke sub-agent yang tidak menyebut
   * modelnya sendiri, dan sebagai cadangan kalau model milik sub-agent itu
   * ternyata tidak bisa dipakai.
   */
  model?: string
}

export interface ToolResult {
  /** Label pendek untuk TUI, mis. "read src/cli.ts (120 baris)". */
  title: string
  /** Yang dikirim balik ke model. Blob besar dipotong di lapisan atas. */
  output: string
  /**
   * Diisi tool yang bisa selesai tanpa melempar namun tetap gagal atau
   * dihentikan — `task` satu-satunya sejauh ini. Riwayat memakainya untuk
   * memilih glyph, supaya sub-agent yang gagal tidak digambar sebagai sukses.
   */
  outcome?: "failed" | "stopped"
  metadata?: Record<string, unknown>
}

/** Izin yang harus diminta sebelum tool dijalankan (Q9). */
export interface PermissionNeed {
  kind: "edit" | "write" | "bash" | "network" | "delete" | "mcp"
  title: string
  detail: string
  /** Pola yang masuk allowlist kalau user menjawab "selalu izinkan". */
  pattern: string
  /**
   * Bagian-bagian perintah yang MASING-MASING harus diizinkan allowlist
   * sebelum tool ini boleh jalan tanpa dialog. Hanya `bash` yang mengisinya;
   * tool lain (`edit`, `write`) tidak punya konsep ini, dan `pattern`-nya yang
   * dicocokkan.
   *
   * Array KOSONG bukan berarti "tidak ada yang perlu diperiksa" — ia berarti
   * perintahnya tidak bisa dinilai per bagian, dan jawabannya tetap bertanya.
   * Lihat issue #12 dan `commandSegments` di `tool/bash.ts`.
   */
  segments?: string[]
  /**
   * Argumen yang dinilai aturan setingkat argumen untuk sumbu NON-bash: URL
   * untuk `network`, path untuk `edit`/`write`/`delete`, nama server untuk `mcp`.
   */
  subject?: string
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
/**
 * Akar TAMBAHAN yang boleh disentuh, di luar cwd.
 *
 * Dinyatakan lewat config (`permission.rules` dengan sumbu `external_directory`),
 * bukan ditanyakan saat berjalan — dan itu keputusan sadar. `resolveInside`
 * dipanggil sinkron dari dalam sebelas tool; menjadikannya bisa bertanya berarti
 * menjadikannya async dan menyalurkan mesin izin ke setiap tool berkas.
 *
 * Lebih penting dari ongkos itu: batas cwd sekarang adalah tembok STRUKTURAL
 * yang tidak bisa salah, dan menjadikannya keputusan saat berjalan menukar
 * jaminan dengan kebijakan. Bentuk ini menahan sebagian besar jaminannya —
 * himpunan akar yang sah ditetapkan sekali, saat config dimuat, dan tidak ada
 * yang bisa menambahnya di tengah giliran.
 */
let extraRoots: string[] = []

/**
 * Dipasang sekali oleh pemuat config. Path harus ABSOLUT dan sudah diresolusi;
 * pola (`/repo/*`) dipangkas jadi direktorinya.
 */
export function setExternalRoots(roots: string[]): void {
  extraRoots = roots.map((root) => path.resolve(root.replace(/[/\\]\*+$/, "")))
}

export function externalRoots(): string[] {
  return [...extraRoots]
}

function within(root: string, resolved: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep)
}

export function resolveInside(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target)
  const root = path.resolve(cwd)
  if (within(root, resolved)) return resolved
  // Akar tambahan diperiksa SESUDAH cwd, dan hanya kalau user menyebutkannya.
  // Tidak ada bentuk umum yang membuka segalanya: setiap akar disebut satu per
  // satu, dan daftar kosong berarti perilaku lama persis.
  if (extraRoots.some((extra) => within(extra, resolved))) return resolved

  throw new ToolError(
    `Path "${target}" is outside the session working directory (${root}). Refused.` +
      (extraRoots.length === 0
        ? ' Add permission.rules {"external_directory(/path/*)": "allow"} to widen it.'
        : ` Allowed extras: ${extraRoots.join(", ")}.`),
  )
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
