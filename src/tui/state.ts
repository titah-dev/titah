import type { Event } from "../core/event.ts"
import type { Message, Session } from "../core/message.ts"
import type { PermissionRequest } from "../core/permission.ts"

/**
 * Reducer state TUI, sengaja dipisah dari komponen Ink supaya bisa diuji tanpa
 * merender apa pun. Semua bug sinkronisasi stream muncul di sini, bukan di JSX.
 */

export interface TuiState {
  session?: Session
  messages: Message[]
  status: "idle" | "working"
  error?: string
  permission?: PermissionRequest
  /** Antrean izin, kalau satu giliran meminta beberapa sekaligus. */
  permissionQueue: PermissionRequest[]
}

export const initialState: TuiState = {
  messages: [],
  status: "idle",
  permissionQueue: [],
}

function upsertMessage(messages: Message[], next: Message): Message[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) return [...messages, next]
  const copy = messages.slice()
  copy[index] = next
  return copy
}

function appendDelta(messages: Message[], messageID: string, text: string): Message[] {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index === -1) return messages

  const message = messages[index] as Message
  const parts = message.parts.slice()
  const last = parts.at(-1)

  if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + text }
  else parts.push({ type: "text", text })

  const copy = messages.slice()
  copy[index] = { ...message, parts }
  return copy
}

/**
 * Aksi lokal TUI, di luar event yang datang dari server.
 *
 * Berganti sesi harus MENGOSONGKAN state: kalau tidak, riwayat sesi lama masih
 * terlihat sementara stream sudah pindah, dan user membaca percakapan yang
 * bukan miliknya lagi.
 */
export type TuiAction =
  | Event
  | { type: "session.switch"; session: Session }
  | { type: "notice.clear" }
  | { type: "messages.loaded"; messages: Message[]; running: boolean }

export function reduce(state: TuiState, event: TuiAction): TuiState {
  if (event.type === "session.switch") {
    return { ...initialState, session: event.session }
  }

  // Error itu tentang giliran yang SUDAH lewat. Membiarkannya tergantung di atas
  // prompt saat user mengirim perintah berikutnya membuatnya terbaca seolah
  // perintah baru itu yang gagal.
  if (event.type === "notice.clear") {
    return { ...state, error: undefined }
  }

  /*
   * Memuat riwayat yang TERSIMPAN — dan sengaja tidak lewat `message.updated`.
   *
   * `message.updated` menyimpulkan "sedang bekerja" dari pesan user, karena itu
   * benar untuk event yang datang langsung: pesan user berarti giliran baru
   * dimulai. Untuk riwayat lama kesimpulan itu SALAH — memutar ulang percakapan
   * yang sudah selesai berakhir di status bekerja selamanya, karena `session.idle`
   * yang mengakhirinya sudah lewat dan tidak ikut tersimpan. Sesi itu lalu tidak
   * bisa dihentikan (tidak ada yang berjalan untuk dibatalkan) dan tidak bisa
   * dilanjutkan (prompt menolak kirim selama status bekerja).
   *
   * Karena itu status diambil dari server, bukan ditebak dari pesan.
   */
  if (event.type === "messages.loaded") {
    return { ...state, messages: event.messages, status: event.running ? "working" : "idle" }
  }

  switch (event.type) {
    case "session.updated":
      return { ...state, session: event.session }

    case "message.updated":
      // Snapshot menang atas delta lokal: server mengkloning pesan yang sama
      // yang dimutasi oleh delta, jadi ia selalu lebih baru, tidak pernah lebih tua.
      return {
        ...state,
        messages: upsertMessage(state.messages, event.message),
        status: event.message.role === "user" ? "working" : state.status,
      }

    case "text.delta":
      return { ...state, messages: appendDelta(state.messages, event.messageID, event.text) }

    case "permission.request": {
      if (state.permission) {
        return { ...state, permissionQueue: [...state.permissionQueue, event.request] }
      }
      return { ...state, permission: event.request }
    }

    case "permission.resolved": {
      if (state.permission?.id !== event.permissionID) {
        return {
          ...state,
          permissionQueue: state.permissionQueue.filter((request) => request.id !== event.permissionID),
        }
      }
      const [next, ...rest] = state.permissionQueue
      return {
        ...state,
        ...(next ? { permission: next } : { permission: undefined }),
        permissionQueue: rest,
      }
    }

    case "session.error":
      return { ...state, error: event.message }

    case "session.idle":
      // Dialog izin yang masih tergantung saat giliran selesai sudah tidak
      // relevan — membiarkannya di layar akan mengunci input user.
      return { ...state, status: "idle", permission: undefined, permissionQueue: [] }
  }
}

/**
 * Prompt user dari riwayat, untuk menyemai histori panah atas.
 *
 * Diambil dari pesan yang tersimpan, bukan dari catatan lokal, supaya sesi yang
 * dilanjutkan (`/session`) tetap punya histori — kalau tidak, panah atas kosong
 * justru pada sesi yang paling mungkin ingin diulang perintahnya.
 */
export function promptHistory(messages: Message[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text !== "" && out.at(-1) !== text) out.push(text)
  }
  return out
}

export interface UsageTotals {
  input: number
  output: number
  /** Token & biaya agent eksternal, TIDAK dijumlahkan ke atas (Q24). */
  external: { input: number; output: number; cost: number; used: boolean }
}

export function totalUsage(messages: Message[]): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    external: { input: 0, output: 0, cost: 0, used: false },
  }
  for (const message of messages) {
    totals.input += message.usage?.input ?? 0
    totals.output += message.usage?.output ?? 0
    if (message.externalUsage) {
      totals.external.used = true
      totals.external.input += message.externalUsage.input ?? 0
      totals.external.output += message.externalUsage.output ?? 0
      totals.external.cost += message.externalUsage.cost ?? 0
    }
  }
  return totals
}
