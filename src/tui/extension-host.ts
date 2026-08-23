import type { View } from "../extension.ts"
import type { LoadedExtension } from "../core/extension.ts"
import { PANEL_CHROME_COLUMNS, PANEL_CHROME_ROWS, type PanelLine } from "./panels.ts"
import { viewLines } from "./view.ts"

/**
 * Menjalankan `render` sebuah extension dengan aman.
 *
 * Q24 memutuskan penahanannya: panel yang gagal menampilkan pesannya DI
 * TEMPATNYA, dan TUI tetap hidup. Itu doktrin yang sama dengan yang sudah
 * tertulis di `plugin.ts` — kegagalan tidak menjatuhkan sesi — dan dua sistem
 * ekstensi dengan dua janji berbeda soal kegagalan berarti user tidak akan tahu
 * yang mana yang sedang gagal.
 *
 * Yang ditahan ada tiga, dan ketiganya berbeda jenis:
 *
 *   1. `render` yang MELEMPAR         → pesannya digambar di panel
 *   2. `render` yang tidak selesai     → dibatalkan lewat signal, lalu dilaporkan
 *   3. `render` yang mengembalikan     → ditolak di sini, bukan diteruskan ke
 *      bentuk yang bukan `View`          renderer yang akan gagal lebih dalam
 *
 * Nomor 3 yang paling mudah terlewat. Extension yang mengembalikan `undefined`
 * karena satu cabang lupa `return` akan meledak di dalam `viewLines` dengan
 * pesan tentang `kind`, dan pesan itu menunjuk berkas Titah — bukan berkas
 * extension yang sebenarnya salah.
 */

/**
 * Batas waktu satu render, dalam milidetik.
 *
 * Dua detik: cukup untuk `git worktree list` pada repo besar dan cukup pendek
 * supaya panel yang menggantung terlihat sebagai panel yang menggantung, bukan
 * sebagai Titah yang lambat.
 */
export const PANEL_TIMEOUT_MS = 2_000

export interface HostResult {
  lines: PanelLine[]
  /** Terisi kalau render gagal. Panel menggambarnya di tempat isinya. */
  error?: string
}

export interface HostRequest {
  extension: LoadedExtension
  /** Lebar PANEL. Pengurangan bingkai terjadi di sini, sekali. */
  width: number
  rows: number
  timeoutMs?: number
}

export async function renderPanel(request: HostRequest): Promise<HostResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? PANEL_TIMEOUT_MS)

  try {
    const view = await request.extension.panel.render({
      signal: controller.signal,
      /*
       * Extension menerima lebar yang SUDAH bersih dari bingkai.
       *
       * Kalau ia harus menguranginya sendiri, setiap extension menebak berapa
       * yang diambil bingkai — dan tebakan yang salah muncul sebagai teks yang
       * membungkus, dengan Titah yang disalahkan.
       */
      width: Math.max(0, request.width - PANEL_CHROME_COLUMNS),
      rows: Math.max(0, request.rows - PANEL_CHROME_ROWS),
    })

    if (!isView(view)) {
      return {
        lines: [],
        error: `${request.extension.spec} returned an unknown view shape`,
      }
    }
    return { lines: viewLines(view, request.width) }
  } catch (error) {
    /*
     * Timeout dilaporkan sebagai timeout, bukan sebagai "aborted".
     *
     * `AbortError` adalah nama yang benar secara teknis dan tidak berguna secara
     * praktis: ia tidak memberi tahu bahwa yang membatalkan adalah batas waktu
     * Titah, jadi orang akan mencari pembatalan di kode extension-nya.
     */
    if (controller.signal.aborted) {
      return {
        lines: [],
        error: `${request.extension.spec} timed out after ${request.timeoutMs ?? PANEL_TIMEOUT_MS}ms`,
      }
    }
    return { lines: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Apakah nilai ini benar-benar salah satu bentuk `View`.
 *
 * Diperiksa per-`kind` dan bukan hanya "punya properti kind": `{ kind: "rows" }`
 * tanpa `rows` akan lolos pemeriksaan yang lebih longgar dan gagal di dalam
 * `viewLines` saat memanggil `.map` pada `undefined`.
 */
function isView(value: unknown): value is View {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { kind?: unknown; rows?: unknown; pairs?: unknown; text?: unknown }
  switch (candidate.kind) {
    case "rows":
      return Array.isArray(candidate.rows)
    case "pairs":
      return Array.isArray(candidate.pairs)
    case "markdown":
    case "text":
      return typeof candidate.text === "string"
    default:
      return false
  }
}

/**
 * Baris untuk panel yang render-nya gagal.
 *
 * Dipisah dari `renderPanel` supaya pemanggil bisa memilih menggambar error
 * lama sambil render baru berjalan — panel yang berkedip ke kosong setiap
 * refresh lebih mengganggu daripada panel yang menampilkan keadaan sebelumnya.
 */
export function errorLines(message: string): PanelLine[] {
  return [{ text: "failed", color: "red" }, ...message.split("\n").map((text) => ({ text, dim: true }))]
}
