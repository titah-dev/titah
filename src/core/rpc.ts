import { spawn, type ChildProcess } from "node:child_process"

/**
 * Klien JSON-RPC 2.0 di atas stdio sebuah subprocess.
 *
 * Dibangun sekali karena DUA hal membutuhkannya, dan keduanya diminta bersamaan:
 * MCP (server tool pihak ketiga) dan LSP (language server). Keduanya JSON-RPC
 * 2.0 lewat stdin/stdout sebuah proses anak.
 *
 * Yang BERBEDA di antara keduanya hanya pembingkaiannya:
 *
 *   - **LSP** memakai header ala HTTP: `Content-Length: N\r\n\r\n{...}`.
 *   - **MCP** memakai satu objek JSON per baris.
 *
 * Karena itu pembingkaian jadi parameter, bukan dua salinan protokol. Dua
 * salinan berarti perbaikan pada penanganan permintaan yang saling menyusul
 * hanya mendarat di salah satunya — dan yang tertinggal akan gagal dengan cara
 * yang sulit dilacak justru saat sedang sibuk.
 */

export type Framing = "content-length" | "ndjson"

export interface RpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: unknown
}

export interface RpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface RpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class RpcError extends Error {
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

/** Membungkus satu pesan sesuai pembingkaian yang dipakai. */
export function encode(framing: Framing, message: unknown): string {
  const body = JSON.stringify(message)
  if (framing === "ndjson") return `${body}\n`
  // Content-Length dihitung dalam BYTE, bukan karakter. Pesan berisi teks
  // non-ASCII — nama berkas Indonesia, pesan diagnostik berbahasa lain — akan
  // membuat server membaca terlalu sedikit kalau dihitung per karakter, lalu
  // seluruh aliran sesudahnya bergeser dan tidak pernah pulih.
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
}

/**
 * Pemecah aliran jadi pesan-pesan utuh.
 *
 * Stdio datang dalam potongan sembarang: satu pesan bisa terbelah dua, dan dua
 * pesan bisa tiba dalam satu potongan. Buffer di sini yang menanganinya, dan
 * itu satu-satunya alasan kelas ini ada.
 */
export class MessageBuffer {
  #buffer = Buffer.alloc(0)
  readonly #framing: Framing

  constructor(framing: Framing) {
    this.#framing = framing
  }

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    return this.#framing === "ndjson" ? this.#drainLines() : this.#drainHeaders()
  }

  #drainLines(): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a)
      if (newline === -1) break
      const line = this.#buffer.subarray(0, newline).toString("utf8").trim()
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (line === "") continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // Baris yang bukan JSON dibuang, tidak melempar. Server yang menulis
        // catatan ke stdout adalah kesalahan yang umum, dan mematikan koneksi
        // karenanya membuat satu baris cerewet menjatuhkan seluruh integrasi.
      }
    }
    return out
  }

  #drainHeaders(): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const separator = this.#buffer.indexOf("\r\n\r\n")
      if (separator === -1) break
      const header = this.#buffer.subarray(0, separator).toString("ascii")
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Header tanpa Content-Length tidak bisa dipulihkan: kita tidak tahu di
        // mana pesan ini berakhir. Membuangnya sampai pemisah berikutnya adalah
        // satu-satunya jalan maju yang tidak menebak.
        this.#buffer = this.#buffer.subarray(separator + 4)
        continue
      }
      const length = Number(match[1])
      const start = separator + 4
      if (this.#buffer.length < start + length) break // pesannya belum lengkap
      const body = this.#buffer.subarray(start, start + length).toString("utf8")
      this.#buffer = this.#buffer.subarray(start + length)
      try {
        out.push(JSON.parse(body))
      } catch {
        // idem
      }
    }
    return out
  }
}

export interface RpcPeerOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  framing: Framing
  /** Batas satu permintaan. Server yang menggantung tidak boleh menahan giliran. */
  timeoutMs?: number
  /** Notifikasi dari server (mis. `textDocument/publishDiagnostics`). */
  onNotification?: (method: string, params: unknown) => void
}

const DEFAULT_TIMEOUT = 30_000

/**
 * Satu proses anak yang bicara JSON-RPC.
 *
 * Dimulai malas: prosesnya baru dijalankan saat permintaan pertama. Server MCP
 * dan language server sama-sama mahal untuk dinyalakan, dan menyalakan semuanya
 * di awal berarti setiap sesi membayar untuk yang tidak pernah dipakai.
 */
