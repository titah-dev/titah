import http from "node:http"
import type { AddressInfo } from "node:net"
import { abort, isRunning, prompt, AgentError } from "../core/agent.ts"
import { bus, type Event } from "../core/event.ts"
import { listPending, respond, type PermissionDecision } from "../core/permission.ts"
import { answerQuestion, cancelQuestion, listPendingQuestions } from "../core/question.ts"
import { undo, UndoError } from "../core/undo.ts"
import { SnapshotError } from "../core/snapshot.ts"
import {
  createSession,
  deleteSession,
  discardIfEmpty,
  getSession,
  listMessages,
  listSessions,
} from "../core/storage/session.ts"

/**
 * Protokol server↔klien: HTTP REST untuk perintah, SSE untuk stream (Q10).
 *
 * Arahnya memang asimetris — klien→server itu perintah jarang, server→klien itu
 * stream padat. SSE menangani reconnect sendiri dan bisa di-curl, yang membuat
 * seluruh core ini bisa diuji tanpa TUI sama sekali.
 */

const HEARTBEAT_MS = 15_000

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (text === "") return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new HttpError(400, "Body is not valid JSON.")
  }
}

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function openStream(res: http.ServerResponse): { send: (event: Event) => void; stop: () => void } {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.write(": connected\n\n")

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS)
  heartbeat.unref()

  return {
    send(event) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    },
    stop() {
      clearInterval(heartbeat)
      res.end()
    },
  }
}

export interface ServerHandle {
  url: string
  port: number
  close: () => Promise<void>
}

