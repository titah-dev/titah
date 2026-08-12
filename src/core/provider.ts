import type { LanguageModel } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { Config, Provider } from "./schema.ts"
import { readAuth } from "./auth.ts"

export class ProviderError extends Error {}

/** Nama env var konvensional untuk provider yang tidak punya konvensi sendiri. */
function fallbackEnvName(providerId: string): string {
  return `TITAH_${providerId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`
}

function wellKnownEnvName(provider: Provider): string | undefined {
  if (provider.npm === "@ai-sdk/anthropic") return "ANTHROPIC_API_KEY"
  return undefined
}

export interface CredentialResult {
  key?: string
  /** Dari mana kunci diambil — dipakai `titah auth list` dan `titah doctor`. */
  source: "config" | "auth.json" | "env" | "none"
}

/**
 * Urutan resolusi kredensial, dari prioritas tertinggi:
 *   1. `provider.options.apiKey` di config (setelah interpolasi `${env:...}`)
 *   2. `auth.json`
 *   3. env var konvensional (ANTHROPIC_API_KEY, atau TITAH_<ID>_API_KEY)
 */
export function resolveCredential(providerId: string, provider: Provider): CredentialResult {
  const fromConfig = provider.options?.apiKey
  if (fromConfig) return { key: fromConfig, source: "config" }

  const fromAuth = readAuth()[providerId]
  if (fromAuth?.key) return { key: fromAuth.key, source: "auth.json" }

  const envNames = [wellKnownEnvName(provider), fallbackEnvName(providerId)].filter(
    (name): name is string => name !== undefined,
  )
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return { key: value, source: "env" }
  }

  return { source: "none" }
}

export interface ParsedModelId {
  providerId: string
  modelId: string
}

/**
 * `"9router/cx/gpt-5.4"` → `{ providerId: "9router", modelId: "cx/gpt-5.4" }`.
 * Dipisah pada slash PERTAMA saja, karena id model sering mengandung slash.
 */
export function parseModelId(full: string): ParsedModelId {
  const slash = full.indexOf("/")
  if (slash <= 0 || slash === full.length - 1) {
    throw new ProviderError(
      `Model "${full}" is not in "provider/model" form. Example: "9router/cx/gpt-5.4".`,
    )
  }
  return { providerId: full.slice(0, slash), modelId: full.slice(slash + 1) }
}

export function resolveModel(config: Config, full?: string): LanguageModel {
  const target = full ?? config.model
  if (!target) {
    throw new ProviderError(
      "No default model. Set `model` in titah.json or pass --model.\n" +
        "Titah deliberately does not guess a model.",
    )
  }

  const { providerId, modelId } = parseModelId(target)
  const provider = config.provider[providerId]
  if (!provider) {
    const known = Object.keys(config.provider)
    throw new ProviderError(
      `Unknown provider "${providerId}".` +
        (known.length ? ` Available: ${known.join(", ")}.` : " No providers configured yet."),
    )
  }

  const credential = resolveCredential(providerId, provider)
  const baseURL = provider.options?.baseURL
  const headers = provider.options?.headers

  switch (provider.npm) {
    case "@ai-sdk/anthropic": {
      if (!credential.key) {
        throw new ProviderError(
          `Provider "${providerId}" needs an API key. Run: titah auth set ${providerId}`,
        )
      }
      const anthropic = createAnthropic({
        apiKey: credential.key,
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      })
      return anthropic(modelId)
    }

    case "@ai-sdk/openai-compatible": {
      if (!baseURL) {
        throw new ProviderError(
          `Provider "${providerId}" is openai-compatible but has no options.baseURL.`,
        )
      }
      // Endpoint lokal (ollama, LM Studio) sering tidak butuh kunci sama sekali,
      // jadi apiKey yang kosong bukan error di sini.
      const compatible = createOpenAICompatible({
        name: providerId,
        baseURL,
        // Tanpa ini, endpoint OpenAI-compatible tidak melaporkan token saat
        // streaming, dan penghitung biaya di footer (Q24) selalu kosong.
        includeUsage: provider.options?.includeUsage ?? true,
        ...(credential.key ? { apiKey: credential.key } : {}),
        ...(headers ? { headers } : {}),
      })
      return compatible(modelId)
    }
  }
}

