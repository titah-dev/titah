import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Membaca satu URL (gap 6 di docs/gap-analysis.md).
 *
 * Tanpa ini agent hanya tahu apa yang ada di dalam repo dan apa yang ada di
 * bobot modelnya — dan yang kedua punya tanggal kedaluwarsa. Ia tidak bisa
 * membaca dokumentasi library yang sedang dipakai, tidak bisa memeriksa
 * changelog sebelum menaikkan versi.
 */

const DEFAULT_MAX_BYTES = 128 * 1024
const DEFAULT_TIMEOUT = 20_000
const MAX_TIMEOUT = 60_000

const inputSchema = z.object({
  url: z.string().describe("Absolute http:// or https:// URL"),
  format: z
    .enum(["text", "raw"])
    .default("text")
    .describe(
      "text (default) strips HTML to readable text; raw returns the body as served. " +
        "Use raw for JSON, source files, and anything you need character-exact.",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Timeout in milliseconds, default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}`),
})

/**
 * Skema yang diterima — dan kenapa daftarnya putih, bukan hitam.
 *
 * `file:` adalah alasan utamanya: ia jalan pintas melewati `resolveInside`, satu
 * -satunya hal yang menjaga SELURUH tool berkas tetap di dalam cwd. `webfetch`
 * dengan `file:///etc/passwd` akan membatalkan penjagaan itu dari samping.
 * `data:` dan `ftp:` ikut ditolak karena tidak ada gunanya di sini, dan daftar
 * putih tidak perlu memperkirakan skema apa lagi yang akan ada besok.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

export function checkUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError(`Not a valid URL: ${raw}. Give an absolute http:// or https:// URL.`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new ToolError(
      `Refusing ${url.protocol} — webfetch only speaks http and https. ` +
        (url.protocol === "file:" ? "To read a local file use the read tool." : ""),
    )
  }
  return url
}

/**
 * HTML → teks yang layak dibaca model.
 *
 * Bukan parser: ia membuang yang jelas-jelas bukan isi, lalu merapikan spasi.
 * Halaman dokumentasi mentah sebagian besar adalah `<script>`, `<style>`, dan
 * atribut kelas — semuanya dibayar penuh oleh jendela konteks, dan tidak satu
 * pun berguna bagi model.
 *
 * Sengaja tidak memakai pustaka: satu dependensi lagi untuk pekerjaan yang
 * hasilnya toh diringkas model bukan pertukaran yang baik. Kalau nanti butuh
 * markdown yang setia, ganti fungsi INI, bukan pemanggilnya.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Batas blok jadi baris baru, supaya struktur dokumen tidak hilang jadi
    // satu paragraf raksasa.
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim()
}

/** Potong pada batas byte, dan KATAKAN kalau memotong. */
function clamp(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  // Byte terakhir bisa memotong satu karakter multi-byte di tengah; TextDecoder
  // menandainya U+FFFD dan itu satu-satunya karakter rusak yang mungkin muncul.
  return { text: cut.replace(/�$/, ""), truncated: true }
}

export const webfetchTool: TitahTool<typeof inputSchema> = {
  name: "webfetch",
  description:
    "Fetch a URL and return its content. HTML is stripped to readable text by default. " +
    "Use this to read documentation, changelogs, and issue threads — do not guess what " +
    "a page says. Truncates large responses and tells you when it did.",
  inputSchema,
  permission(input) {
    return {
      kind: "network",
      title: `webfetch: ${input.url.slice(0, 80)}`,
      // Detail memuat URL LENGKAP, tidak dipotong: yang dinilai user saat
      // memberi izin adalah ke mana permintaan itu pergi, dan host bisa
      // bersembunyi di belakang path yang panjang.
      detail: `Fetch ${input.url}\n\nThis sends a request outside your machine.`,
      pattern: `${safeOrigin(input.url)}/*`,
      // Dinilai aturan setingkat argumen: `network(https://docs.*)`.
      subject: input.url,
    }
  },
  async execute(input, ctx) {
    const url = checkUrl(input.url)
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    // Dua sinyal batal digabung: timeout milik tool ini, dan pembatalan giliran
    // milik user. Tanpa yang kedua, Esc tidak menghentikan fetch yang lambat.
    const timer = new AbortController()
    const stop = setTimeout(() => timer.abort(), timeout)
    const onAbort = () => timer.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(url, {
        signal: timer.signal,
        redirect: "follow",
        headers: { "user-agent": "titah/0.1 (+https://github.com/titah-dev/titah)" },
      })

      const body = await response.text()
      const type = response.headers.get("content-type") ?? ""
      const isHtml = type.includes("html") || /^\s*<(!doctype|html)/i.test(body)
      const rendered = input.format === "raw" || !isHtml ? body : htmlToText(body)
      const { text, truncated } = clamp(rendered, DEFAULT_MAX_BYTES)

      const header = [
        `${response.status} ${response.statusText}`.trim(),
        type === "" ? undefined : type,
        // Status non-2xx TIDAK dilempar: badan 404 dan 500 sering memuat pesan
        // yang justru dicari model. Statusnya disebut, bukan disembunyikan.
        response.ok ? undefined : "(non-2xx — the body below is the error page)",
      ]
        .filter(Boolean)
        .join(" · ")

      return {
        title: `webfetch ${url.host}${truncated ? " (truncated)" : ""}`,
        output:
          `${header}\n${"-".repeat(40)}\n${text}` +
          (truncated ? `\n\n[truncated at ${DEFAULT_MAX_BYTES} bytes]` : ""),
        metadata: { status: response.status, truncated, host: url.host },
      }
    } catch (error) {
      if (ctx.signal.aborted) throw new ToolError("Cancelled.")
      if (timer.signal.aborted) {
        throw new ToolError(`No response from ${url.host} within ${timeout} ms.`)
      }
      throw new ToolError(`Could not fetch ${url.host}: ${(error as Error).message}`)
    } finally {
      clearTimeout(stop)
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
}

/**
 * Origin untuk pola allowlist, dan tidak pernah melempar.
 *
 * `permission()` berjalan SEBELUM `execute`, jadi ia bisa menerima URL yang
 * tidak valid. Melempar di sana akan menggagalkan giliran dengan pesan tentang
 * pembuatan pola, bukan tentang URL-nya — `checkUrl` di `execute` yang berhak
 * memberi pesan itu.
 */
function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}
