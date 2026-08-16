import type { Event } from "../core/event.ts"
import type { Message, Session } from "../core/message.ts"
import type { PermissionDecision } from "../core/permission.ts"

/**
 * Klien HTTP+SSE. TUI berbicara ke core HANYA lewat ini — tidak ada satu pun
 * import dari `core/agent` di lapisan TUI.
 *
 * Batas itu yang membuat "TUI hanyalah salah satu klien" (Q5) benar dalam kode,
 * bukan cuma di dokumen: apa pun yang bisa dilakukan TUI, bisa dilakukan curl.
 */

export class ClientError extends Error {}

export interface UndoResult {
  messageID: string
  snapshot: string
  files: string[]
}

export class Client {
  readonly baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/$/, "")
  }

  async #json<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseURL}${route}`, init)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message =
        body !== null && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`
      throw new ClientError(message)
    }
    return body as T
  }

  health(): Promise<{ status: string; version: string; pid: number }> {
    return this.#json("/health")
  }

  createSession(directory: string): Promise<Session> {
    return this.#json("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    })
  }

  /** Sesi milik satu proyek. Tanpa `directory`, seluruh mesin. */
  listSessions(directory?: string): Promise<Session[]> {
    const query = directory === undefined ? "" : `?directory=${encodeURIComponent(directory)}`
    return this.#json(`/session${query}`)
  }

  messages(sessionID: string): Promise<Message[]> {
    return this.#json(`/session/${sessionID}/message`)
  }

  /**
   * Mengirim prompt tanpa menunggu jawabannya: seluruh hasil datang lewat
   * stream /event yang sudah dibuka TUI. Promise-nya selesai saat giliran
   * berakhir, dan dipakai hanya untuk menangkap error.
   */
  send(
    sessionID: string,
    text: string,
    model?: string,
    agent?: string,
    effort?: string,
  ): Promise<Message> {
    return this.#json(`/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        ...(effort ? { effort } : {}),
      }),
    })
  }

  /** Apakah sesi sedang mengerjakan giliran — satu-satunya sumber kebenarannya. */
  status(sessionID: string): Promise<{ running: boolean }> {
    return this.#json(`/session/${sessionID}/status`)
  }

  /** Membuang sesi kalau belum ada percakapan. Aman dipanggil kapan saja. */
  discard(sessionID: string): Promise<{ discarded: boolean }> {
    return this.#json(`/session/${sessionID}/discard`, { method: "POST" })
  }

  abort(sessionID: string): Promise<{ aborted: boolean }> {
    return this.#json(`/session/${sessionID}/abort`, { method: "POST" })
  }

  undo(sessionID: string): Promise<UndoResult> {
    return this.#json(`/session/${sessionID}/undo`, { method: "POST" })
  }

  /**
   * Menjawab pertanyaan model. String kosong berarti "tidak menjawab" — dan itu
   * sah: user boleh menolak memilih, dan model menerimanya sebagai izin untuk
   * melanjutkan dengan asumsi terbaiknya.
   */
  answerQuestion(sessionID: string, questionID: string, answer: string): Promise<{ ok: boolean }> {
    return this.#json(`/session/${sessionID}/question/${questionID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer }),
    })
  }

  respondPermission(
    sessionID: string,
    permissionID: string,
    decision: PermissionDecision,
  ): Promise<{ ok: boolean }> {
    return this.#json(`/session/${sessionID}/permission/${permissionID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    })
  }

  /** Berlangganan SSE. Berhenti saat `signal` di-abort. */
  async *events(sessionID: string, signal: AbortSignal): AsyncGenerator<Event> {
    const response = await fetch(`${this.baseURL}/event?session=${sessionID}`, { signal })
    if (!response.body) throw new ClientError("Server did not send an event stream.")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (data === "") continue // baris ": ping" / ": terhubung"
        yield JSON.parse(data) as Event
      }
    }
  }
}
