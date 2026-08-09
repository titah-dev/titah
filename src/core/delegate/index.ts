import type { Config } from "../schema.ts"
import { createSubprocessAdapter } from "./subprocess.ts"
import type { DelegateAdapter } from "./types.ts"

export * from "./types.ts"
export { createSubprocessAdapter } from "./subprocess.ts"

/** Membangun seluruh adapter dari config, termasuk yang CLI-nya tidak terpasang. */
export function buildAdapters(config: Config): Map<string, DelegateAdapter> {
  const adapters = new Map<string, DelegateAdapter>()
  for (const [id, agent] of Object.entries(config.externalAgent)) {
    adapters.set(id, createSubprocessAdapter(id, agent))
  }
  return adapters
}

export function adapterFor(config: Config, id: string): DelegateAdapter | undefined {
  const agent = config.externalAgent[id]
  return agent ? createSubprocessAdapter(id, agent) : undefined
}

/**
 * Agent yang tidak terpasang tetap DIDAFTARKAN, bukan disembunyikan (Q24) —
 * user perlu tahu opsi itu ada dan cara memasangnya.
 */
export function listAgents(config: Config): { id: string; available: boolean; command: string }[] {
  return Object.entries(config.externalAgent).map(([id, agent]) => {
    const adapter = createSubprocessAdapter(id, agent)
    return { id, available: adapter.available, command: agent.command }
  })
}

const MENTION = /^@([A-Za-z][\w-]*)\s+([\s\S]+)$/

export interface Mention {
  agentID: string
  prompt: string
}

/**
 * Delegasi dipicu EKSPLISIT oleh user (Q8): `@claude tolong review ini`.
 *
 * Model Titah tidak pernah memutuskan sendiri untuk memanggil agent lain —
 * satu turn bisa memanggil Claude Code berkali-kali dan meledakkan biaya tanpa
 * disadari siapa pun.
 */
export function parseMention(text: string): Mention | undefined {
  const match = MENTION.exec(text.trim())
  if (!match) return undefined
  return { agentID: match[1] as string, prompt: (match[2] as string).trim() }
}
