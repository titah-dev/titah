import fs from "node:fs"
import path from "node:path"
import type { Config } from "../core/schema.ts"
import type { Session } from "../core/message.ts"
import { listCommands } from "../core/command.ts"
import { listAgents } from "../core/delegate/index.ts"
import { discoverSkills } from "../core/skill.ts"

/**
 * Autocomplete di dalam prompt.
 *
 * Pemicunya harus berada di AWAL kata, bukan di tengah — supaya alamat email
 * (`akil@gmail.com`) dan path absolut (`/etc/hosts`) tidak memunculkan popup
 * yang tidak diminta siapa pun.
 */

export type SuggestionKind =
  | "agent"
  | "external-agent"
  | "file"
  | "command"
  | "skill"
  | "model"
  | "pick-agent"
  | "session"

export interface Suggestion {
  kind: SuggestionKind
  /** Teks yang menggantikan token saat dipilih. */
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

export interface Trigger {
  /** Karakter pemicu: `@`, `/`, atau kosong untuk daftar penuh. */
  char: "@" | "/"
  /** Indeks karakter pemicu di dalam draft. */
  start: number
  /** Yang sudah diketik setelah pemicu. */
  query: string
}

const MAX_FILES = 200

/**
 * Menemukan pemicu autocomplete tepat sebelum kursor.
 *
 * `/` hanya berlaku di awal prompt: `/review` adalah command, tapi
 * `lihat /etc/hosts` bukan.
 */
export function detectTrigger(draft: string, cursor: number): Trigger | undefined {
  const before = draft.slice(0, cursor)
  const lineStart = before.lastIndexOf("\n") + 1

  for (let i = cursor - 1; i >= lineStart; i -= 1) {
    const char = before[i] as string
    if (char === " " || char === "\t") return undefined

    if (char === "@" || char === "/") {
      const prev = i === lineStart ? "" : (before[i - 1] as string)
      const atWordStart = i === lineStart || prev === " " || prev === "\t"
      if (!atWordStart) return undefined
      if (char === "/" && i !== 0) return undefined
      return { char, start: i, query: before.slice(i + 1) }
    }
  }
  return undefined
}

function matches(query: string, candidate: string): boolean {
  return candidate.toLowerCase().includes(query.toLowerCase())
}

/** File di dalam cwd, sudah menyaring direktori build. */
export function listFiles(cwd: string, limit = MAX_FILES): string[] {
  const skip = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv"])
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) out.push(path.relative(cwd, full))
    }
  }

  walk(cwd, 0)
  return out.sort()
}

export interface SuggestOptions {
  config: Config
  cwd: string
  trigger: Trigger
  /** Disuntikkan test supaya tidak menyentuh filesystem sungguhan. */
  files?: string[]
}

export function suggest(options: SuggestOptions): Suggestion[] {
  const { config, trigger } = options
  const query = trigger.query

  if (trigger.char === "/") {
    const commands: Suggestion[] = listCommands(config)
      .filter((entry) => matches(query, entry.name))
      .map((entry) => ({
        kind: "command" as const,
        value: `/${entry.name} `,
        label: `/${entry.name}`,
        detail: entry.description,
      }))

    // Skill dipanggil lewat `/namespace:nama` persis seperti command, jadi ia
    // harus ada di daftar yang sama. Kalau tidak, mengetik `/superpowers:apa`
    // menghasilkan daftar KOSONG untuk sesuatu yang sebenarnya bisa dijalankan.
    // Command lebih dulu: jumlahnya belasan dan hafal di kepala user, sementara
    // skill puluhan dan justru dicari lewat pengetikan.
    return [...commands, ...skillSuggestions(config, options.cwd, query)]
  }

  // `@` menggabungkan agent dan file dalam satu daftar: keduanya adalah "yang
  // kamu tunjuk", dan memisahkannya berarti user harus hafal dua tombol.
  const agents: Suggestion[] = Object.entries(config.agent)
    .filter(([id]) => matches(query, id))
    .map(([id, agent]) => ({
      kind: "agent" as const,
      value: `@${id} `,
      label: `@${id}`,
      ...(agent.description ? { detail: agent.description } : {}),
    }))

  const external: Suggestion[] = listAgents(config)
    .filter((agent) => matches(query, agent.id))
    .map((agent) => ({
      kind: "external-agent" as const,
      value: `@${agent.id} `,
      label: `@${agent.id}`,
      detail: agent.available ? "delegate to this agent" : `unavailable (${agent.command})`,
      disabled: !agent.available,
    }))

  const files: Suggestion[] = (options.files ?? listFiles(options.cwd))
    .filter((file) => matches(query, file))
    .slice(0, 30)
    .map((file) => ({ kind: "file" as const, value: `@${file} `, label: `@${file}` }))

  return [...external, ...agents, ...files]
}

export function skillSuggestions(config: Config, cwd: string, query = ""): Suggestion[] {
  return discoverSkills(config, cwd)
    // Saring lewat id lengkap (`namespace:name`), bukan `name` — supaya
    // mengetik "superpowers:" mempersempit ke plugin itu saja.
    .filter((skill) => matches(query, skill.id))
    .map((skill) => ({
      kind: "skill" as const,
      // Yang disisipkan adalah COMMAND-nya. Kalimat "Use the X skill" harus
      // ditafsirkan model dan bisa diabaikan; command selalu dijalankan.
      value: `/${skill.id} `,
      label: `/${skill.id}`,
      detail: skill.description,
    }))
}

export function modelSuggestions(config: Config, query = ""): Suggestion[] {
  const out: Suggestion[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const id = `${providerId}/${modelId}`
      if (!matches(query, id)) continue
      out.push({
        kind: "model",
        value: id,
        label: id,
        ...(model.name ? { detail: model.name } : {}),
      })
    }
  }
  return out
}

/** Mengganti token pemicu dengan pilihan, mengembalikan draft dan posisi kursor baru. */
export function applySuggestion(
  draft: string,
  trigger: Trigger,
  cursor: number,
  suggestion: Suggestion,
): { draft: string; cursor: number } {
  const head = draft.slice(0, trigger.start)
  const tail = draft.slice(cursor)
  return { draft: head + suggestion.value + tail, cursor: head.length + suggestion.value.length }
}

/** Daftar agent internal untuk pemilih mode (Ctrl+P → /agent). */
export function agentPickerItems(
  config: Config,
  agentIds: (string | undefined)[],
): Suggestion[] {
  return agentIds.map((id) => ({
    kind: "pick-agent" as const,
    value: id ?? "",
    label: id ?? "(no agent)",
    ...(id && config.agent[id]?.description ? { detail: config.agent[id].description } : {}),
  }))
}

/** Daftar sesi tersimpan, terbaru lebih dulu. */
export function sessionSuggestions(sessions: Session[], current?: string): Suggestion[] {
  return sessions.map((session) => {
    const when = new Date(session.updated).toISOString().slice(0, 16).replace("T", " ")
    return {
      kind: "session" as const,
      value: session.id,
      label: session.title || "(untitled)",
      detail: `${when}${session.id === current ? " · current" : ""}`,
    }
  })
}
