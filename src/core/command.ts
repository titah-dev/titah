import type { Config } from "./schema.ts"

/**
 * Custom command (Q26): template prompt yang dipanggil dengan `/nama <input>`.
 *
 * Placeholder mengikuti opencode (`{{.Input}}`) karena itu yang sudah ada di
 * konfigurasi orang, dengan `$ARGUMENTS` sebagai alias gaya Claude Code.
 */

/**
 * Nama command WAJIB diikuti spasi atau akhir baris.
 *
 * Tanpa itu, `/home/user/catatan.md` terbaca sebagai command `/home` — dan user
 * yang menempel path absolut ke dalam prompt akan mendapat error yang tidak
 * masuk akal alih-alih jawaban.
 *
 * Satu titik dua diizinkan untuk memisahkan namespace skill dari namanya.
 * Karena skill SELALU bernama lengkap, kehadiran `:` sudah cukup menentukan
 * bahwa ini skill — tidak ada aturan prioritas yang perlu diadili.
 */
const COMMAND = /^\/([A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?)(?:\s+([\s\S]*))?$/

export interface CommandInvocation {
  name: string
  args: string
}

export function parseCommand(text: string): CommandInvocation | undefined {
  const match = COMMAND.exec(text.trim())
  if (!match) return undefined
  return { name: match[1] as string, args: (match[2] ?? "").trim() }
}

/** Nama yang mengandung `:` adalah skill, bukan command dari config. */
export function isSkillCommand(name: string): boolean {
  return name.includes(":")
}

export function expandTemplate(template: string, args: string): string {
  return template.replaceAll("{{.Input}}", args).replaceAll("$ARGUMENTS", args)
}

export interface ResolvedCommand {
  prompt: string
  agent?: string
  model?: string
}

/** Command bawaan tidak boleh ditimpa user — mereka mengubah alur, bukan prompt. */
export const BUILTIN_COMMANDS = ["consensus", "tim", "compact", "agents", "skills", "commands"] as const

/** Ditangani sepenuhnya di TUI (mengubah keadaan klien), tidak dikirim ke server. */
export const CLIENT_COMMANDS = [
  "model",
  "skill",
  "agent",
  "session",
  "new",
  "login",
  "logout",
  "account",
] as const

/**
 * Command yang langsung DIJALANKAN saat dipilih dari menu, bukan disisipkan ke
 * prompt. Yang butuh argumen (`/consensus`, command custom) tetap disisipkan
 * supaya user bisa mengetik argumennya.
 */
export const IMMEDIATE_COMMANDS = new Set([
  "model",
  "skill",
  "agent",
  "agents",
  "skills",
  "commands",
  "session",
  "new",
  "login",
  "logout",
  "account",
])

export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number]

export function isBuiltin(name: string): name is BuiltinCommand {
  return (BUILTIN_COMMANDS as readonly string[]).includes(name)
}

export function resolveCommand(
  config: Config,
  invocation: CommandInvocation,
): ResolvedCommand | undefined {
  const command = config.command[invocation.name]
  if (!command) return undefined

  return {
    prompt: expandTemplate(command.template, invocation.args),
    ...(command.agent ? { agent: command.agent } : {}),
    ...(command.model ? { model: command.model } : {}),
  }
}

export function listCommands(config: Config): { name: string; description: string }[] {
  const builtin: { name: string; description: string }[] = [
    { name: "model", description: "Switch the model for this session" },
    { name: "agent", description: "Switch the agent for this session" },
    { name: "session", description: "Resume a previous session" },
    { name: "new", description: "Start a new session" },
    { name: "skill", description: "Insert a skill into your prompt" },
    { name: "consensus", description: "Fan one question out to every agent and compare" },
    { name: "tim", description: "Split one task across your sub-agents" },
    { name: "compact", description: "Summarise the session so far to free up context" },
    { name: "agents", description: "List internal and external agents" },
    { name: "skills", description: "List detected skills" },
    { name: "commands", description: "List these commands" },
    { name: "login", description: "Sign in to your Titah account in the browser" },
    { name: "logout", description: "Sign out this machine" },
    { name: "account", description: "Show which account this machine is signed in as" },
  ]
  const custom = Object.entries(config.command).map(([name, command]) => ({
    name,
    description: command.description ?? command.template.slice(0, 60),
  }))
  return [...builtin, ...custom]
}
