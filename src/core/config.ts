import fs from "node:fs"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Agent, Config, ExternalAgent, DEFAULT_AGENTS, DEFAULT_EXTERNAL_AGENTS } from "./schema.ts"
import { globalConfigFile, projectConfigFile } from "./paths.ts"
import { setExternalRoots } from "./tool/types.ts"

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: Config
  /** File yang benar-benar terbaca, urut dari prioritas terendah. */
  sources: string[]
  /** Variabel `${env:...}` yang direferensikan config tapi tidak ada di environment. */
  missingEnv: { variable: string; at: string }[]
  /**
   * Hasil merge MENTAH, sebelum default Zod diterapkan.
   *
   * `config` tidak bisa menjawab "apakah user MENULIS angka ini" — setelah
   * parse, nilai bawaan dan nilai yang diketik user terlihat persis sama. Itu
   * cukup untuk menjalankan program, tapi tidak cukup untuk berbicara kepada
   * user: menegur seseorang tentang angka yang tidak pernah ia tulis hanya
   * mengajarkan bahwa Titah tidak menyetujui bawaannya sendiri.
   */
  raw: Json
}

/**
 * Apakah sebuah kunci config SUNGGUH ada di berkas user — lihat `raw`.
 */
export function isExplicit(loaded: LoadedConfig, keys: string[]): boolean {
  let node: Json = loaded.raw
  for (const key of keys) {
    if (!isPlainObject(node)) return false
    if (!(key in node)) return false
    node = node[key] as Json
  }
  return true
}

const ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Mengganti `${env:NAMA}` di seluruh nilai string.
 *
 * Variabel yang tidak ada TIDAK melempar error di sini: config bisa menyebut
 * lima provider sementara kamu hanya memakai satu. Kunci yang gagal di-resolve
 * dibuang dan dicatat, lalu provider.ts yang mengeluh — tapi hanya kalau model
 * yang kamu pakai memang butuh kunci itu.
 */
function interpolate(value: Json, missing: LoadedConfig["missingEnv"], at: string): Json | undefined {
  if (typeof value === "string") {
    let unresolved = false
    const out = value.replace(ENV_PATTERN, (_match, name: string) => {
      const fromEnv = process.env[name]
      if (fromEnv === undefined) {
        missing.push({ variable: name, at })
        unresolved = true
        return ""
      }
      return fromEnv
    })
    return unresolved ? undefined : out
  }

  if (Array.isArray(value)) {
    return value
      .map((item, i) => interpolate(item, missing, `${at}[${i}]`))
      .filter((item): item is Json => item !== undefined)
  }

  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = interpolate(item, missing, at === "" ? key : `${at}.${key}`)
      if (resolved !== undefined) out[key] = resolved
    }
    return out
  }

  return value
}

function isPlainObject(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Merge dalam: objek digabung rekursif, array diganti utuh. */
function merge(base: Json, overlay: Json): Json {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay
  const out: Record<string, Json> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key]
    out[key] = existing === undefined ? value : merge(existing, value)
  }
  return out
}

function readJsonc(file: string): Json {
  const text = fs.readFileSync(file, "utf8")
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as Json
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ")
    throw new ConfigError(`Invalid config: ${file}\n  ${detail}`)
  }
  return parsed ?? {}
}

export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const candidates = [globalConfigFile(), projectConfigFile(cwd)]
  const sources: string[] = []
  let raw: Json = {}

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    raw = merge(raw, readJsonc(file))
    sources.push(file)
  }

  const missingEnv: LoadedConfig["missingEnv"] = []
  const interpolated = interpolate(raw, missingEnv, "") ?? {}

  const parsed = Config.safeParse(interpolated)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new ConfigError(
      `Config failed validation${sources.length ? ` (${sources.join(", ")})` : ""}:\n${detail}`,
    )
  }

  const config = parsed.data

  // Registry agent eksternal punya default bawaan, tapi config user menang.
  for (const [id, preset] of Object.entries(DEFAULT_EXTERNAL_AGENTS)) {
    if (config.externalAgent[id] === undefined) {
      config.externalAgent[id] = ExternalAgent.parse(preset)
    }
  }

  // Tiga mode bawaan: plan / build / build-auto. Sama seperti di atas, id yang
  // sudah didefinisikan user tidak disentuh.
  for (const [id, preset] of Object.entries(DEFAULT_AGENTS)) {
    if (config.agent[id] === undefined) config.agent[id] = Agent.parse(preset)
  }

  // Tanpa ini, sesi dimulai "tanpa agent" — perilakunya identik dengan `build`
  // tapi namanya tidak muncul di mana pun, dan user tidak tahu ia sedang di mode apa.
  if (config.defaultAgent === undefined && config.agent["build"] !== undefined) {
    config.defaultAgent = "build"
  }

  /*
   * Akar tambahan dipasang SEKALI, di sini, dari aturan `external_directory`
   * yang berbunyi "allow". Hanya `allow` — `ask` tidak bisa dipenuhi oleh
   * `resolveInside` yang sinkron, dan menganggapnya `allow` akan membuka lebih
   * dari yang user tulis.
   */
  setExternalRoots(
    Object.entries(config.permission.rules)
      .filter(([source, policy]) => policy === "allow" && source.startsWith("external_directory("))
      .map(([source]) => source.slice("external_directory(".length, -1)),
  )

  return { config, sources, missingEnv, raw }
}

/** Menyembunyikan kredensial sebelum config dicetak ke layar atau log. */
export function redact(config: Config): Config {
  const clone = structuredClone(config)
  for (const provider of Object.values(clone.provider)) {
    if (provider.options?.apiKey) provider.options.apiKey = "***"
    if (provider.options?.headers) {
      for (const key of Object.keys(provider.options.headers)) {
        if (/auth|key|token|secret/i.test(key)) provider.options.headers[key] = "***"
      }
    }
  }
  return clone
}
