import crypto from "node:crypto"
import { bus } from "./event.ts"
import type { Agent, Config } from "./schema.ts"

/**
 * Deny-by-default (Q9), dengan satu aturan yang tidak bisa ditawar (Q17):
 * kalau tidak ada klien yang terhubung, permintaan izin DITOLAK otomatis dan
 * alasannya dicatat.
 *
 * Blokir tanpa batas akan menggantung agent selamanya di CI; izin otomatis
 * membuat mode headless jadi celah keamanan diam-diam. Jalur yang benar untuk
 * otomasi adalah `--auto` atau allowlist eksplisit, bukan perilaku implisit.
 */

export type PermissionKind = "edit" | "write" | "bash"

export type PermissionDecision = "once" | "always" | "reject"

export interface PermissionRequest {
  id: string
  sessionID: string
  kind: PermissionKind
  /** Ringkasan satu baris untuk dialog, mis. `bash: git status`. */
  title: string
  /** Isi lengkap yang akan dieksekusi/ditulis, untuk ditinjau user. */
  detail: string
  /**
   * Pola yang akan masuk allowlist kalau user menjawab "always",
   * mis. `git *` untuk bash atau `edit` untuk seluruh kelas tool.
   */
  pattern: string
  created: number
}

export interface PermissionResult {
  granted: boolean
  reason: string
}

interface Pending {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
}

const pending = new Map<string, Pending>()

/** Allowlist yang tumbuh selama sesi berjalan, dari jawaban "always". */
const sessionAllowlist = new Map<string, Set<string>>()

/** Sesi yang berjalan dengan --auto. */
const autoSessions = new Set<string>()

export function setAutoApprove(sessionID: string, enabled: boolean): void {
  if (enabled) autoSessions.add(sessionID)
  else autoSessions.delete(sessionID)
}

export function isAutoApprove(sessionID: string): boolean {
  return autoSessions.has(sessionID)
}

export function allowlistFor(sessionID: string): string[] {
  return [...(sessionAllowlist.get(sessionID) ?? [])]
}

export function clearSession(sessionID: string): void {
  sessionAllowlist.delete(sessionID)
  autoSessions.delete(sessionID)
  for (const [id, entry] of pending) {
    if (entry.request.sessionID !== sessionID) continue
    entry.resolve({ granted: false, reason: "Session ended." })
    pending.delete(id)
  }
}

function remember(sessionID: string, pattern: string): void {
  const set = sessionAllowlist.get(sessionID) ?? new Set<string>()
  set.add(pattern)
  sessionAllowlist.set(sessionID, set)
}

/**
 * Pencocokan pola gaya glob sederhana: `*` cocok dengan apa saja.
 * Dipakai untuk allowlist bash seperti `git *` atau `npm test`.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

export interface EffectivePermission {
  edit: "ask" | "allow" | "deny"
  write: "ask" | "allow" | "deny"
  bash: "ask" | "allow" | "deny"
  allowlist: string[]
  /** Nama agent yang menentukan kebijakan ini, untuk pesan yang bisa dilacak. */
  source?: string
}

/**
 * Izin global ditimpa izin milik agent yang sedang aktif (Q21).
 *
 * Inilah yang membuat "Build Auto" dan "Build Manual" berbeda: keduanya punya
 * tool yang sama persis, hanya kebijakan izinnya yang berbeda.
 */
export function effectivePermission(
  config: Config,
  agentID?: string,
  agent?: Agent,
): EffectivePermission {
  const base = config.permission
  const override = agent?.permission
  return {
    edit: override?.edit ?? base.edit,
    write: override?.write ?? base.write,
    bash: override?.bash ?? base.bash,
    allowlist: [...base.allowlist, ...(override?.allowlist ?? [])],
    ...(override && agentID ? { source: agentID } : {}),
  }
}

export interface AskOptions {
  sessionID: string
  kind: PermissionKind
  title: string
  detail: string
  pattern: string
  permission: EffectivePermission
  /** Jumlah klien yang sedang mendengarkan sesi ini. 0 berarti tolak. */
  listeners: number
  signal?: AbortSignal
}

export async function ask(options: AskOptions): Promise<PermissionResult> {
  const policy = options.permission[options.kind]
  const from = options.permission.source ? `agent "${options.permission.source}"` : "config"

  if (policy === "deny") {
    return { granted: false, reason: `Denied by ${from}: ${options.kind} = "deny".` }
  }
  if (policy === "allow") {
    return { granted: true, reason: `Allowed by ${from}: ${options.kind} = "allow".` }
  }

  const configAllowlist = options.permission.allowlist
  const matched = [...configAllowlist, ...allowlistFor(options.sessionID)].find((pattern) =>
    matchesPattern(pattern, options.pattern),
  )
  if (matched) return { granted: true, reason: `Matched allowlist: "${matched}".` }

  if (autoSessions.has(options.sessionID)) {
    return { granted: true, reason: "--auto mode is on." }
  }

  // Inti Q17. Tanpa klien, tidak ada yang bisa menjawab dialog — jadi jangan
  // menggantung, dan jangan mengizinkan.
  if (options.listeners === 0) {
    return {
      granted: false,
      reason:
        "Auto-denied: no client is connected to answer the permission request. " +
        "For automation use --auto, or add a pattern to permission.allowlist.",
    }
  }

  const request: PermissionRequest = {
    id: `perm_${crypto.randomUUID()}`,
    sessionID: options.sessionID,
    kind: options.kind,
    title: options.title,
    detail: options.detail,
    pattern: options.pattern,
    created: Date.now(),
  }

  return new Promise<PermissionResult>((resolve) => {
    const settle = (result: PermissionResult) => {
      pending.delete(request.id)
      bus.publish({
        type: "permission.resolved",
        sessionID: request.sessionID,
        permissionID: request.id,
        granted: result.granted,
      })
      resolve(result)
    }

    pending.set(request.id, { request, resolve: settle })
    options.signal?.addEventListener(
      "abort",
      () => {
        if (pending.has(request.id)) settle({ granted: false, reason: "Cancelled." })
      },
      { once: true },
    )

    bus.publish({ type: "permission.request", sessionID: request.sessionID, request })
  })
}

export function respond(permissionID: string, decision: PermissionDecision): boolean {
  const entry = pending.get(permissionID)
  if (!entry) return false

  if (decision === "reject") {
    entry.resolve({ granted: false, reason: "Refused by user." })
    return true
  }
  if (decision === "always") remember(entry.request.sessionID, entry.request.pattern)
  entry.resolve({ granted: true, reason: decision === "always" ? "Allowed for the rest of this session." : "Allowed once." })
  return true
}

export function listPending(sessionID?: string): PermissionRequest[] {
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => sessionID === undefined || request.sessionID === sessionID)
}
