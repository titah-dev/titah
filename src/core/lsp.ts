import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { RpcPeer } from "./rpc.ts"
import type { Config } from "./schema.ts"

/**
 * Diagnostics OTOMATIS dari language server.
 *
 * Konsep ketiga dari pemeriksa proyek, setelah `diagnostics` (menjalankan
 * perintah yang user nyatakan). Bedanya bukan pada apa yang ditemukan melainkan
 * KAPAN: `diagnostics` hanya berjalan kalau model ingat memanggilnya, sedangkan
 * ini berjalan sendiri setiap kali sebuah berkas disunting.
 *
 * Itu menutup pola yang sudah terlihat berkali-kali: perubahan tampak benar,
 * suite hijau, rusaknya baru ketahuan belakangan.
 *
 * # Kenapa ini bukan LSP client seutuhnya
 *
 * Yang dipakai hanya bagian yang menjawab satu pertanyaan: *"apakah berkas yang
 * baru saja saya sunting punya error?"* Jadi `initialize`, `didOpen`, dan
 * `publishDiagnostics`. Tidak ada completion, hover, rename, atau go-to —
 * semuanya berguna untuk manusia yang mengetik, dan tidak satu pun berguna
 * untuk model yang menyunting lewat `edit`.
 *
 * Membangun LSP client penuh berarti membangun editor. Yang dibutuhkan di sini
 * adalah pemeriksa.
 */

export interface Diagnostic {
  line: number
  column: number
  severity: "error" | "warning" | "info"
  message: string
  source?: string
}

interface LspDiagnostic {
  range?: { start?: { line?: number; character?: number } }
  severity?: number
  message?: string
  source?: string
}

const SEVERITY: Record<number, Diagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" }

/**
 * Satu language server dan diagnostics terakhir yang ia laporkan.
 *
 * Diagnostics datang lewat NOTIFIKASI (`textDocument/publishDiagnostics`), bukan
 * sebagai jawaban permintaan — server mengirimkannya kapan pun ia selesai
 * menganalisis. Karena itu ia disimpan per URI, dan pembacanya menunggu sampai
 * ada yang datang untuk berkas yang ia tanyakan.
 */
class LanguageServer {
  #peer: RpcPeer
  #ready: Promise<void> | undefined
  #diagnostics = new Map<string, Diagnostic[]>()
  #seen = new Set<string>()
  readonly id: string
  readonly extensions: string[]
  /** id + perintah + argumen: identitas proses ini, bukan sekadar namanya. */
  readonly key: string
  #failure: string | undefined
  /**
   * Kapabilitas yang DIAKUI server saat `initialize`.
   *
   * Disimpan karena format hanya boleh diminta kalau server bilang ia bisa.
   * Mengirim `textDocument/formatting` ke server yang tidak mendukungnya bukan
   * sekadar sia-sia: sebagian menjawab error, dan error itu akan terbaca seperti
   * suntingannya yang bermasalah.
   */
  #capabilities: Record<string, unknown> = {}

