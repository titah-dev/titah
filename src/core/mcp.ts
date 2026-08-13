import { z } from "zod"
import { RpcPeer, RpcError } from "./rpc.ts"
import { HttpTransport, NeedsAuthorization, type HttpTransportOptions } from "./mcp-http.ts"
import { validToken } from "./mcp-oauth.ts"
import type { Config } from "./schema.ts"
import { ToolError, type TitahTool } from "./tool/types.ts"

/**
 * Klien MCP (Model Context Protocol): stdio dan HTTP remote.
 *
 * Ini gap terbesar Titah di `docs/gap-analysis.md`, dan sifatnya berbeda dari
 * gap lain: ia bukan satu kemampuan yang hilang, melainkan PINTU ke semua
 * kemampuan pihak ketiga. Selama tidak ada, setiap integrasi baru berarti
 * menulis tool di dalam Titah.
 *
 * # Dua transport, satu jalur di atasnya
 *
 * Yang berbeda antara stdio dan HTTP hanya bagaimana satu pesan JSON-RPC
 * berpindah tempat. Jabat tangan, penamaan tool, dan penanganan `isError`
 * identik — jadi keduanya disatukan di balik `Transport`, dan sisa berkas ini
 * tidak tahu yang mana yang sedang dipakai.
 *
 * Yang masih belum ada: `resources` dan `prompts`. Keduanya bisa menyusul lewat
 * transport yang sama. Menyatakan batas itu di sini lebih baik daripada
 * membangun setengah dari segalanya — yang setengah jadi terlihat sama dengan
 * yang jadi, sampai dipakai.
 */

const PROTOCOL_VERSION = "2024-11-05"

export interface McpTool {
  /** Nama yang dilihat model: `<server>_<tool>`. */
  name: string
  serverId: string
  remoteName: string
  description: string
  inputSchema: unknown
}

interface ToolsListResult {
  tools?: { name?: string; description?: string; inputSchema?: unknown }[]
}

interface CallResult {
  content?: { type?: string; text?: string }[]
  isError?: boolean
}

/**
 * Satu server MCP: prosesnya, jabat tangannya, dan tool yang ia tawarkan.
 *
 * Jabat tangan dilakukan SEKALI dan hasilnya disimpan. `tools/list` pada server
 * yang lambat bisa memakan detik, dan mengulanginya tiap giliran berarti
 * membayar itu berulang untuk daftar yang praktis tidak pernah berubah.
 */
/**
 * Yang dibutuhkan `McpServer` dari sebuah transport, dan tidak lebih.
 *
 * `RpcPeer` (stdio) dan `HttpTransport` (remote) sama-sama sudah berbentuk ini
 * tanpa pembungkus — itu bukan kebetulan, melainkan alasan keduanya bisa
 * disatukan tanpa lapisan tambahan yang harus ikut diuji.
 */
export interface Transport {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  stop(): void
}

export class McpServer {
  #peer: Transport
  #tools: McpTool[] | undefined
  #failure: string | undefined
  readonly id: string
  readonly remote: boolean

  constructor(id: string, transport: Transport, remote = false) {
    this.id = id
    this.#peer = transport
    this.remote = remote
  }

