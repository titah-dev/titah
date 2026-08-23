import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "./paths.ts"

/**
 * Index extension terkurasi, dari `titah-dev/titah-extensions`.
 *
 * # Kenapa raw.githubusercontent dan bukan GitHub API
 *
 * GitHub API membatasi 60 request per jam PER IP tanpa auth. Di kantor dengan
 * satu IP publik, picker mati sebelum siang — dan gejalanya adalah picker yang
 * kadang kosong tanpa sebab yang terlihat. raw.githubusercontent tidak punya
 * batas praktis itu dan sudah di-cache CDN.
 *
 * # Kenapa repo terpisah
 *
 * PR "tambahkan extension saya" tidak boleh menjalankan CI Titah, menyentuh
 * siklus release-nya, atau memberi kontributor eksternal permukaan review di
 * repo inti.
 *
 * # Offline
 *
 * Cache yang usang ditampilkan dan DIKATAKAN usang. Daftar yang mungkin
 * ketinggalan lebih berguna daripada daftar kosong, selama user tahu yang mana
 * yang sedang ia lihat — daftar kosong tanpa keterangan terbaca sebagai
 * "ekosistemnya mati", yang salah.
 */

export const REGISTRY_URL =
  "https://raw.githubusercontent.com/titah-dev/titah-extensions/main/registry.json"

/** Dua puluh empat jam. Index terkurasi tidak berubah lebih cepat dari itu. */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Satu entri registry.
 *
 * `version` WAJIB, dan itu keputusan yang sama dengan `MarketEntry` di
 * `plugin.ts`: `market:git` di dua mesin harus berarti kode yang sama, dan
 * registry yang mengembalikan "paket terbaru" tidak bisa memberi jaminan itu.
 */
export interface RegistryEntry {
  id: string
  package: string
  version: string
  title?: string
  description?: string
  homepage?: string
}

export interface Registry {
  version: 1
  extension: RegistryEntry[]
}

export interface RegistrySnapshot {
  entries: RegistryEntry[]
  /** `true` kalau ini dari cache dan jaringan tidak bisa dihubungi. */
  stale: boolean
  /** Kenapa jaringan gagal, kalau gagal. Untuk kalimat di picker. */
  reason?: string
}

export function cacheFile(): string {
  return path.join(cacheDir(), "registry.json")
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.text()
}

export interface LoadRegistryOptions {
  url?: string
  file?: string
  ttlMs?: number
  fetcher?: Fetcher
  /** Jam sekarang, disuntikkan supaya test tidak bergantung pada waktu nyata. */
  now?: number
  /** Melewati cache dan memaksa jaringan. Dipakai tombol refresh di picker. */
  force?: boolean
}

/**
 * Memuat index: cache dulu kalau masih segar, jaringan kalau tidak.
 *
 * Jaringan yang gagal TIDAK mengosongkan cache. Itu perbedaan yang menentukan:
 * cache yang dibuang saat jaringan mati berarti satu penerbangan tanpa wifi
 * membuat picker kosong, dan orang menyimpulkan tidak ada extension yang ada.
 */
export async function loadRegistry(options: LoadRegistryOptions = {}): Promise<RegistrySnapshot> {
  const file = options.file ?? cacheFile()
  const ttl = options.ttlMs ?? REGISTRY_TTL_MS
  const now = options.now ?? Date.now()
  const cached = readCache(file)

  if (options.force !== true && cached && now - cached.fetchedAt < ttl) {
    return { entries: cached.entries, stale: false }
  }

  try {
    const text = await (options.fetcher ?? defaultFetcher)(options.url ?? REGISTRY_URL)
    const entries = parseRegistry(text)
    writeCache(file, { fetchedAt: now, entries })
    return { entries, stale: false }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (cached) return { entries: cached.entries, stale: true, reason }
    return { entries: [], stale: true, reason }
  }
}

/**
 * Mengurai index dan MEMBUANG entri yang tidak lengkap.
 *
 * Entri tanpa `package` atau `version` dibuang satu-satu, bukan menggagalkan
 * seluruh index: satu PR yang salah tulis tidak boleh mematikan picker untuk
 * semua orang sampai seseorang memperbaikinya.
 */
export function parseRegistry(text: string): RegistryEntry[] {
  const parsed = JSON.parse(text) as Partial<Registry>
  if (parsed.version !== 1 || !Array.isArray(parsed.extension)) {
    throw new Error("registry.json is not a version 1 registry")
  }
  return parsed.extension.filter(
    (entry): entry is RegistryEntry =>
      typeof entry?.id === "string" &&
      entry.id !== "" &&
      typeof entry.package === "string" &&
      entry.package !== "" &&
      typeof entry.version === "string" &&
      entry.version !== "",
  )
}

interface CacheShape {
  fetchedAt: number
  entries: RegistryEntry[]
}

function readCache(file: string): CacheShape | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CacheShape>
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.entries)) return undefined
    return { fetchedAt: parsed.fetchedAt, entries: parsed.entries }
  } catch {
    return undefined
  }
}

function writeCache(file: string, value: CacheShape): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value), "utf8")
  } catch {
    // Cache yang gagal ditulis tidak menggagalkan pemuatan. Index-nya sudah ada
    // di tangan; kehilangan cache hanya berarti request lagi nanti.
  }
}
