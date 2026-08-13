import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import type { Config } from "./schema.ts"

/**
 * Plugin: penyesuaian PERILAKU, bukan penambahan tool.
 *
 * MCP sudah menutup jalur tool pihak ketiga. Yang belum tertutup adalah hal-hal
 * yang tidak berbentuk tool sama sekali: menjalankan pemformat sesudah tiap
 * `write`, menolak `edit` pada berkas tertentu, mencatat setiap panggilan tool
 * ke sistem audit sendiri. Semuanya sebelumnya berarti fork.
 *
 * # Plugin adalah kode yang berjalan di dalam proses ini
 *
 * Tidak ada sandbox, dan tidak dijanjikan akan ada. Plugin bisa membaca berkas
 * apa pun yang bisa dibaca Titah, memanggil jaringan, dan melihat setiap
 * masukan tool sebelum user menyetujuinya. Menyalakan sebuah plugin adalah
 * keputusan kepercayaan yang setara dengan `npm install` — dan karena itu
 * plugin HARUS disebut satu per satu di config. Tidak ada penemuan otomatis
 * dari node_modules, karena "terpasang" tidak pernah berarti "dipercaya".
 *
 * # Urutan kaitnya menentukan apa yang disetujui user
 *
 * `tool.before` berjalan SEBELUM dialog izin, bukan sesudah. Kalau sesudah,
 * plugin yang mengubah masukan akan membuat user menyetujui satu hal lalu
 * sesuatu yang lain yang dijalankan — dan itu membatalkan seluruh arti dialog
 * izin.
 */

export interface PluginContext {
  cwd: string
  config: Config
  /** Nilai yang ditulis user di `plugin.<spec>` — bentuknya milik plugin. */
  options: Record<string, unknown>
}

export interface ToolBefore {
  tool: string
  input: unknown
  sessionID: string
  cwd: string
}

export interface ToolAfter extends ToolBefore {
  output: string
  title: string
}

/**
 * Yang boleh dikembalikan `tool.before`.
 *
 * `deny` menghentikan panggilan sebelum izin ditanyakan. `input` menggantikan
 * masukan tool — dan karena kait ini berjalan sebelum izin, yang muncul di
 * dialog adalah masukan yang sudah diganti, bukan yang asli.
 */
export interface BeforeVerdict {
  deny?: string
  input?: unknown
}

export interface PluginHooks {
  name?: string
  "tool.before"?(event: ToolBefore): Promise<BeforeVerdict | void> | BeforeVerdict | void
  "tool.after"?(event: ToolAfter): Promise<string | void> | string | void
}

export type PluginFactory = (ctx: PluginContext) => PluginHooks | Promise<PluginHooks>

export interface LoadedPlugin {
  /** Apa yang user tulis di config. */
  spec: string
  /** Nama yang diakui plugin sendiri, kalau ada. */
  name: string
  source: PluginSource
  hooks: PluginHooks
}

export interface PluginFailure {
  spec: string
  reason: string
}

// ---------------------------------------------------------------------------
// Sumber: npm hari ini, marketplace disiapkan tempatnya
// ---------------------------------------------------------------------------

export type PluginSource =
  | { kind: "npm"; package: string }
  | { kind: "file"; path: string }
  | { kind: "market"; id: string }

/**
 * Menerjemahkan apa yang user tulis menjadi sumber yang bisa dimuat.
 *
 * Tiga bentuk, dan yang ketiga sengaja ada sekarang meski belum bisa dipakai:
 *
 *   "@acme/titah-prettier"   → npm
 *   "./plugin/audit.ts"      → berkas lokal, relatif terhadap cwd
 *   "market:prettier"        → marketplace
 *
 * Menambahkan `market:` belakangan berarti menebak bagaimana ia akan ditulis,
 * dan setiap tebakan yang salah menjadi perubahan yang memutus config orang.
 * Dengan bentuknya ditetapkan sekarang, yang tersisa nanti hanyalah mengisi
 * `resolveMarket` — dan sampai itu ada, ia GAGAL dengan kalimat yang menyebut
 * keadaannya, bukan diam-diam diperlakukan sebagai nama paket npm dan
 * berujung "module not found" yang menyesatkan.
 */
export function parsePluginSpec(spec: string): PluginSource {
  const trimmed = spec.trim()
  if (trimmed.startsWith("market:")) return { kind: "market", id: trimmed.slice("market:".length) }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || path.isAbsolute(trimmed)) {
    return { kind: "file", path: trimmed }
  }
  return { kind: "npm", package: trimmed }
}

/**
 * Manifest yang akan dikembalikan marketplace untuk satu plugin.
 *
 * Ditetapkan sekarang karena ia menentukan bentuk config: sebuah entri
 * marketplace harus bisa dipetakan ke paket npm dan versi yang PASTI, supaya
 * "market:prettier" di dua mesin berarti kode yang sama. Registry yang
 * mengembalikan "paket terbaru" tidak bisa memberi jaminan itu.
 */
export interface MarketEntry {
  id: string
  package: string
  version: string
  description?: string
  homepage?: string
}

export class PluginError extends Error {}

/** Belum ada; bentuknya sudah ada. Lihat `parsePluginSpec`. */
export function resolveMarket(id: string): MarketEntry {
  throw new PluginError(
    `The plugin marketplace is not available yet, so "market:${id}" cannot be resolved. ` +
      "Install the package with npm and name it directly for now — " +
      'for example {"plugin": {"@acme/titah-' +
      id +
      '": {}}}.',
  )
}

// ---------------------------------------------------------------------------
// Pemuatan
// ---------------------------------------------------------------------------