  /** Server stdio: satu proses anak, satu objek JSON per baris. */
  static stdio(
    id: string,
    options: { command: string; args: string[]; cwd: string; env?: Record<string, string> },
  ): McpServer {
    return new McpServer(
      id,
      new RpcPeer({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}),
        // MCP memakai satu objek JSON per baris, bukan header Content-Length
        // ala LSP. Satu-satunya perbedaan antara keduanya di lapisan itu.
        framing: "ndjson",
      }),
    )
  }

  /** Server remote: satu endpoint HTTP, jawaban JSON atau aliran SSE. */
  static http(id: string, options: HttpTransportOptions): McpServer {
    return new McpServer(id, new HttpTransport(options), true)
  }

  get failure(): string | undefined {
    return this.#failure
  }

  /**
   * Jabat tangan lalu ambil daftar tool.
   *
   * TIDAK melempar. Server MCP dipasang user dan bisa rusak karena alasan yang
   * sama sekali tidak berhubungan dengan Titah — biner hilang, kunci API
   * kedaluwarsa, versi protokol berbeda. Satu server rusak tidak boleh
   * menjatuhkan giliran; ia kehilangan tool-nya, dan alasannya dicatat supaya
   * `titah doctor` bisa menyebutkannya.
   */
  async connect(): Promise<McpTool[]> {
    if (this.#tools) return this.#tools
    if (this.#failure !== undefined) return []

    try {
      await this.#peer.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "titah", version: "0.1.0" },
      })
      this.#peer.notify("notifications/initialized")

      const result = (await this.#peer.request("tools/list")) as ToolsListResult
      this.#tools = (result.tools ?? [])
        .filter((tool): tool is { name: string } & typeof tool => typeof tool.name === "string")
        .map((tool) => ({
          // Diberi awalan nama server. Dua server yang sama-sama menawarkan
          // `search` adalah kejadian biasa, dan tanpa awalan yang kedua akan
          // menimpa yang pertama tanpa ada yang tahu.
          name: `${this.id}_${tool.name}`,
          serverId: this.id,
          remoteName: tool.name,
          description: tool.description ?? `${tool.name} (from MCP server ${this.id})`,
          inputSchema: tool.inputSchema,
        }))
      return this.#tools
    } catch (error) {
      /*
       * 401 diberi kalimatnya sendiri.
       *
       * "HTTP 401" tidak memberi tahu apa pun yang bisa ditindaklanjuti. Yang
       * dibutuhkan user adalah perintah berikutnya, dan hanya di sini kita tahu
       * server mana yang dimaksud.
       */
      if (error instanceof NeedsAuthorization) {
        this.#failure = `${error.message} Run \`titah mcp login ${this.id}\`.`
        return []
      }
      this.#failure = error instanceof RpcError ? error.message : String(error)
      return []
    }
  }

  async call(remoteName: string, args: unknown): Promise<string> {
    const result = (await this.#peer.request("tools/call", {
      name: remoteName,
      arguments: args ?? {},
    })) as CallResult

    const text = (result.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")

    // `isError` adalah cara MCP mengatakan "tool-nya jalan dan hasilnya gagal",
    // yang berbeda dari "panggilannya sendiri gagal". Dibedakan supaya model
    // tahu apakah yang salah permintaannya atau dunianya.
    if (result.isError) throw new ToolError(text === "" ? "The MCP tool reported an error." : text)
    return text === "" ? "(the tool returned no text content)" : text
  }

  stop(): void {
    this.#peer.stop()
  }
}

const servers = new Map<string, McpServer>()

/** Server yang dikonfigurasi, dibuat malas dan dipakai ulang. */
export function mcpServers(config: Config, cwd: string): McpServer[] {
  const out: McpServer[] = []
  for (const [id, entry] of Object.entries(config.mcp)) {
    if (entry.enabled === false) continue
    let server = servers.get(id)
    if (!server) {
      server =
        entry.url === undefined
          ? McpServer.stdio(id, {
              command: entry.command as string,
              args: entry.args,
              cwd,
              ...(entry.env ? { env: entry.env } : {}),
            })
          : McpServer.http(id, {
              url: entry.url,
              ...(entry.headers ? { headers: entry.headers } : {}),
              /*
               * Token dibaca SETIAP permintaan, bukan sekali saat server
               * dibuat. Sesi Titah berjalan berjam-jam sementara token OAuth
               * hidup beberapa menit — membacanya sekali berarti permintaan
               * pertama berhasil dan sisanya 401, kegagalan yang muncul di
               * tengah pekerjaan tanpa sebab yang terlihat.
               */
              ...(entry.oauth
                ? {
                    authorization: async () => {
                      const token = validToken(id)
                      return token ? `${token.tokenType} ${token.accessToken}` : undefined
                    },
                  }
                : {}),
            })
      servers.set(id, server)
    }
    out.push(server)
  }
  return out
}

