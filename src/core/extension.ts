import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { satisfiesEngine, type ExtensionFactory, type ExtensionPanel } from "../extension.ts"
import { dataDir } from "./paths.ts"
import type { Config } from "./schema.ts"

/**
 * Memuat extension: panel samping yang disumbang paket npm.
 *
 * # Kenapa direktori sendiri, bukan node_modules proyek user
 *
 * `plugin.ts` meresolusi dari `node_modules` PROYEK — jadi memasang satu plugin
 * berarti menambahkan dependency ke `package.json` orang, mencampur tooling
 * dengan dependency aplikasi. Extension tidak melakukan itu: ia preferensi
 * ORANG, bukan dependency PROYEK, jadi panelnya ikut pindah antar repo dan
 * proyek siapa pun tidak pernah tahu ia ada.
 *
 * Ketidakkonsistenan dengan `plugin` itu dipilih sadar. Yang salah adalah pola
 * `plugin`, bukan pola di sini.
 *
 * # Kenapa `engines.titah` diperiksa saat load
 *
 * Tanpa itu, extension yang ditulis untuk API lama gagal dengan
 * `TypeError: render is not a function` di tengah render — pesan yang menunjuk
 * tempat yang salah dan sebab yang salah. Diperiksa di sini, ia gagal dengan
 * kalimat yang menyebut versi yang dibutuhkan dan versi yang ada.
 */

export type ExtensionSource =
  | { kind: "npm"; package: string }
  | { kind: "file"; path: string }
  | { kind: "market"; id: string }

export class ExtensionError extends Error {}

/**
 * Tiga bentuk kunci, sama dengan `plugin`. Satu pola untuk dua sistem berarti
 * orang tidak perlu mempelajari aturan penulisan kedua.
 */
export function parseExtensionSpec(spec: string): ExtensionSource {
  const trimmed = spec.trim()
  if (trimmed.startsWith("market:")) return { kind: "market", id: trimmed.slice("market:".length) }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || path.isAbsolute(trimmed)) {
    return { kind: "file", path: trimmed }
  }
  return { kind: "npm", package: trimmed }
}

/**
 * Memisah `<paket>[@versi]` yang diketik user.
 *
 * Pemisahnya `@` TERAKHIR, dan hanya kalau ia bukan karakter pertama. Tanpa
 * syarat kedua, `@titah/extension-git` terpotong pada `@` di posisi nol dan
 * menghasilkan paket bernama kosong pada versi `titah/extension-git` — npm lalu
 * gagal dengan pesan tentang nama paket yang tidak pernah user tulis.
 */
export function parseInstallTarget(spec: string): { packageName: string; version?: string } {
  const trimmed = spec.trim()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0) return { packageName: trimmed }
  return { packageName: trimmed.slice(0, at), version: trimmed.slice(at + 1) }
}

/**
 * Tempat extension npm diunduh. Bukan `node_modules` proyek user.
 *
 * Isinya proyek npm biasa yang kebetulan dimiliki Titah — lihat
 * `extension-install.ts` untuk alasan `npm install` yang dipakai alih-alih
 * ekstraksi tarball sendiri.
 */
export function extensionRoot(): string {
  return path.join(dataDir(), "extension")
}

/**
 * Manifest `package.json` sebuah extension, sebatas yang Titah baca.
 *
 * `titah.panel` adalah SATU field di antara beberapa yang mungkin, dan bentuk
 * itu disengaja: kalau extension nanti perlu menjangkau sisi server,
 * `titah.hooks` jadi field baru — bukan perubahan bentuk yang memutus config
 * orang. Alasan yang sama dengan kenapa `market:` sudah ada di `plugin.ts`
 * sebelum bisa dipakai.
 */
export interface ExtensionManifest {
  name?: string
  version?: string
  engines?: { titah?: string }
  titah?: { panel?: string }
}

export interface LoadedExtension {
  spec: string
  panel: ExtensionPanel
  /** Sisi yang berlaku: config user menang atas usulan extension. */
  side: "left" | "right"
  /** Tombol yang berlaku, kalau ada. */
  key?: string
  version?: string
}

export interface ExtensionFailure {
  spec: string
  message: string
}

/**
 * Direktori tempat sebuah spec seharusnya berada.
 *
 * `file:` diresolusi relatif cwd sesi — di situlah user menulis path relatifnya,
 * dan meresolusinya relatif lokasi Titah akan mencari di tempat yang tidak
 * pernah ia maksud.
 */
export function extensionDir(source: ExtensionSource, cwd: string): string {
  if (source.kind === "file") return path.resolve(cwd, source.path)
  // `node_modules/<nama>` apa adanya: npm sudah menangani nama berskop sebagai
  // dua tingkat direktori, dan menyandikannya sendiri berarti Titah mencari di
  // tempat yang bukan tempat npm menaruhnya.
  if (source.kind === "npm") return path.join(extensionRoot(), "node_modules", source.package)
  throw new ExtensionError(
    `The extension registry is not wired yet, so "market:${source.id}" cannot be resolved.`,
  )
}

/**
 * Membaca manifest sebuah extension dari direktorinya.
 *
 * Manifest yang tidak bisa dibaca atau tidak bisa diurai adalah kegagalan yang
 * DILAPORKAN, bukan dianggap manifest kosong. Manifest kosong akan lolos
 * pemeriksaan `engines` dengan diam, dan yang gagal berikutnya adalah import —
 * dengan pesan yang tidak menyebut sebab sebenarnya.
 */
export function readManifest(directory: string): ExtensionManifest {
  const file = path.join(directory, "package.json")
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    throw new ExtensionError(`No package.json in ${directory}`)
  }
  try {
    return JSON.parse(raw) as ExtensionManifest
  } catch {
    throw new ExtensionError(`package.json in ${directory} is not valid JSON`)
  }
}