export interface ModelListing {
  id: string
  providerId: string
  modelId: string
  displayName?: string
  credential: CredentialResult["source"]
  isDefault: boolean
}

export function listModels(config: Config): ModelListing[] {
  const out: ModelListing[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    const credential = resolveCredential(providerId, provider).source
    for (const [modelId, model] of Object.entries(provider.models)) {
      const id = `${providerId}/${modelId}`
      out.push({
        id,
        providerId,
        modelId,
        ...(model.name ? { displayName: model.name } : {}),
        credential,
        isDefault: id === config.model,
      })
    }
  }
  return out
}

/**
 * Jendela konteks sebuah model, kalau config menyatakannya.
 *
 * TIDAK ADA tabel bawaan. Angka yang salah lebih berbahaya daripada tidak ada
 * angka: pemadatan yang terlambat tidak bisa dibedakan dari tidak ada pemadatan
 * — sesinya tetap mati, hanya saja user sudah telanjur mengira aman.
 *
 * Tidak pernah melempar: ini dipanggil di jalur panas tiap langkah, dan
 * metadata yang hilang tidak boleh menjatuhkan giliran yang sedang berjalan.
 */
export function contextWindowFor(config: Config, full?: string): number | undefined {
  const target = full ?? config.model
  if (target === undefined) return undefined
  const slash = target.indexOf("/")
  if (slash <= 0 || slash === target.length - 1) return undefined
  const providerId = target.slice(0, slash)
  const modelId = target.slice(slash + 1)
  return config.provider[providerId]?.models[modelId]?.contextWindow
}

/**
 * Jendela yang membatasi prompt PERINGKAS.
 *
 * Peringkas ditulis `smallModel` kalau ada, jadi jendelanya yang berlaku — bukan
 * jendela model giliran. Ini yang membuat prompt peringkas bisa dibatasi sama
 * sekali: sebelumnya tidak ada satu pun pemanggil `contextWindowFor` untuk
 * `smallModel`, dan promptnya terukur 19,3x jendela yang ia nyatakan sendiri.
 *
 * Urutannya: jendela `smallModel`, lalu jendela model giliran. Yang kedua bukan
 * tebakan — kalau `smallModel` tidak disetel, model giliran SENDIRI yang
 * meringkas, dan angkanya toh sudah wajib ada agar pemadatan otomatis hidup.
 * `smallModel` yang disetel tapi jendelanya belum dideklarasikan juga mendarat di
 * sini, dan itu yang dilaporkan `smallModelWindowMissing` ke `doctor` — perilaku
 * yang aman, tapi bukan yang user maksud.
 *
 * `undefined` kalau TIDAK ADA yang dideklarasikan, bukan `0`. Nol terlihat seperti
 * angka dan ikut terhitung: ia melewati aritmetika anggaran menjadi negatif, lalu
 * dijinakkan lantai jadi potongan terkecil yang mungkin — ~400 panggilan
 * smallModel untuk transkrip 200 KB. `undefined` berarti "tidak diketahui", dan
 * pemanggilnya memperlakukannya sebagai "jangan potong".
 */
export function summariserWindowFor(config: Config, turnModel?: string): number | undefined {
  const small = config.smallModel ? contextWindowFor(config, config.smallModel) : undefined
  return small ?? contextWindowFor(config, turnModel)
}

/**
 * `smallModel` yang disetel tapi jendelanya belum dideklarasikan.
 *
 * Batas prompt peringkas tidak bisa ditegakkan pada angka yang tidak ada, jadi
 * ia jatuh ke jendela model giliran — lebih longgar dari yang user maksud, dan
 * satu-satunya cara ia bisa tahu adalah kalau ada yang menyebutkannya.
 */
export function smallModelWindowMissing(config: Config): string | undefined {
  const small = config.smallModel
  if (small === undefined) return undefined
  return contextWindowFor(config, small) === undefined ? small : undefined
}

/** Model yang dikonfigurasi tapi belum punya `contextWindow`, untuk dilaporkan `doctor`. */
export function undeclaredContextWindows(config: Config): string[] {
  const out: string[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.contextWindow === undefined) out.push(`${providerId}/${modelId}`)
    }
  }
  return out
}
