/**
 * MCP lewat HTTP — transport "Streamable HTTP".
 *
 * Satu endpoint untuk semuanya. Permintaan JSON-RPC dikirim `POST`, dan
 * jawabannya boleh datang dalam dua bentuk: satu objek JSON, atau aliran
 * `text/event-stream` yang berisi beberapa pesan dan diakhiri jawaban yang
 * `id`-nya cocok. Server memilih bentuknya per permintaan — jadi klien harus
 * siap keduanya, bukan memilih satu di awal.
 *
 * # Kenapa bukan HTTP+SSE yang lama
 *
 * Spesifikasi 2024-11-05 memakai dua endpoint: `GET /sse` untuk membuka aliran,
 * lalu URL POST yang dikirim server lewat event `endpoint`. Ia sudah digantikan,
 * dan menopang keduanya berarti dua jalur kode yang harus tetap benar untuk
 * jenis kegagalan yang sama sekali berbeda. Server yang hanya bicara bentuk lama
 * akan gagal di sini dengan jelas alih-alih setengah bekerja.
 *
 * # Otorisasi
 *
 * 401 TIDAK diperlakukan sebagai kegagalan biasa. Ia dilemparkan sebagai
 * `NeedsAuthorization`, yang membawa serta URL sumber daya dari header
 * `WWW-Authenticate` kalau ada — itu titik awal penemuan OAuth, dan tanpanya
 * user hanya melihat "401" tanpa tahu ke mana harus login.
 */

export class NeedsAuthorization extends Error {
  readonly resourceMetadata: string | undefined

  constructor(message: string, resourceMetadata?: string) {
    super(message)
    this.name = "NeedsAuthorization"
    this.resourceMetadata = resourceMetadata
  }
}

export class HttpTransportError extends Error {}

interface RpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Membaca `resource_metadata` dari header `WWW-Authenticate`.
 *
 * Bentuknya `Bearer resource_metadata="https://…", scope="…"`. Diambil dengan
 * regex alih-alih parser penuh: yang dibutuhkan hanya satu parameter, dan
 * parser challenge HTTP yang benar-benar sesuai RFC jauh lebih besar daripada
 * gunanya di sini. Kalau tidak ada, hasilnya `undefined` dan penemuan OAuth
 * jatuh kembali ke jalur bawaan.
 */
export function resourceMetadataOf(header: string | null): string | undefined {
  if (!header) return undefined
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1]
}

/**
 * Memisahkan aliran SSE menjadi event, lalu mencari jawaban dengan `id` yang
 * dicari.
 *
 * Aliran bisa berisi notifikasi, log, dan jawaban untuk permintaan LAIN yang
 * sedang berjalan. Menerima yang pertama datang berarti sesekali mengembalikan
 * jawaban milik permintaan lain — kesalahan yang muncul sebagai hasil tool yang
 * tertukar, dan itu jauh lebih sulit dilacak daripada error.
 */
export async function readSseResponse(
  body: ReadableStream<Uint8Array>,
  id: number,
  signal?: AbortSignal,
): Promise<RpcResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      if (signal?.aborted) throw new HttpTransportError("Cancelled.")
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Event SSE dipisahkan baris kosong. `\r\n\r\n` ikut diterima karena
      // sebagian server menulis CRLF, dan memotong hanya pada `\n\n` membuat
      // seluruh aliran dari server itu terlihat seperti satu event tak selesai.
      let split: number
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, split)
        buffer = buffer.slice(split + (/\r\n\r\n/.test(buffer.slice(split, split + 4)) ? 4 : 2))

        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data === "") continue

        let parsed: RpcResponse
        try {
          parsed = JSON.parse(data) as RpcResponse
        } catch {
          continue
        }
        if (parsed.id === id) return parsed
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  throw new HttpTransportError("The event stream ended before the response arrived.")
}

export interface HttpTransportOptions {
  url: string
  /** Header tetap dari config. */
  headers?: Record<string, string>
  /** Dipanggil sebelum tiap permintaan; mengembalikan `Authorization` kalau ada. */
  authorization?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
}

export class HttpTransport {
  #url: string
  #headers: Record<string, string>
  #authorization: (() => Promise<string | undefined>) | undefined
  #fetch: typeof fetch
  #id = 0
  /**
   * Sesi yang diberikan server lewat `Mcp-Session-Id` saat inisialisasi.
   *
   * Harus dikirim balik pada SETIAP permintaan sesudahnya. Server yang menyimpan
   * keadaan per sesi akan memperlakukan permintaan tanpa header ini sebagai
   * klien baru — jabat tangannya terulang, dan tool yang bergantung pada
   * keadaan sebelumnya gagal dengan alasan yang tidak menyebut sesi sama sekali.
   */
  #session: string | undefined

  constructor(options: HttpTransportOptions) {
    this.#url = options.url
    this.#headers = options.headers ?? {}
    this.#authorization = options.authorization
    this.#fetch = options.fetchImpl ?? fetch
  }

  get sessionId(): string | undefined {
    return this.#session
  }

  async #send(body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Kedua bentuk disebut sekaligus: server yang memilih SSE dan server yang
      // memilih JSON sama-sama sah, dan menyebut satu saja menutup separuhnya.
      Accept: "application/json, text/event-stream",
      ...this.#headers,
      ...(this.#session ? { "Mcp-Session-Id": this.#session } : {}),
    }

    const auth = await this.#authorization?.()
    if (auth) headers["Authorization"] = auth

    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

    if (response.status === 401) {
      throw new NeedsAuthorization(
        `The MCP server at ${this.#url} requires authorization.`,
        resourceMetadataOf(response.headers.get("WWW-Authenticate")),
      )
    }

    const given = response.headers.get("Mcp-Session-Id")
    if (given) this.#session = given
    return response
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#id += 1
    const id = this.#id
    const response = await this.#send(
      { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
      signal,
    )

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new HttpTransportError(
        `${method} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      )
    }

    const type = response.headers.get("Content-Type") ?? ""
    let payload: RpcResponse

    if (type.includes("text/event-stream")) {
      if (!response.body) throw new HttpTransportError("The server promised a stream and sent none.")
      payload = await readSseResponse(response.body, id, signal)
    } else {
      payload = (await response.json()) as RpcResponse
    }

    if (payload.error) {
      throw new HttpTransportError(payload.error.message ?? `${method} failed with an RPC error.`)
    }
    return payload.result
  }

  /**
   * Notifikasi: tidak punya `id`, jadi tidak ada yang ditunggu.
   *
   * Kegagalannya sengaja DITELAN. Sebuah notifikasi tidak punya jawaban yang
   * bisa hilang, dan `notifications/initialized` yang gagal terkirim tidak
   * boleh menjatuhkan jabat tangan yang sudah berhasil.
   */
  notify(method: string, params?: unknown): void {
    void this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }).catch(
      () => undefined,
    )
  }

  stop(): void {
    // Tidak ada proses yang dimatikan dan tidak ada soket yang dipegang: setiap
    // permintaan berdiri sendiri. Ada supaya bentuknya sama dengan RpcPeer.
    this.#session = undefined
  }
}
