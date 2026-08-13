import type { Json } from "./config.ts"

/**
 * Config yang bisa dibawa ke mesin lain.
 *
 * # Yang diekspor adalah yang DITULIS user, bukan config yang sudah lengkap
 *
 * `LoadedConfig.config` sudah diisi seluruh nilai bawaan Zod. Mengekspornya
 * berarti membekukan bawaan hari ini ke dalam berkas: begitu Titah versi
 * berikutnya mengubah salah satunya, mesin yang mengimpor tidak akan pernah
 * ikut berubah — nilainya sekarang tertulis eksplisit, dan yang eksplisit
 * selalu menang. User tidak akan pernah tahu kenapa mesin ini berbeda.
 *
 * Jadi yang diekspor adalah `raw`: persis yang user ketik, tidak lebih.
 *
 * # Rahasia tidak ikut, dan yang tertinggal disebutkan
 *
 * Kunci API tidak pernah masuk bundel. Yang menggantikannya bukan diam
 * melainkan daftar: `secretsDropped` menyebut setiap jalur yang dibuang,
 * supaya orang yang mengimpor tahu persis apa yang harus ia isi sendiri
 * alih-alih menemukannya sebagai kegagalan saat giliran pertama.
 *
 * Referensi `${env:NAMA}` justru DIPERTAHANKAN. Ia bukan rahasia, ia petunjuk
 * ke rahasia — dan itulah bentuk yang memang dimaksudkan untuk dibagikan.
 */

export const BUNDLE_VERSION = 1

export interface Bundle {
  titah: string
  bundleVersion: number
  exportedAt: string
  config: Json
  /** Jalur kunci yang dibuang karena berisi rahasia literal. */
  secretsDropped: string[]
}

export class BundleError extends Error {}

function isPlainObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Nama header yang isinya diperlakukan sebagai rahasia. */
const SECRET_HEADER = /auth|key|token|secret|cookie/i

/** Apakah nilai ini sebuah rujukan environment, bukan rahasianya sendiri? */
function isEnvReference(value: Json): boolean {
  return typeof value === "string" && /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())
}

/**
 * Membuang rahasia literal dari config mentah, sambil mencatat jalurnya.
 *
 * Berjalan atas `raw`, jadi ia melihat persis bentuk yang user tulis —
 * termasuk provider yang tidak dikenal skema. Pendekatan berbasis bentuk
 * (`provider.<apa pun>.options.apiKey`) menangkap itu; pendekatan yang
 * mengiterasi skema tidak.
 */
export function stripSecrets(raw: Json, dropped: string[] = [], at = ""): Json {
  if (Array.isArray(raw)) return raw.map((item, index) => stripSecrets(item, dropped, `${at}[${index}]`))
  if (!isPlainObject(raw)) return raw

  const out: Record<string, Json> = {}
  for (const [key, value] of Object.entries(raw)) {
    const path = at === "" ? key : `${at}.${key}`

    if (key === "apiKey" && !isEnvReference(value)) {
      dropped.push(path)
      continue
    }

    if (key === "headers" && isPlainObject(value)) {
      const headers: Record<string, Json> = {}
      for (const [name, content] of Object.entries(value)) {
        if (SECRET_HEADER.test(name) && !isEnvReference(content)) {
          dropped.push(`${path}.${name}`)
          continue
        }
        headers[name] = content
      }
      out[key] = headers
      continue
    }

    out[key] = stripSecrets(value, dropped, path)
  }
  return out
}

export function exportBundle(raw: Json, version: string, now: Date): Bundle {
  const dropped: string[] = []
  const config = stripSecrets(raw, dropped)
  return {
    titah: version,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    config,
    secretsDropped: dropped.sort(),
  }
}

/**
 * Memeriksa bundel yang masuk sebelum satu byte pun ditulis.
 *
 * Berkas yang dibuat orang lain adalah masukan yang tidak dipercaya, dan yang
 * paling mungkin terjadi bukan serangan melainkan kekeliruan: berkas config
 * biasa yang dikira bundel, bundel dari versi yang jauh lebih baru, JSON yang
 * bukan objek sama sekali. Ketiganya harus menghasilkan kalimat yang memberi
 * tahu apa yang salah, bukan `undefined is not an object` beberapa baris
 * kemudian.
 */
export function parseBundle(text: string): Bundle {
  let data: Json
  try {
    data = JSON.parse(text) as Json
  } catch (error) {
    throw new BundleError(`Not valid JSON: ${(error as Error).message}`)
  }

  if (!isPlainObject(data)) throw new BundleError("A bundle must be a JSON object.")

  if (!("config" in data)) {
    throw new BundleError(
      'No "config" field. This looks like a plain titah.json rather than a bundle — ' +
        "produce one with `titah export` on the machine you are copying from.",
    )
  }

  const bundleVersion = typeof data["bundleVersion"] === "number" ? data["bundleVersion"] : 0
  if (bundleVersion > BUNDLE_VERSION) {
    throw new BundleError(
      `This bundle is version ${bundleVersion}; this Titah understands up to ${BUNDLE_VERSION}. ` +
        "Upgrade Titah before importing it — a newer bundle may mean things this version " +
        "would silently ignore.",
    )
  }

  if (!isPlainObject(data["config"])) throw new BundleError('"config" must be an object.')

  return {
    titah: typeof data["titah"] === "string" ? data["titah"] : "(unknown)",
    bundleVersion,
    exportedAt: typeof data["exportedAt"] === "string" ? data["exportedAt"] : "(unknown)",
    config: data["config"],
    secretsDropped: Array.isArray(data["secretsDropped"])
      ? data["secretsDropped"].filter((item): item is string => typeof item === "string")
      : [],
  }
}

export interface Change {
  path: string
  before: Json | undefined
  after: Json
}

/**
 * Perubahan yang akan terjadi, dihitung SEBELUM apa pun ditulis.
 *
 * Impor yang langsung menimpa adalah impor yang tidak bisa dipertimbangkan.
 * Daftar ini yang ditampilkan lebih dulu, dan hanya kunci yang benar-benar
 * BERUBAH nilainya yang masuk — mencantumkan kunci yang isinya sudah sama
 * membuat daftar panjang yang di dalamnya perubahan sungguhan jadi sulit
 * ditemukan.
 */
export function planImport(current: Json, incoming: Json, at = ""): Change[] {
  const changes: Change[] = []
  if (!isPlainObject(incoming)) return changes

  for (const [key, value] of Object.entries(incoming)) {
    const path = at === "" ? key : `${at}.${key}`
    const existing: Json | undefined = isPlainObject(current) ? current[key] : undefined

    if (isPlainObject(value) && existing !== undefined && isPlainObject(existing)) {
      changes.push(...planImport(existing, value, path))
      continue
    }
    if (JSON.stringify(existing) === JSON.stringify(value)) continue
    changes.push({ path, before: existing, after: value })
  }
  return changes
}

/**
 * Menggabungkan bundel ke config yang sudah ada.
 *
 * Bundel MENANG per kunci daun, tapi tidak menghapus apa pun yang tidak ia
 * sebut. Impor yang mengganti seluruh berkas akan membuang kredensial dan
 * penyetelan lokal yang justru sengaja tidak ikut diekspor — orang akan
 * kehilangan `apiKey`-nya sendiri karena memasang config dari rekan kerja.
 */
export function mergeConfig(current: Json, incoming: Json): Json {
  if (!isPlainObject(current) || !isPlainObject(incoming)) return incoming
  const out: Record<string, Json> = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    const existing = out[key]
    out[key] = existing === undefined ? value : mergeConfig(existing, value)
  }
  return out
}
