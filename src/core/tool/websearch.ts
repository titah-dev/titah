import { z } from "zod"
import type { Search } from "../schema.ts"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Mencari di web (gap 6 di docs/gap-analysis.md).
 *
 * Pasangan `webfetch`: yang itu membaca alamat yang sudah diketahui, yang ini
 * mencari alamatnya. Pesan error yang tidak dikenali model adalah kasus paling
 * sering, dan satu-satunya jalan keluar sebelum ini adalah menebak.
 */

const DEFAULT_TIMEOUT = 20_000
const MAX_RESULTS = 10

const inputSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_RESULTS)
    .optional()
    .describe(`Number of results, default 5, max ${MAX_RESULTS}`),
})

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * DuckDuckGo lewat endpoint HTML-nya. Tanpa kunci, dan karena itu jadi bawaan.
 *
 * Ia juga yang paling rapuh di antara ketiganya: ia mengurai HTML milik orang
 * lain, dan HTML itu boleh berubah kapan saja tanpa memberi tahu siapa pun.
 * Kerapuhan itu dinyatakan — di deskripsi tool, di `titah doctor`, dan di sini —
 * karena backend yang diam-diam berhenti bekerja lebih buruk daripada backend
 * yang menyatakan dirinya rapuh.
 *
 * Kalau suatu hari ia berhenti mengembalikan hasil, yang benar adalah pindah ke
 * `brave` atau `tavily`, bukan menambal regex ini terus-menerus.
 */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const anchor = /<a[^>]+class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const table = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  for (const pattern of [anchor, table]) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1]
      const title = decode(match[2] ?? "")
      if (!url || title === "" || !/^https?:/i.test(url)) continue
      if (hits.some((hit) => hit.url === url)) continue
      hits.push({ title, url, snippet: "" })
    }
    if (hits.length > 0) break
  }
  return hits
}

async function ddg(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const response = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (compatible; titah/0.1)",
    },
    body: new URLSearchParams({ q: query }).toString(),
  })
  if (!response.ok) throw new ToolError(`DuckDuckGo returned ${response.status}.`)
  return parseDuckDuckGo(await response.text())
}

async function brave(query: string, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search")
  url.searchParams.set("q", query)
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json", "x-subscription-token": key },
  })
  if (!response.ok) throw new ToolError(`Brave Search returned ${response.status}.`)
  const data = (await response.json()) as { web?: { results?: unknown[] } }
  return (data.web?.results ?? []).map((raw) => {
    const hit = raw as { title?: string; url?: string; description?: string }
    return { title: hit.title ?? "", url: hit.url ?? "", snippet: decode(hit.description ?? "") }
  })
}

async function tavily(query: string, key: string, signal: AbortSignal): Promise<SearchHit[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: MAX_RESULTS }),
  })
  if (!response.ok) throw new ToolError(`Tavily returned ${response.status}.`)
  const data = (await response.json()) as { results?: unknown[] }
  return (data.results ?? []).map((raw) => {
    const hit = raw as { title?: string; url?: string; content?: string }
    return { title: hit.title ?? "", url: hit.url ?? "", snippet: decode(hit.content ?? "") }
  })
}

/**
 * Backend yang butuh kunci mengatakannya SEBELUM permintaan dikirim.
 *
 * Aturan yang sama dengan `contextWindow`: yang tidak dinyatakan tidak ditebak,
 * dan tidak diam. Tanpa ini, user yang memilih `brave` tanpa kunci akan menerima
 * 401 dari pihak ketiga sebagai pesan errornya.
 */
export function searchBackend(config: Search): { needsKey: boolean; hasKey: boolean } {
  const needsKey = config.backend !== "ddg"
  return { needsKey, hasKey: (config.apiKey ?? "") !== "" }
}

export const websearchTool: TitahTool<typeof inputSchema> = {
  name: "websearch",
  description:
    "Search the web and get back titles, URLs, and snippets. Use it when you do not " +
    "know which page to read — then read it with webfetch. Snippets alone are never " +
    "enough to answer from; they are there to help you pick a URL.",
  inputSchema,
  permission(input) {
    return {
      kind: "network",
      title: `websearch: ${input.query.slice(0, 60)}`,
      detail: `Search the web for:\n\n${input.query}\n\nThis sends your query to a third-party search engine.`,
      pattern: "websearch",
    }
  },
  async execute(input, ctx) {
    const config = ctx.config.search
    const { needsKey, hasKey } = searchBackend(config)
    if (needsKey && !hasKey) {
      throw new ToolError(
        `Search backend "${config.backend}" needs an API key, and none is set. ` +
          `Add search.apiKey to the config (prefer \${env:VAR_NAME}), or switch ` +
          `search.backend to "ddg", which needs no key.`,
      )
    }

    const timer = new AbortController()
    const stop = setTimeout(() => timer.abort(), DEFAULT_TIMEOUT)
    const onAbort = () => timer.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const key = config.apiKey ?? ""
      const hits =
        config.backend === "brave"
          ? await brave(input.query, key, timer.signal)
          : config.backend === "tavily"
            ? await tavily(input.query, key, timer.signal)
            : await ddg(input.query, timer.signal)

      const limited = hits.slice(0, input.limit ?? 5)
      if (limited.length === 0) {
        return {
          title: `websearch: no results`,
          // Nol hasil dari `ddg` ambigu — bisa berarti tidak ada, bisa berarti
          // HTML-nya berubah. Ambiguitas itu disebut, bukan disamarkan jadi
          // "tidak ditemukan", karena tindakan user berbeda untuk keduanya.
          output:
            `No results for "${input.query}".` +
            (config.backend === "ddg"
              ? "\n\nNote: the ddg backend scrapes HTML, so zero results can also mean the " +
                "page layout changed. If searches keep coming back empty, switch " +
                'search.backend to "brave" or "tavily".'
              : ""),
          metadata: { backend: config.backend, count: 0 },
        }
      }

      const rendered = limited
        .map(
          (hit, index) =>
            `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`,
        )
        .join("\n\n")

      return {
        title: `websearch: ${limited.length} results (${config.backend})`,
        output: `${rendered}\n\nRead a page with webfetch before answering from it.`,
        metadata: { backend: config.backend, count: limited.length },
      }
    } catch (error) {
      if (ctx.signal.aborted) throw new ToolError("Cancelled.")
      if (timer.signal.aborted) throw new ToolError(`Search timed out after ${DEFAULT_TIMEOUT} ms.`)
      throw error instanceof ToolError ? error : new ToolError(`Search failed: ${(error as Error).message}`)
    } finally {
      clearTimeout(stop)
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}
