import fs from "node:fs"
import path from "node:path"
import { authFile, dataDir } from "./paths.ts"

/**
 * Kredensial disimpan terpisah dari config (Q19).
 *
 * Alasannya praktis: config JSON adalah file yang orang tempel ke issue GitHub,
 * commit ke dotfiles repo, dan tunjukkan saat screen-share. auth.json tidak.
 */

export interface AuthEntry {
  type: "api"
  key: string
}

export type AuthStore = Record<string, AuthEntry>

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export function readAuth(): AuthStore {
  const file = authFile()
  if (!fs.existsSync(file)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (parsed === null || typeof parsed !== "object") return {}
  return parsed as AuthStore
}

export function writeAuth(store: AuthStore): void {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const file = authFile()
  // Tulis lalu rename supaya tidak pernah ada file setengah jadi, dan set mode
  // SEBELUM rename supaya kunci tidak pernah sekejap pun world-readable.
  const tmp = path.join(dir, `.auth.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE })
  fs.chmodSync(tmp, FILE_MODE)
  fs.renameSync(tmp, file)
}

export function setCredential(providerId: string, key: string): void {
  const store = readAuth()
  store[providerId] = { type: "api", key }
  writeAuth(store)
}

export function removeCredential(providerId: string): boolean {
  const store = readAuth()
  if (store[providerId] === undefined) return false
  delete store[providerId]
  writeAuth(store)
  return true
}

/** Melaporkan izin file kalau lebih longgar dari 0600. */
export function checkPermissions(): { file: string; mode: string } | undefined {
  const file = authFile()
  if (!fs.existsSync(file)) return undefined
  const mode = fs.statSync(file).mode & 0o777
  if (mode === FILE_MODE) return undefined
  return { file, mode: mode.toString(8).padStart(3, "0") }
}