  constructor(
    id: string,
    options: { command: string; args: string[]; extensions: string[]; cwd: string; key: string },
  ) {
    this.id = id
    this.extensions = options.extensions
    this.key = options.key
    this.#peer = new RpcPeer({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      // LSP memakai header Content-Length, bukan satu JSON per baris seperti MCP.
      framing: "content-length",
      onNotification: (method, params) => {
        if (method !== "textDocument/publishDiagnostics") return
        const payload = params as { uri?: string; diagnostics?: LspDiagnostic[] }
        if (typeof payload.uri !== "string") return
        this.#diagnostics.set(
          payload.uri,
          (payload.diagnostics ?? []).map((item) => ({
            line: (item.range?.start?.line ?? 0) + 1,
            column: (item.range?.start?.character ?? 0) + 1,
            severity: SEVERITY[item.severity ?? 1] ?? "error",
            message: item.message ?? "",
            ...(item.source ? { source: item.source } : {}),
          })),
        )
      },
    })
  }

  get failure(): string | undefined {
    return this.#failure
  }

  handles(file: string): boolean {
    return this.extensions.some((extension) => file.endsWith(extension))
  }

  #initialize(cwd: string): Promise<void> {
    this.#ready ??= (async () => {
      const result = (await this.#peer.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: path.basename(cwd) }],
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
            formatting: { dynamicRegistration: false },
          },
        },
      })) as { capabilities?: Record<string, unknown> } | undefined
      this.#capabilities = result?.capabilities ?? {}
      this.#peer.notify("initialized", {})
    })()
    return this.#ready
  }

  get formats(): boolean {
    const provider = this.#capabilities["documentFormattingProvider"]
    return provider === true || (typeof provider === "object" && provider !== null)
  }

  /** Membuka berkas kalau belum, atau memberitahu isinya berubah kalau sudah. */
  #sync(uri: string, file: string, text: string): void {
    if (this.#seen.has(uri)) {
      this.#peer.notify("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text }],
      })
      return
    }
    this.#seen.add(uri)
    this.#peer.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageOf(file), version: 1, text },
    })
  }

  /**
   * Isi berkas setelah diformat server, atau `undefined` kalau tidak ada yang
   * perlu diubah.
   *
   * `undefined` di sini berarti **tidak ada perubahan** dan bukan kegagalan —
   * server yang tidak mendukung format, permintaan yang error, dan berkas yang
   * memang sudah rapi semuanya berujung sama: berkasnya tidak disentuh.
   */
  async format(
    file: string,
    cwd: string,
    options: { tabSize: number; insertSpaces: boolean },
  ): Promise<string | undefined> {
    try {
      await this.#initialize(cwd)
    } catch (error) {
      this.#failure = (error as Error).message
      return undefined
    }
    if (!this.formats) return undefined

    const uri = pathToFileURL(file).href
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      return undefined
    }
    this.#sync(uri, file, text)

    let edits: TextEdit[]
    try {
      edits = ((await this.#peer.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      })) ?? []) as TextEdit[]
    } catch (error) {
      this.#failure = (error as Error).message
      return undefined
    }

    if (!Array.isArray(edits) || edits.length === 0) return undefined
    const formatted = applyEdits(text, edits)
    return formatted === text ? undefined : formatted
  }

  /**
   * Diagnostics untuk satu berkas, menunggu sampai server sempat menjawab.
   *
   * Menunggu KONDISI, bukan durasi tetap. Language server menganalisis secara
   * asinkron dan kecepatannya bergantung ukuran proyek — `setTimeout(300)` akan
   * lulus di repo kecil dan diam-diam melewatkan temuan di repo besar, yang
   * justru tempat temuannya paling berharga.
   */
  async diagnose(file: string, cwd: string, timeoutMs: number): Promise<Diagnostic[] | undefined> {
    try {
      await this.#initialize(cwd)
    } catch (error) {
      this.#failure = (error as Error).message
      return undefined
    }

    const uri = pathToFileURL(file).href
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      return undefined
    }

    // `didOpen` sekali per berkas, `didChange` sesudahnya. Server menolak
    // didOpen kedua untuk URI yang sama, dan penolakan itu diam — diagnostics
    // berhenti diperbarui tanpa ada yang tahu.
    this.#sync(uri, file, text)

    this.#diagnostics.delete(uri)
    const deadline = Date.now() + timeoutMs
    while (!this.#diagnostics.has(uri) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return this.#diagnostics.get(uri)
  }

  stop(): void {
    this.#peer.stop()
  }
}

export interface TextEdit {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  newText: string
}

/**
 * Mengubah posisi baris/kolom LSP menjadi indeks di dalam string.
 *
 * Baris dan kolom LSP dihitung dari NOL, dan kolomnya adalah offset UTF-16 —
 * yang kebetulan sama dengan indeks string JavaScript, karena string JS memang
 * UTF-16. Itu satu-satunya alasan fungsi ini boleh sesederhana ini; kalau
 * suatu saat posisinya dihitung dalam titik kode, ia harus ditulis ulang.
 *
 * Posisi di luar berkas dijepit ke ujung, bukan dibiarkan menghasilkan `NaN`:
 * server yang salah hitung satu baris tidak boleh membuat berkas orang rusak.
 */
function offsetOf(text: string, line: number, character: number): number {
  let index = 0
  for (let current = 0; current < line; current += 1) {
    const next = text.indexOf("\n", index)
    if (next === -1) return text.length
    index = next + 1
  }
  const lineEnd = text.indexOf("\n", index)
  const limit = lineEnd === -1 ? text.length : lineEnd
  return Math.min(index + character, limit)
}

/**
 * Menerapkan TextEdit dari belakang ke depan.
 *
 * Urutannya menentukan. Spesifikasi LSP menjamin edit tidak saling tumpang
 * tindih tapi TIDAK menjamin urutannya, dan menerapkannya dari depan menggeser
 * setiap posisi sesudahnya sebanyak selisih panjang teks pengganti — hasilnya
 * berkas yang rusak dengan cara yang terlihat acak.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const line = b.range.start.line - a.range.start.line
    return line !== 0 ? line : b.range.start.character - a.range.start.character
  })

  let out = text
  for (const edit of sorted) {
    if (!edit?.range?.start || !edit.range.end || typeof edit.newText !== "string") continue
    const start = offsetOf(out, edit.range.start.line, edit.range.start.character)
    const end = offsetOf(out, edit.range.end.line, edit.range.end.character)
    if (end < start) continue
    out = out.slice(0, start) + edit.newText + out.slice(end)
  }
  return out
}

function languageOf(file: string): string {
  const extension = path.extname(file)
  const known: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".go": "go",
    ".rs": "rust",
    ".py": "python",
    ".json": "json",
  }
  return known[extension] ?? extension.replace(".", "")
}

const servers = new Map<string, LanguageServer>()

export function stopAllLanguageServers(): void {
  for (const server of servers.values()) server.stop()
  servers.clear()
}

/** Batas menunggu satu berkas. Melewatinya berarti "belum tahu", bukan "bersih". */
const DIAGNOSE_TIMEOUT = 5_000

