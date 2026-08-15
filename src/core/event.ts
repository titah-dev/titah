import type { Message, Session } from "./message.ts"
import type { QuestionRequest } from "./question.ts"
import type { PermissionRequest } from "./permission.ts"

/**
 * Model streaming hybrid (Q18/Q22):
 *   - teks asisten dikirim sebagai delta per-token → terasa hidup
 *   - segala sesuatu yang lain dikirim sebagai snapshot pesan utuh
 *
 * Snapshot untuk status tool sengaja dipilih meski boros: sinkronisasi state
 * inkremental adalah sumber utama TUI yang "nyangkut" setelah reconnect.
 */

export interface SubagentState {
  sessionID: string
  agent: string
  status: "queued" | "running" | "done" | "failed" | "stopped"
  startedAt: number
  /** Satu baris aktivitas untuk panel, mis. "menulis src/auth.ts". */
  note: string
}

export type Event =
  | { type: "session.updated"; sessionID: string; session: Session }
  | { type: "message.updated"; sessionID: string; message: Message }
  | { type: "text.delta"; sessionID: string; messageID: string; text: string }
  /**
   * Penalaran yang mengalir, dipisah dari `text.delta`.
   *
   * Klien HARUS bisa membedakannya: yang satu jawaban, yang satu jalan menuju
   * jawaban. Menyatukannya berarti setiap klien harus menebak yang mana yang
   * baru saja ia terima, dan TUI akan merendernya sebagai jawaban.
   */
  | { type: "reasoning.delta"; sessionID: string; messageID: string; text: string }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; message: string }
  /**
   * Kabar yang bukan kegagalan.
   *
   * Sengaja BUKAN `session.error`: di seluruh Titah event itu berarti
   * "gilirannya gagal" — klien menampilkannya merah dan user membaca giliran
   * yang justru berhasil sebagai giliran yang rusak. Sudah pernah dicoba dan
   * dicabut lagi. Kanal ini ada supaya hal seperti "auto-compaction mati karena
   * contextWindow model ini belum dideklarasikan" bisa dikatakan sekali,
   * pelan, tanpa berpura-pura sebagai error.
   */
  | { type: "session.notice"; sessionID: string; message: string }
  | { type: "permission.request"; sessionID: string; request: PermissionRequest }
  | { type: "permission.resolved"; sessionID: string; permissionID: string; granted: boolean }
  | { type: "question.request"; sessionID: string; request: QuestionRequest }
  | { type: "question.resolved"; sessionID: string; questionID: string }
  | { type: "subagent.updated"; sessionID: string; child: SubagentState }

type Queue = {
  push: (event: Event) => void
  close: () => void
}

/** Pub/sub sederhana dalam proses. Server yang menyiarkannya lewat SSE. */
export class Bus {
  #subscribers = new Set<{ sessionID?: string; queue: Queue }>()

  publish(event: Event): void {
    for (const subscriber of this.#subscribers) {
      if (subscriber.sessionID !== undefined && subscriber.sessionID !== event.sessionID) continue
      subscriber.queue.push(event)
    }
  }

  /** Berhenti saat `signal` di-abort. Filter opsional per sesi. */
  subscribe(options: { sessionID?: string; signal?: AbortSignal } = {}): AsyncIterable<Event> {
    const buffer: Event[] = []
    let notify: (() => void) | undefined
    let closed = false

    const queue: Queue = {
      push(event) {
        buffer.push(event)
        notify?.()
      },
      close() {
        closed = true
        notify?.()
      },
    }

    const entry = { ...(options.sessionID ? { sessionID: options.sessionID } : {}), queue }
    this.#subscribers.add(entry)

    const unsubscribe = () => {
      this.#subscribers.delete(entry)
      queue.close()
    }
    options.signal?.addEventListener("abort", unsubscribe, { once: true })

    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            while (buffer.length > 0) yield buffer.shift() as Event
            if (closed) return
            await new Promise<void>((resolve) => {
              notify = () => {
                notify = undefined
                resolve()
              }
            })
          }
        } finally {
          self.#subscribers.delete(entry)
        }
      },
    }
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  /**
   * Berapa banyak klien yang benar-benar akan menerima event sesi ini —
   * pelanggan global ikut dihitung, karena mereka juga bisa menjawab dialog izin.
   *
   * Permission engine memakai ini untuk memutuskan tolak-otomatis (Q17).
   */
  listenerCount(sessionID: string): number {
    let count = 0
    for (const subscriber of this.#subscribers) {
      if (subscriber.sessionID === undefined || subscriber.sessionID === sessionID) count += 1
    }
    return count
  }
}

export const bus = new Bus()
