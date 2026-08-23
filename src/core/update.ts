import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "./paths.ts"
import { satisfiesEngine } from "../extension.ts"

/**
 * Memberi tahu kalau ada versi Titah yang lebih baru. TIDAK memasangnya.
 *
 * # Kenapa tidak auto-update
 *
 * Yang akan di-update adalah proses yang memegang `auth.json` (mode 0600),
 * menjalankan bash, dan menyunting berkas. Memasang sendiri tanpa bertanya
 * berarti eksekusi kode arbitrer setiap kali ada `npm publish` — termasuk
 * publish dari akun npm yang diambil alih orang.
 *
 * Ada juga ironi yang lebih kecil tapi nyata: lockfile extension ada supaya
 * panel tidak berubah diam-diam di bawah user. Host-nya yang berubah diam-diam
 * membatalkan seluruh maksud itu, dan tidak ada lockfile untuk host.
 *
 * Yang benar-benar diinginkan orang bukan pemasangan otomatis — itu hanya
 * cara yang terpikir lebih dulu. Yang diinginkan adalah TAHU, tanpa harus
 * ingat untuk memeriksa. Itu satu request HTTP dan satu baris di footer.
 */

export const NPM_LATEST_URL = "https://registry.npmjs.org/titah-code/latest"

/**
 * Enam jam.
 *
 * Bukan sekali per sesi: orang yang membiarkan Titah terbuka sepanjang hari
 * tidak akan pernah diberi tahu. Bukan setiap start juga: orang yang membuka
 * Titah lima kali dalam sepuluh menit tidak butuh lima request.
 */
export const UPDATE_TTL_MS = 6 * 60 * 60 * 1000

export interface UpdateStatus {
  current: string
  latest?: string
  /** `true` hanya kalau `latest` sungguh lebih baru dari `current`. */
  newer: boolean
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.text()
}

export interface CheckOptions {
  current: string
  url?: string
  file?: string
  ttlMs?: number
  fetcher?: Fetcher
  now?: number
}

export function cacheFile(): string {
  return path.join(cacheDir(), "update.json")
}

/**
 * Memeriksa versi terbaru, lewat cache.
 *
 * Kegagalan jaringan mengembalikan `newer: false` dan TIDAK melaporkan apa pun.
 * Ini satu-satunya tempat di Titah di mana kegagalan sengaja disembunyikan, dan
 * alasannya spesifik: user tidak meminta pemeriksaan ini, jadi memberitahunya
 * bahwa pemeriksaan yang tidak ia minta gagal adalah gangguan tanpa tindakan
 * yang bisa ia ambil.
 */
export async function checkUpdate(options: CheckOptions): Promise<UpdateStatus> {
  const file = options.file ?? cacheFile()
  const ttl = options.ttlMs ?? UPDATE_TTL_MS
  const now = options.now ?? Date.now()

  const cached = readCache(file)
  if (cached && now - cached.checkedAt < ttl) return verdict(options.current, cached.latest)

  try {
    const text = await (options.fetcher ?? defaultFetcher)(options.url ?? NPM_LATEST_URL)
    const parsed = JSON.parse(text) as { version?: unknown }
    if (typeof parsed.version !== "string") throw new Error("npm returned no version")
    writeCache(file, { checkedAt: now, latest: parsed.version })
    return verdict(options.current, parsed.version)
  } catch {
    // Cache lama tetap dipakai kalau ada: versi yang diketahui kemarin lebih
    // berguna daripada tidak tahu apa pun, dan ia tidak jadi salah karena hari
    // ini jaringannya mati.
    if (cached) return verdict(options.current, cached.latest)
    return { current: options.current, newer: false }
  }
}

/**
 * Kalimat untuk footer, atau `undefined` kalau tidak ada yang perlu dikatakan.
 *
 * Menyebut perintahnya, bukan hanya faktanya. "0.3.0 available" menyuruh orang
 * mengingat cara memasangnya; menyebut `titah upgrade` membuat baris itu
 * lengkap sendiri.
 */
export function updateNotice(status: UpdateStatus): string | undefined {
  if (!status.newer || status.latest === undefined) return undefined
  return `${status.latest} available — run titah upgrade`
}

/**
 * Membandingkan versi.
 *
 * `satisfiesEngine(latest, ">=current")` yang dipakai, bukan perbandingan
 * string: `"0.10.0" > "0.9.0"` bernilai false secara leksikografis, dan itu
 * membuat update paling penting — yang menyeberangi angka dua digit — jadi
 * satu-satunya yang tidak pernah dilaporkan.
 */
function verdict(current: string, latest: string): UpdateStatus {
  if (latest === current) return { current, latest, newer: false }
  const newer = satisfiesEngine(latest, `>=${current}`)
  return { current, latest, newer }
}

interface CacheShape {
  checkedAt: number
  latest: string
}

function readCache(file: string): CacheShape | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CacheShape>
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return undefined
    return { checkedAt: parsed.checkedAt, latest: parsed.latest }
  } catch {
    return undefined
  }
}

function writeCache(file: string, value: CacheShape): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value), "utf8")
  } catch {
    // Tidak bisa menulis cache berarti memeriksa lagi nanti, bukan gagal.
  }
}