export function stopAllMcpServers(): void {
  for (const server of servers.values()) server.stop()
  servers.clear()
}

/**
 * Skema masukan tool MCP → skema Zod.
 *
 * Sengaja LONGGAR: `z.object({}).passthrough()` menerima apa pun dan
 * meneruskannya. Menerjemahkan JSON Schema sembarang ke Zod dengan setia adalah
 * proyek tersendiri, dan terjemahan yang tidak setia justru MENOLAK panggilan
 * yang sebenarnya sah — kegagalan yang muncul sebagai "tool-nya rusak" padahal
 * yang rusak penerjemahnya.
 *
 * Validasi sesungguhnya tetap terjadi, di tempat yang memang memilikinya:
 * server MCP itu sendiri. Deskripsi skema aslinya ikut dikirim ke model lewat
 * `description`, jadi model tetap tahu bentuk yang diharapkan.
 */
function looseSchema(): z.ZodType {
  return z.object({}).passthrough()
}

function describe(tool: McpTool): string {
  const schema = tool.inputSchema
  const shape =
    schema && typeof schema === "object"
      ? `\n\nInput schema (JSON Schema):\n${JSON.stringify(schema)}`
      : ""
  return `${tool.description}${shape}`
}

/**
 * Tool MCP dibungkus jadi tool Titah.
 *
 * Semuanya memakai sumbu izin `mcp`, dan itu sumbu SENDIRI karena tool MCP
 * adalah kode yang tidak ditulis Titah dan tidak bisa diklasifikasikan Titah.
 * Sebuah server MCP boleh menulis berkas, memanggil API berbayar, atau
 * keduanya, dan tidak ada di antara `edit`/`write`/`bash`/`network` yang jujur
 * menggambarkan itu. Memaksanya ke salah satu berarti user memberi izin untuk
 * hal yang berbeda dari yang sebenarnya terjadi.
 */
export function mcpToolDefinition(server: McpServer, tool: McpTool): TitahTool {
  const inputSchema = looseSchema()
  return {
    name: tool.name,
    description: describe(tool),
    inputSchema,
    mutates: true,
    permission(input) {
      return {
        kind: "mcp",
        title: `${tool.serverId}: ${tool.remoteName}`,
        detail:
          `MCP server "${tool.serverId}" will run its tool "${tool.remoteName}" with:\n\n` +
          `${JSON.stringify(input, null, 2)}\n\n` +
          "This is third-party code. Titah cannot see what it does.",
        pattern: `mcp ${tool.serverId}`,
        subject: `${tool.serverId}/${tool.remoteName}`,
      }
    },
    async execute(input) {
      try {
        const text = await server.call(tool.remoteName, input)
        return { title: `${tool.serverId}: ${tool.remoteName}`, output: text }
      } catch (error) {
        if (error instanceof ToolError) throw error
        throw new ToolError(`${tool.serverId}/${tool.remoteName} failed: ${(error as Error).message}`)
      }
    },
  } as TitahTool
}

/** Semua tool MCP yang siap dipakai giliran ini, plus server yang gagal. */
export async function loadMcpTools(
  config: Config,
  cwd: string,
): Promise<{ tools: TitahTool[]; failures: { id: string; reason: string }[] }> {
  const tools: TitahTool[] = []
  const failures: { id: string; reason: string }[] = []

  // Berurutan, bukan paralel. Server MCP menyalakan proses, dan menyalakan
  // enam sekaligus pada mesin yang sedang sibuk membuat semuanya lambat
  // bersamaan — sementara jumlahnya kecil dan hasilnya di-cache.
  for (const server of mcpServers(config, cwd)) {
    const listed = await server.connect()
    for (const tool of listed) tools.push(mcpToolDefinition(server, tool))
    if (server.failure !== undefined) failures.push({ id: server.id, reason: server.failure })
  }
  return { tools, failures }
}