/**
 * Diagnostics untuk berkas yang baru saja disunting, atau `undefined`.
 *
 * `undefined` berarti **tidak tahu** — tidak ada server untuk bahasa ini, atau
 * ia belum sempat menjawab. Itu SENGAJA dibedakan dari array kosong, yang
 * berarti server sudah menjawab dan berkasnya bersih. Menyamakan keduanya akan
 * membuat "belum diperiksa" terbaca sebagai "tidak ada masalah", dan itu
 * kebohongan yang paling mahal di antara semua yang mungkin di sini.
 */
export async function diagnoseFile(
  config: Config,
  cwd: string,
  file: string,
): Promise<Diagnostic[] | undefined> {
  for (const [id, entry] of Object.entries(config.lsp)) {
    if (entry.enabled === false) continue
    const server = serverFor(id, entry, cwd)
    if (!server.handles(file)) continue
    return await server.diagnose(file, cwd, DIAGNOSE_TIMEOUT)
  }
  return undefined
}

/**
 * Satu proses per server, dipakai bersama oleh diagnostics dan formatter.
 *
 * Menjalankan dua proses untuk satu bahasa berarti membayar dua kali indexing
 * proyek — pada repo besar itu bukan pemborosan kecil, dan keduanya toh
 * menanyakan hal ke berkas yang sama.
 */
function serverFor(id: string, entry: Config["lsp"][string], cwd: string): LanguageServer {
  /*
   * Dikunci pada id DAN perintahnya, bukan id saja.
   *
   * Dengan id saja, mengubah `command` di config tidak berpengaruh apa pun:
   * proses lama tetap dipakai, dan yang terlihat adalah perubahan config yang
   * diam-diam tidak berlaku. Kalau perintahnya berubah, yang lama dihentikan —
   * membiarkannya hidup berarti dua language server untuk satu bahasa,
   * masing-masing mengindeks proyek yang sama.
   */
  const key = `${id} ${entry.command} ${entry.args.join("")}`
  const existing = servers.get(id)
  if (existing && existing.key === key) return existing
  existing?.stop()

  const server = new LanguageServer(id, {
    command: entry.command,
    args: entry.args,
    extensions: entry.extensions,
    cwd,
    key,
  })
  servers.set(id, server)
  return server
}

/**
 * Memformat berkas yang baru saja disunting, di tempat.
 *
 * Mengembalikan id server yang memformatnya, atau `undefined` kalau tidak ada
 * yang berubah — tidak ada server untuk bahasa ini, servernya tidak mendukung
 * format, formatnya dimatikan di config, atau berkasnya memang sudah rapi.
 *
 * # Kenapa hasilnya dilaporkan, bukan diam-diam
 *
 * Memformat berarti isi di disk TIDAK LAGI sama persis dengan yang ditulis
 * model. Konsekuensinya nyata dan bisa menggigit satu langkah kemudian: `edit`
 * mencocokkan string secara persis, jadi suntingan berikutnya terhadap baris
 * yang barusan diformat ulang akan gagal — dan tanpa laporan ini, kegagalan itu
 * tidak punya sebab yang terlihat.
 */
export async function formatFile(
  config: Config,
  cwd: string,
  file: string,
): Promise<string | undefined> {
  for (const [id, entry] of Object.entries(config.lsp)) {
    if (entry.enabled === false || entry.format === false) continue
    const server = serverFor(id, entry, cwd)
    if (!server.handles(file)) continue

    const formatted = await server.format(file, cwd, {
      tabSize: entry.tabSize,
      insertSpaces: entry.insertSpaces,
    })
    if (formatted === undefined) return undefined

    try {
      fs.writeFileSync(file, formatted)
    } catch {
      // Gagal menulis bukan alasan menjatuhkan giliran: yang hilang cuma
      // perapiannya, dan suntingan yang sudah berhasil tetap ada di disk.
      return undefined
    }
    return id
  }
  return undefined
}

/** Diagnostics jadi teks yang ditempelkan ke hasil tool. */
export function renderDiagnostics(file: string, found: Diagnostic[]): string {
  if (found.length === 0) return ""
  const lines = found
    .slice(0, 20)
    .map(
      (item) =>
        `  ${file}:${item.line}:${item.column} ${item.severity}: ${item.message}` +
        (item.source ? ` (${item.source})` : ""),
    )
  const more = found.length > 20 ? `\n  … and ${found.length - 20} more` : ""
  return `\n\n--- diagnostics (${found.length}) ---\n${lines.join("\n")}${more}`
}