/**
 * Menemukan berkas plugin, dari sudut pandang PROYEK user.
 *
 * Diresolusi relatif `cwd`, bukan relatif berkas ini. Plugin dipasang ke
 * `node_modules` proyek user; meresolusinya dari lokasi Titah akan mencari di
 * `node_modules` Titah sendiri, tempat plugin mereka tidak akan pernah ada.
 */
function resolveModule(source: PluginSource, cwd: string): string {
  if (source.kind === "market") return resolveMarket(source.id).package
  if (source.kind === "file") return pathToFileURL(path.resolve(cwd, source.path)).href

  const require = createRequire(path.join(cwd, "package.json"))
  try {
    return pathToFileURL(require.resolve(source.package)).href
  } catch {
    throw new PluginError(
      `Cannot find "${source.package}". Install it in this project first: ` +
        `npm install ${source.package}`,
    )
  }
}

/**
 * Memuat setiap plugin yang disebut config.
 *
 * Kegagalan satu plugin TIDAK menjatuhkan yang lain dan tidak menjatuhkan sesi.
 * Ia dikumpulkan dan dilaporkan — persis seperti server MCP yang mati. Sesi
 * yang menolak dimulai karena satu plugin catatan-audit rusak menghukum orang
 * atas hal yang tidak ia minta saat itu.
 */
export async function loadPlugins(
  config: Config,
  cwd: string,
): Promise<{ plugins: LoadedPlugin[]; failures: PluginFailure[] }> {
  const plugins: LoadedPlugin[] = []
  const failures: PluginFailure[] = []

  for (const [spec, entry] of Object.entries(config.plugin)) {
    if (entry.enabled === false) continue

    try {
      const source = parsePluginSpec(spec)
      const url = resolveModule(source, cwd)

      /*
       * Modul disimpan Node berdasarkan URL-nya, dan itu TIDAK dilewati di
       * sini. Konsekuensinya nyata: menyunting berkas plugin di tengah sesi
       * tidak berpengaruh sampai Titah dijalankan ulang.
       *
       * Membuang cache — misalnya dengan menambahkan `?v=<mtime>` — akan
       * membuat setiap versi tetap tinggal di registry modul selama proses
       * hidup, dan sesi yang berjalan berjam-jam sambil plugin-nya disunting
       * berulang kali menumpuk semuanya. Untuk bentuk yang paling umum, paket
       * npm yang berubah hanya saat dipasang ulang, cache justru yang benar.
       */
      const module = (await import(url)) as { default?: unknown }
      const factory = module.default

      if (typeof factory !== "function") {
        throw new PluginError(
          "Its default export is not a function. A plugin exports a factory: " +
            "`export default (ctx) => ({ \"tool.after\": ... })`.",
        )
      }

      const hooks = await (factory as PluginFactory)({ cwd, config, options: entry.options })
      if (hooks === null || typeof hooks !== "object") {
        throw new PluginError("Its factory returned no hooks object.")
      }

      plugins.push({ spec, name: hooks.name ?? spec, source, hooks })
    } catch (error) {
      failures.push({ spec, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return { plugins, failures }
}

// ---------------------------------------------------------------------------
// Pemanggilan kait
// ---------------------------------------------------------------------------

/**
 * Menjalankan `tool.before` pada setiap plugin, berurutan.
 *
 * Berurutan, bukan paralel: plugin kedua harus melihat masukan yang sudah
 * diubah plugin pertama. Menjalankannya paralel membuat hasilnya bergantung
 * pada siapa yang selesai lebih dulu.
 *
 * # Plugin yang melempar berarti MENOLAK
 *
 * Arah ini disengaja dan berlawanan dengan `tool.after`. Sebuah `tool.before`
 * adalah penjaga; penjaga yang rusak lalu diabaikan sama saja dengan tidak ada
 * penjaga, dan kegagalannya persis terjadi pada panggilan yang mungkin justru
 * ingin ia hentikan.
 */
export async function runBefore(
  plugins: LoadedPlugin[],
  event: ToolBefore,
): Promise<{ input: unknown; deny?: string; by?: string }> {
  let input = event.input

  for (const plugin of plugins) {
    const hook = plugin.hooks["tool.before"]
    if (!hook) continue

    try {
      const verdict = await hook({ ...event, input })
      if (verdict && typeof verdict === "object") {
        if (typeof verdict.deny === "string") {
          return { input, deny: verdict.deny, by: plugin.name }
        }
        if (verdict.input !== undefined) input = verdict.input
      }
    } catch (error) {
      return {
        input,
        deny: `plugin "${plugin.name}" failed while checking this call: ${
          error instanceof Error ? error.message : String(error)
        }`,
        by: plugin.name,
      }
    }
  }

  return { input }
}

/**
 * Menjalankan `tool.after` pada setiap plugin, berurutan.
 *
 * Plugin yang melempar di sini DIABAIKAN, kebalikan dari `tool.before`. Kait
 * ini hanya membentuk keluaran yang sudah terjadi; membuang hasil tool yang
 * berhasil karena pencatat log-nya rusak menghilangkan pekerjaan sungguhan
 * demi hal yang tidak esensial.
 */
export async function runAfter(
  plugins: LoadedPlugin[],
  event: ToolAfter,
): Promise<{ output: string; failures: PluginFailure[] }> {
  let output = event.output
  const failures: PluginFailure[] = []

  for (const plugin of plugins) {
    const hook = plugin.hooks["tool.after"]
    if (!hook) continue

    try {
      const replaced = await hook({ ...event, output })
      if (typeof replaced === "string") output = replaced
    } catch (error) {
      failures.push({
        spec: plugin.spec,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { output, failures }
}