/** Berkas yang harus di-import untuk sebuah extension. */
export function entryFile(directory: string, manifest: ExtensionManifest): string {
  const entry = manifest.titah?.panel
  if (entry === undefined || entry.trim() === "") {
    throw new ExtensionError(
      `${manifest.name ?? directory} does not declare "titah": { "panel": "..." } in its package.json, ` +
        "so Titah does not know what to load.",
    )
  }
  /*
   * Diresolusi lalu DIPERIKSA masih di dalam direktorinya.
   *
   * `"panel": "../../../etc/passwd"` adalah manifest yang sah secara JSON, dan
   * tanpa pemeriksaan ini ia menjadi jalan bagi paket untuk menyuruh Titah
   * meng-import berkas di luar dirinya. Itu bukan kemampuan yang pernah
   * diberikan kepada extension.
   */
  const resolved = path.resolve(directory, entry)
  const root = path.resolve(directory)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ExtensionError(
      `${manifest.name ?? directory} points its panel entry outside its own directory (${entry})`,
    )
  }
  return resolved
}

/**
 * Memeriksa `engines.titah`. Melempar dengan kalimat yang menyebut kedua versi.
 *
 * Extension TANPA `engines.titah` ditolak, bukan diterima. Selama API masih 0.x
 * ia berubah, dan paket yang tidak menyatakan versi yang ia targetkan tidak bisa
 * dibedakan dari paket yang ditulis dua rilis lalu — jadi memuatnya berarti
 * menukar kegagalan yang jelas dengan kegagalan yang menyesatkan.
 */
export function checkEngine(manifest: ExtensionManifest, titahVersion: string): void {
  const range = manifest.engines?.titah
  if (range === undefined || range.trim() === "") {
    throw new ExtensionError(
      `${manifest.name ?? "extension"} does not declare engines.titah. ` +
        `Add {"engines": {"titah": "^${titahVersion}"}} to its package.json.`,
    )
  }
  if (!satisfiesEngine(titahVersion, range)) {
    throw new ExtensionError(
      `${manifest.name ?? "extension"} needs Titah ${range}, but this is ${titahVersion}.`,
    )
  }
}

export interface LoadOptions {
  config: Config
  cwd: string
  version: string
}

/**
 * Memuat setiap extension yang disebut config.
 *
 * Kegagalan satu extension tidak menjatuhkan yang lain dan tidak menjatuhkan
 * sesi — aturan yang sama dengan `plugin` dan dengan server MCP yang mati.
 * Kegagalannya dikumpulkan dan dilaporkan sekali lewat notice.
 *
 * Dua sisi dan lebih dari dua extension: yang PERTAMA di config menang untuk
 * satu sisi, dan sisanya dilaporkan. Urutan config adalah satu-satunya urutan
 * yang user bisa lihat dan ubah; memilih berdasarkan apa pun yang lain berarti
 * pemenangnya tidak bisa dijelaskan.
 */
export async function loadExtensions(
  options: LoadOptions,
): Promise<{ extensions: LoadedExtension[]; failures: ExtensionFailure[] }> {
  const extensions: LoadedExtension[] = []
  const failures: ExtensionFailure[] = []
  const taken = new Set<string>()

  for (const [spec, entry] of Object.entries(options.config.extension)) {
    if (entry.enabled === false) continue

    try {
      const source = parseExtensionSpec(spec)
      const directory = extensionDir(source, options.cwd)
      const manifest = readManifest(directory)
      checkEngine(manifest, options.version)

      const url = pathToFileURL(entryFile(directory, manifest)).href
      const module = (await import(url)) as { default?: unknown }
      const factory = module.default
      if (typeof factory !== "function") {
        throw new ExtensionError(
          `${spec} does not default-export a function. See docs/extensions.md for the factory shape.`,
        )
      }

      const panel = await (factory as ExtensionFactory)({ cwd: options.cwd, options: entry.options })
      if (typeof panel?.render !== "function") {
        throw new ExtensionError(`${spec} returned something without a render() function.`)
      }

      const side = entry.side ?? panel.side ?? "left"
      if (taken.has(side)) {
        throw new ExtensionError(
          `${spec} wants the ${side} panel, which is already taken. ` +
            `Set "side" on one of them in your config.`,
        )
      }
      taken.add(side)

      const key = entry.key ?? panel.key
      extensions.push({
        spec,
        panel,
        side,
        ...(key !== undefined ? { key } : {}),
        ...(manifest.version !== undefined ? { version: manifest.version } : {}),
      })
    } catch (error) {
      failures.push({ spec, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { extensions, failures }
}

/**
 * Extension yang terpasang di direktori Titah, tanpa memuat satu pun.
 *
 * Dibaca dari disk dan bukan dari lockfile: yang menentukan apakah panel bisa
 * dimuat adalah berkasnya, bukan catatan tentang berkasnya. Lockfile yang
 * menyebut paket yang sudah terhapus akan membuat picker mengaku "terpasang"
 * untuk sesuatu yang gagal di-import.
 *
 * Skop dibaca dua tingkat, seperti npm menaruhnya.
 */
export function installedExtensions(root: string = extensionRoot()): string[] {
  const modules = path.join(root, "node_modules")
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(modules, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    if (!entry.name.startsWith("@")) {
      found.push(entry.name)
      continue
    }
    try {
      for (const inner of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory()) found.push(`${entry.name}/${inner.name}`)
      }
    } catch {
      // Skop yang tidak bisa dibaca dilewati, bukan menggagalkan seluruh daftar.
    }
  }
  return found.sort()
}