export class RpcPeer {
  #child: ChildProcess | undefined
  #buffer: MessageBuffer
  #nextId = 1
  #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  #stderr = ""
  #dead: Error | undefined
  readonly #options: RpcPeerOptions

  constructor(options: RpcPeerOptions) {
    this.#options = options
    this.#buffer = new MessageBuffer(options.framing)
  }

  get running(): boolean {
    return this.#child !== undefined && this.#dead === undefined
  }

  #start(): ChildProcess {
    if (this.#child) return this.#child

    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...(this.#options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const message of this.#buffer.push(chunk)) this.#dispatch(message)
    })
    // stderr DISIMPAN, tidak dibuang. Ketika sebuah server gagal menyala, satu
    // -satunya penjelasan yang pernah ada biasanya ada di sana — dan tanpa ini
    // user hanya melihat "tidak merespons".
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-4096)
    })

    const die = (error: Error) => {
      this.#dead = error
      for (const entry of this.#waiting.values()) entry.reject(error)
      this.#waiting.clear()
    }

    /*
     * Kegagalan menulis ke stdin anak DICATAT, bukan dijadikan sebab kematian.
     *
     * `#write` sudah memeriksa `#dead` sebelum menulis, tapi itu potret sesaat:
     * anaknya bisa mati di antara pemeriksaan dan tulisan yang mendarat, dan
     * muatan yang lebih besar dari buffer pipa 64 KB — hasil tool MCP, `didOpen`
     * yang membawa satu berkas utuh — pasti mendarat sesudahnya. EPIPE-nya lalu
     * datang ASINKRON sebagai event `error` di stream, dan tanpa listener ini
     * Node memperlakukannya sebagai `error` tak tertangani lalu menjatuhkan
     * SELURUH proses Titah karena satu server MCP mati.
     *
     * Sengaja tidak memanggil `die` sendiri. EPIPE tiba lebih dulu daripada
     * `close` — diukur, bukan ditebak — sementara yang berguna bagi pembacanya
     * justru kode keluar dan stderr yang hanya dibawa `close`. "write EPIPE"
     * menjelaskan gejala; `"server" exited (3): ...` menjelaskan sebabnya. Yang
     * ini hanya menahan lemparannya dan menyerahkan kalimatnya ke bawah.
     *
     * Kalau `close` tidak pernah datang — server yang menutup stdin tapi tetap
     * hidup — yang menahannya timeout per permintaan yang sudah ada, dan
     * kalimatnya ("did not answer in time") memang benar untuk keadaan itu.
     */
    let writeFailed = false
    child.stdin?.on("error", () => {
      writeFailed = true
    })
    child.on("error", (error) =>
      die(new RpcError(`Could not start "${this.#options.command}": ${error.message}`)),
    )
    child.on("close", (code) =>
      die(
        new RpcError(
          `"${this.#options.command}" exited (${code})` +
            // Disebut karena bedanya nyata bagi yang membacanya: server yang
            // mati di antara dua permintaan kehilangan tidak apa-apa, sedangkan
            // yang mati saat sedang ditulisi kehilangan permintaan yang sedang
            // berjalan — dan itu menjelaskan kenapa jawabannya tidak pernah datang.
            (writeFailed ? ", with a request still being written to it" : "") +
            (this.#stderr.trim() === "" ? "" : `:\n${this.#stderr.trim()}`),
        ),
      ),
    )

    this.#child = child
    return child
  }

  #dispatch(message: unknown): void {
    const value = message as Partial<RpcResponse & RpcNotification>
    if (typeof value.id === "number") {
      const waiting = this.#waiting.get(value.id)
      if (!waiting) return
      this.#waiting.delete(value.id)
      if (value.error) return waiting.reject(new RpcError(value.error.message, value.error.code))
      return waiting.resolve(value.result)
    }
    if (typeof value.method === "string") {
      this.#options.onNotification?.(value.method, value.params)
    }
  }

  #write(message: unknown): void {
    const child = this.#start()
    if (this.#dead) throw this.#dead
    child.stdin?.write(encode(this.#options.framing, message))
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        reject(new RpcError(`"${this.#options.command}" did not answer ${method} in time`))
      }, this.#options.timeoutMs ?? DEFAULT_TIMEOUT)

      this.#waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      try {
        this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timer)
        this.#waiting.delete(id)
        reject(error as Error)
      }
    })
  }

  stop(): void {
    this.#child?.kill("SIGTERM")
    this.#child = undefined
    this.#dead = new RpcError("stopped")
    for (const entry of this.#waiting.values()) entry.reject(this.#dead)
    this.#waiting.clear()
  }
}