export function createServer(version: string): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, version).catch((error: unknown) => {
      if (res.headersSent) return res.end()
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      json(res, status, { error: message })
    })
  })
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  version: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const segments = url.pathname.split("/").filter(Boolean)
  const method = req.method ?? "GET"

  if (segments.length === 0 || segments[0] === "health") {
    return json(res, 200, { status: "ok", version, pid: process.pid })
  }

  // GET /event?session=<id> — stream pengamat, tidak terikat satu turn.
  if (segments[0] === "event" && method === "GET") {
    const sessionID = url.searchParams.get("session") ?? undefined
    const controller = new AbortController()
    const stream = openStream(res)
    req.on("close", () => {
      controller.abort()
      stream.stop()
    })
    for await (const event of bus.subscribe({
      ...(sessionID ? { sessionID } : {}),
      signal: controller.signal,
    })) {
      stream.send(event)
    }
    return
  }

  if (segments[0] !== "session") throw new HttpError(404, `Unknown route: ${url.pathname}`)

  // /session
  if (segments.length === 1) {
    if (method === "GET") {
      // ?directory= menyaring ke satu proyek. Tanpa parameter berarti seluruh
      // mesin, yang dipakai alat administrasi — bukan daftar sehari-hari.
      const directory = url.searchParams.get("directory") ?? undefined
      return json(res, 200, listSessions(50, directory))
    }
    if (method === "POST") {
      const body = await readBody(req)
      const directory = typeof body["directory"] === "string" ? body["directory"] : process.cwd()
      const title = typeof body["title"] === "string" ? body["title"] : ""
      return json(res, 201, createSession(directory, title))
    }
    throw new HttpError(405, `Method ${method} is not supported for /session`)
  }

  const sessionID = segments[1] as string
  const session = getSession(sessionID)
  if (!session) throw new HttpError(404, `Session not found: ${sessionID}`)

  // /session/:id
  if (segments.length === 2) {
    if (method === "GET") return json(res, 200, session)
    if (method === "DELETE") return json(res, 200, { deleted: deleteSession(sessionID) })
    throw new HttpError(405, `Method ${method} is not supported`)
  }

  // /session/:id/abort
  if (segments[2] === "abort" && method === "POST") {
    return json(res, 200, { aborted: abort(sessionID) })
  }

  /*
   * /session/:id/status — apakah sesi ini SEDANG mengerjakan sesuatu.
   *
   * Klien yang baru menempel tidak bisa menyimpulkan ini dari riwayat: riwayat
   * hanya bercerita tentang masa lalu, dan giliran yang dibatalkan berakhir
   * tanpa meninggalkan jejak apa pun di pesan terakhirnya.
   */
  if (segments[2] === "status" && method === "GET") {
    return json(res, 200, { running: isRunning(sessionID) })
  }

  /*
   * /session/:id/discard — buang sesi ini KALAU belum ada percakapan di dalamnya.
   *
   * Dipanggil TUI saat keluar dan saat berpindah sesi. Sengaja bukan DELETE
   * biasa: klien membuang sesi yang ia KIRA tidak terpakai, dan salah hitung
   * tidak boleh berujung hilangnya percakapan sungguhan.
   */
  if (segments[2] === "discard" && method === "POST") {
    return json(res, 200, { discarded: discardIfEmpty(sessionID) })
  }

  // /session/:id/undo
  if (segments[2] === "undo" && method === "POST") {
    try {
      return json(res, 200, await undo(sessionID))
    } catch (error) {
      if (error instanceof UndoError || error instanceof SnapshotError) {
        throw new HttpError(409, error.message)
      }
      throw error
    }
  }

  // /session/:id/permission[/:permissionID]
  if (segments[2] === "permission") {
    if (method === "GET") return json(res, 200, listPending(sessionID))
    if (method !== "POST") throw new HttpError(405, `Method ${method} is not supported`)

    const permissionID = segments[3]
    if (!permissionID) throw new HttpError(400, "The permission request id is required in the path.")

    const body = await readBody(req)
    const decision = body["decision"]
    if (decision !== "once" && decision !== "always" && decision !== "reject") {
      throw new HttpError(400, 'Field "decision" must be one of: once, always, reject.')
    }

    const handled = respond(permissionID, decision as PermissionDecision)
    if (!handled) throw new HttpError(404, `Permission request not found or already answered: ${permissionID}`)
    return json(res, 200, { ok: true })
  }

  // /session/:id/question[/:questionID]
  if (segments[2] === "question") {
    if (method === "GET") return json(res, 200, listPendingQuestions(sessionID))
    if (method !== "POST") throw new HttpError(405, `Method ${method} is not supported`)

    const questionID = segments[3]
    if (!questionID) throw new HttpError(400, "The question id is required in the path.")

    const body = await readBody(req)
    const answer = body["answer"]
    // String KOSONG sah dan berarti "tidak menjawab" — user menekan Enter tanpa
    // mengetik. Yang tidak sah adalah bukan string sama sekali.
    if (typeof answer !== "string") throw new HttpError(400, 'Field "answer" must be a string.')

    const handled =
      answer.trim() === "" ? cancelQuestion(questionID) : answerQuestion(questionID, answer)
    if (!handled) throw new HttpError(404, `Question not found or already answered: ${questionID}`)
    return json(res, 200, { ok: true })
  }

  // /session/:id/message
  if (segments[2] === "message") {
    if (method === "GET") return json(res, 200, listMessages(sessionID))
    if (method !== "POST") throw new HttpError(405, `Method ${method} is not supported`)

    const body = await readBody(req)
    const text = typeof body["text"] === "string" ? body["text"].trim() : ""
    if (text === "") throw new HttpError(400, 'Field "text" is required.')
    if (isRunning(sessionID)) throw new HttpError(409, "This session is already processing another turn.")
    const model = typeof body["model"] === "string" ? body["model"] : undefined
    const auto = body["auto"] === true
    const agent = typeof body["agent"] === "string" ? body["agent"] : undefined

    const wantsStream = (req.headers.accept ?? "").includes("text/event-stream")
    if (!wantsStream) {
      try {
        return json(res, 200, await prompt({ sessionID, text, auto, ...(model ? { model } : {}), ...(agent ? { agent } : {}) }))
      } catch (error) {
        if (error instanceof AgentError) throw new HttpError(409, error.message)
        throw error
      }
    }

    // Mode stream: berlangganan DULU, baru mulai giliran, supaya tidak ada
    // event yang lolos di antara keduanya.
    const controller = new AbortController()
    const stream = openStream(res)
    req.on("close", () => controller.abort())

    const events = bus.subscribe({ sessionID, signal: controller.signal })
    const turn = prompt({
      sessionID,
      text,
      auto,
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    }).catch(() => undefined)

    for await (const event of events) {
      stream.send(event)
      if (event.type === "session.idle") break
    }
    await turn
    controller.abort()
    stream.stop()
    return
  }

  throw new HttpError(404, `Unknown route: ${url.pathname}`)
}

export function listen(version: string, port: number, hostname: string): Promise<ServerHandle> {
  const server = createServer(version)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, hostname, () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://${hostname}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
