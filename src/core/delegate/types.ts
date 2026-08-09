/**
 * Kontrak adapter delegasi (Q7/Q12).
 *
 * Bentuknya sengaja meniru ACP (`prompt` / `sessionUpdate` / `requestPermission`
 * / `cancel`) meski v1 memakai subprocess + JSON. Dengan begitu, menambahkan
 * transport ACP di v2 berarti menulis satu adapter baru — bukan membongkar core.
 */

export type DelegationUpdate =
  | { kind: "session"; sessionID: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "progress"; note: string }

export interface DelegationUsage {
  input?: number
  output?: number
  /** Dalam USD, kalau agent eksternal melaporkannya. */
  cost?: number
}

export interface DelegationResult {
  /** Jawaban final. HANYA ini yang masuk konteks Titah (Q12). */
  answer: string
  /** Sesi milik agent eksternal, dipetakan agar `@claude` berikutnya nyambung. */
  externalSessionID?: string
  usage: DelegationUsage
  durationMs: number
  /** Transkrip mentah, ditulis ke tool-output/ dan disebut lewat path. */
  transcript: string
  isError: boolean
  errorMessage?: string
}

export interface DelegationRequest {
  prompt: string
  cwd: string
  /** Sesi eksternal sebelumnya, kalau ini lanjutan. */
  resumeSessionID?: string
  signal: AbortSignal
  onUpdate?: (update: DelegationUpdate) => void
}

export interface DelegateAdapter {
  id: string
  /** Path executable, atau undefined kalau CLI-nya tidak terpasang (Q24). */
  executable?: string
  available: boolean
  timeoutMs: number
  prompt(request: DelegationRequest): Promise<DelegationResult>
}

export class DelegationError extends Error {}
