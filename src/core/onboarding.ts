import fs from "node:fs"
import path from "node:path"
import { globalConfigFile } from "./paths.ts"
import { setCredential } from "./auth.ts"
import type { Config } from "./schema.ts"

/**
 * Onboarding (Q27): deteksi env var dulu, wizard hanya kalau tidak ketemu.
 *
 * Menyuruh user menulis blok `provider` dengan `npm`, `baseURL`, dan peta
 * `models` dari nol adalah tembok yang membuat orang menyerah di menit pertama —
 * tapi kalau kuncinya sudah ada di environment, bertanya juga membuang waktu.
 */

export interface DetectedProvider {
  /** Id yang akan dipakai di config. */
  id: string
  label: string
  npm: "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible"
  baseURL?: string
  /** Env var yang menyimpan kuncinya, kalau terdeteksi dari environment. */
  envVar?: string
  models: string[]
  defaultModel: string
}

/** Preset yang bisa ditebak dari environment tanpa bertanya apa pun. */
const ENV_PRESETS: (DetectedProvider & { envVar: string })[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    npm: "@ai-sdk/anthropic",
    envVar: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    models: ["gpt-4.1", "gpt-4.1-mini"],
    defaultModel: "gpt-4.1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-sonnet-4.5"],
    defaultModel: "anthropic/claude-sonnet-4.5",
  },
]

/** Endpoint lokal yang lazim; dicek dengan koneksi, bukan ditebak. */
export const LOCAL_CANDIDATES = [
  { id: "ollama", label: "Local Ollama", baseURL: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "Local LM Studio", baseURL: "http://localhost:1234/v1" },
]

export function detectFromEnv(env: NodeJS.ProcessEnv = process.env): DetectedProvider[] {
  return ENV_PRESETS.filter((preset) => {
    const value = env[preset.envVar]
    return typeof value === "string" && value.trim() !== ""
  })
}

export interface ProbeResult {
  id: string
  label: string
  baseURL: string
  models: string[]
}

/** Menanyakan /models ke endpoint lokal. Yang mati dilewati tanpa suara. */
export async function probeLocal(timeoutMs = 1500): Promise<ProbeResult[]> {
  const found: ProbeResult[] = []

  await Promise.all(
    LOCAL_CANDIDATES.map(async (candidate) => {
      try {
        const response = await fetch(`${candidate.baseURL}/models`, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return
        const body: unknown = await response.json()
        const data =
          body !== null && typeof body === "object" && "data" in body
            ? (body as { data: unknown }).data
            : undefined
        const models = Array.isArray(data)
          ? data
              .map((item) =>
                item !== null && typeof item === "object" && "id" in item
                  ? String((item as { id: unknown }).id)
                  : undefined,
              )
              .filter((id): id is string => id !== undefined)
          : []
        if (models.length > 0) found.push({ ...candidate, models })
      } catch {
        // endpoint mati — bukan error, cuma tidak ada
      }
    }),
  )

  return found.sort((a, b) => a.id.localeCompare(b.id))
}

export interface ProviderChoice {
  id: string
  label: string
  npm: "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible"
  baseURL?: string
  envVar?: string
  model: string
  models: string[]
  /** Kunci yang diketik user. Ditulis ke auth.json, TIDAK ke config. */
  apiKey?: string
}

/**
 * Menyusun config dari pilihan onboarding.
 *
 * Kunci sengaja TIDAK pernah masuk objek ini — ia ditulis terpisah ke auth.json
 * (Q19). Config adalah file yang orang tempel ke issue GitHub.
 */
export function buildConfig(choice: ProviderChoice, schemaPath?: string): Partial<Config> {
  const models: Record<string, { name?: string }> = {}
  for (const model of choice.models) models[model] = {}
  if (models[choice.model] === undefined) models[choice.model] = {}

  return {
    ...(schemaPath ? { $schema: schemaPath } : {}),
    model: `${choice.id}/${choice.model}`,
    provider: {
      [choice.id]: {
        name: choice.label,
        npm: choice.npm,
        models,
        ...(choice.baseURL || choice.envVar
          ? {
              options: {
                ...(choice.baseURL ? { baseURL: choice.baseURL } : {}),
                // Kunci dari environment direferensikan, bukan disalin.
                ...(choice.envVar ? { apiKey: `\${env:${choice.envVar}}` } : {}),
                includeUsage: true,
              },
            }
          : {}),
      },
    },
  } as Partial<Config>
}

export interface WriteResult {
  configFile: string
  wroteCredential: boolean
}

/** Menulis config global. Menolak menimpa config yang sudah ada. */
export function writeOnboarding(choice: ProviderChoice, schemaPath?: string): WriteResult {
  const file = globalConfigFile()
  if (fs.existsSync(file)) {
    throw new Error(
      `Config already exists at ${file}. Onboarding never overwrites an existing config — ` +
        "edit that file directly, or delete it first.",
    )
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(buildConfig(choice, schemaPath), null, 2)}\n`)

  const key = choice.apiKey?.trim()
  if (key) setCredential(choice.id, key)

  return { configFile: file, wroteCredential: Boolean(key) }
}

/** Apakah Titah sudah siap dipakai tanpa bertanya apa pun? */
export function isConfigured(config: Config): boolean {
  return config.model !== undefined && Object.keys(config.provider).length > 0
}
