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
  #failure: string | undefined

  constructor(
    id: string,
    options: { command: string; args: string[]; extensions: string[]; cwd: string },
  ) {
    this.id = id
    this.extensions = options.extensions
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
      await this.#peer.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: path.basename(cwd) }],
        capabilities: {
          textDocument: { publishDiagnostics: { relatedInformation: false } },
        },
      })
      this.#peer.notify("initialized", {})
    })()
    return this.#ready
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
    if (this.#seen.has(uri)) {
      this.#peer.notify("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text }],
      })
    } else {
      this.#seen.add(uri)
      this.#peer.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageOf(file), version: 1, text },
      })
    }

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
    let server = servers.get(id)
    if (!server) {
      server = new LanguageServer(id, {
        command: entry.command,
        args: entry.args,
        extensions: entry.extensions,
        cwd,
      })
      servers.set(id, server)
    }
    if (!server.handles(file)) continue
    return await server.diagnose(file, cwd, DIAGNOSE_TIMEOUT)
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
