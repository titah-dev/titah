import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { accountServer, currentAccount } from "../account.ts"
import { dataDir } from "../paths.ts"
import type { Config } from "../schema.ts"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Menerbitkan satu halaman HTML ke dashboard akun, dan mengembalikan URL-nya.
 *
 * Terminal bagus untuk teks dan buruk untuk hampir semua hal lain. Tabel dengan
 * dua belas kolom, bagan, perbandingan berdampingan, penjelasan yang butuh
 * diklik — semuanya jadi lebih buruk saat dipaksa jadi baris ASCII. Tool ini
 * memberi model satu tempat lain untuk menaruh jawabannya.
 *
 * # Kenapa transport-nya meniru `webfetch`, bukan `tracking`
 *
 * `tracking.ts` tidak pernah melempar: ia mengembalikan `false` dan menulis
 * satu baris log, karena user tidak meminta heartbeat itu dan kegagalannya
 * bukan urusan mereka. Di sini kebalikannya — model MEMINTA URL, jadi diam
 * berarti berbohong. Setiap kegagalan jadi `ToolError`, dan setiap pesannya
 * menyebutkan dua hal yang dibutuhkan model untuk memutuskan langkah
 * berikutnya: apakah ada yang terkirim, dan apakah mencoba lagi aman.
 *
 * # Kenapa `mutates` dibiarkan kosong
 *
 * `mutates` memicu snapshot repo lokal supaya `/undo` bekerja. Tool ini tidak
 * mengubah satu berkas pun di dalam cwd — salinan lokalnya ditulis ke dataDir,
 * di luar repo. Menyetelnya berarti menyalin seluruh repo setiap kali model
 * menerbitkan halaman, tanpa ada yang bisa di-undo. Jangan "perbaiki" ini.
 */

/**
 * Sama dengan `TRANSCRIPT_CAP` di `tracking.ts`, dan itu disengaja: satu angka
 * untuk "hal terbesar yang dikirim CLI", bukan dua yang lama-lama melenceng.
 */
const MAX_BODY_BYTES = 512 * 1024

/** 20 detik, bukan 10 seperti tracking — payload-nya dua orde lebih besar. */
const TIMEOUT_MS = 20_000

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe("Short title. Shown in the dashboard and as the browser tab title."),
  body: z
    .string()
    .min(1)
    .describe(
      "One complete, self-contained HTML document: <!doctype html> through </html>, " +
        "with every style in a <style> tag and every script in a <script> tag. " +
        "Scripts from cdn.jsdelivr.net, unpkg.com and cdnjs.cloudflare.com load; " +
        "nothing else does, and the page cannot make network requests of its own. " +
        "Maximum 512 KiB.",
    ),
  slug: z
    .string()
    .max(32)
    .optional()
    .describe(
      "Revise an existing page instead of publishing a new one. Pass the slug a " +
        "previous artifact call returned. Omit it to create a new page.",
    ),
})

interface PublishResponse {
  slug: string
  title: string
  visibility: string
  version: number
  version_count: number
  byte_size: number
  url: string
  share_url: string | null
  unchanged: boolean
}

/**
 * Server yang benar-benar dihubungi.
 *
 * `account.server` dan bukan `accountServer(config)`: token dicetak UNTUK satu
 * server tertentu, dan dialog izin harus menyebut host yang sungguh dituju,
 * bukan host yang kebetulan tertulis di config.
 */
function targetServer(config: Config): string {
  return currentAccount()?.server ?? accountServer(config)
}

function byteLength(body: string): number {
  return Buffer.byteLength(body, "utf8")
}

/** Salinan lokal, supaya database server tidak pernah jadi satu-satunya salinan. */
function keepLocalCopy(slug: string, body: string): void {
  try {
    const dir = path.join(dataDir(), "artifacts")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${slug}.html`), body, "utf8")
  } catch {
    // Sengaja diam. Ini jaring pengaman, bukan bagian dari kontrak tool —
    // menerbitkan halaman sudah berhasil, dan menggagalkannya sekarang karena
    // disk penuh akan membuang hasil yang sudah ada di server.
  }
}

export type ArtifactReason = "ok" | "disabled" | "not-signed-in"

/**
 * Kenapa tool ini bisa atau tidak bisa dipakai — string, bukan boolean.
 *
 * Pola yang sama dengan `trackingReason()`: `doctor` harus bisa menyebut saklar
 * MANA yang mati, dan boolean hanya bisa bilang "tidak".
 */
export function artifactReason(config: Config): ArtifactReason {
  if (!config.artifacts.enabled) return "disabled"
  if (currentAccount() === undefined) return "not-signed-in"
  return "ok"
}

export const artifactTool: TitahTool<typeof inputSchema> = {
  name: "artifact",
  description:
    "Publish a self-contained HTML page to the user's Titah dashboard and get back a " +
    "URL they can open in a browser. Use this when the answer works better as a page " +
    "than as text in the terminal — a report, a chart, a table, an interactive " +
    "explainer. Published pages are PRIVATE to the signed-in user; only they can turn " +
    "on a public link, and only from the dashboard. Pass the slug from a previous call " +
    "to revise the same page instead of publishing a second one.",
  inputSchema,
  permission(input, ctx) {
    const server = targetServer(ctx.config)
    const kib = Math.ceil(byteLength(input.body) / 1024)
    return {
      kind: "network",
      title: input.slug
        ? `artifact: revise ${input.slug}`
        : `artifact: publish "${input.title.slice(0, 60)}"`,
      detail:
        `Publish ${kib} KiB of HTML to ${server} as "${input.title}".\n\n` +
        "This sends a document off your machine. It stays private to your account — " +
        "nobody else can open it until you turn on a share link in the dashboard.",
      pattern: `${server}/*`,
      subject: `${server}/api/v1/artifacts/`,
    }
  },
  async execute(input, ctx) {
    // Sakelar config diperiksa LEBIH DULU, urutan yang sama dengan
    // `artifactReason` supaya doctor dan tool tidak pernah menyebut sebab yang
    // berbeda untuk keadaan yang sama. Lagipula menyuruh `titah login` kepada
    // user yang sengaja mematikan fitur ini adalah saran yang salah: masuk
    // tidak akan mengubah apa pun.
    if (!ctx.config.artifacts.enabled) {
      throw new ToolError(
        "Publishing is turned off in this user's config (artifacts.enabled). " +
          "Nothing was sent. Show them the document in the terminal instead.",
      )
    }
    const account = currentAccount()
    if (account === undefined) {
      throw new ToolError(
        "Not signed in, so there is nowhere to publish to. Nothing was sent. " +
          "Ask the user to run `titah login`, then try again.",
      )
    }

    // Diperiksa di sini supaya unggahan yang pasti ditolak tidak pernah
    // meninggalkan mesin — dan supaya model mendapat kedua angkanya, yang
    // adalah satu-satunya hal yang membuatnya menulis halaman lebih kecil.
    const size = byteLength(input.body)
    if (size > MAX_BODY_BYTES) {
      throw new ToolError(
        `The document is ${Math.ceil(size / 1024)} KiB and the limit is ` +
          `${MAX_BODY_BYTES / 1024} KiB. Nothing was sent. Inline fewer assets, ` +
          "or split it into more than one page.",
      )
    }

    const endpoint = `${account.server}/api/v1/artifacts/`
    const host = new URL(account.server).host

    // Dua sinyal batal digabung, seperti webfetch: timeout milik tool, dan
    // pembatalan giliran milik user. Tanpa yang kedua, Esc tidak menghentikannya.
    const timer = new AbortController()
    const stop = setTimeout(() => timer.abort(), TIMEOUT_MS)
    const onAbort = () => timer.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: timer.signal,
        headers: {
          "content-type": "application/json",
          authorization: `${account.tokenType} ${account.token}`,
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          slug: input.slug ?? "",
          session_id: ctx.sessionID,
        }),
      })
    } catch (error) {
      if (ctx.signal.aborted) throw new ToolError("Cancelled.")
      if (timer.signal.aborted) {
        throw new ToolError(
          `No response from ${host} within ${TIMEOUT_MS} ms. The page may or may not ` +
            "have been published — check the dashboard before republishing. " +
            "Republishing the same body is safe: identical content never creates a " +
            "second version.",
        )
      }
      throw new ToolError(`Could not reach ${host}: ${(error as Error).message}. Nothing was published.`)
    } finally {
      clearTimeout(stop)
      ctx.signal.removeEventListener("abort", onAbort)
    }

    if (!response.ok) throw await refusal(response, host, input.slug)

    const published = (await response.json()) as PublishResponse
    keepLocalCopy(published.slug, input.body)

    const action = published.unchanged
      ? "unchanged"
      : published.version === 1
        ? "published"
        : `updated (v${published.version})`

    const lines = [
      published.unchanged
        ? `Already published, unchanged: ${published.title}`
        : `Published: ${published.title}`,
      `Open: ${published.url}`,
      `Visibility: ${published.visibility === "link" ? "public link is on" : `private — only ${account.user.email} can open it. A public share link can be turned on from the page above.`}`,
      `Slug: ${published.slug} — pass slug="${published.slug}" to this tool to revise ` +
        "this page instead of publishing a second one.",
      `Size: ${Math.ceil(published.byte_size / 1024)} KiB, version ${published.version} of ${published.version_count}.`,
    ]

    return {
      // URL yang diberikan ke model adalah URL DASHBOARD, bukan origin artifact
      // mentah: yang mentah kedaluwarsa dalam hitungan menit, sedangkan halaman
      // dashboard permanen dan di sanalah tombol share berada.
      title: `artifact ${action}: ${published.title.slice(0, 60)}`,
      output: lines.join("\n"),
      metadata: {
        slug: published.slug,
        version: published.version,
        bytes: published.byte_size,
        url: published.url,
        unchanged: published.unchanged,
      },
    }
  },
}

/**
 * Menerjemahkan penolakan server jadi kalimat yang berguna bagi model.
 *
 * Setiap cabang menjawab dua pertanyaan yang sama: apakah ada yang terkirim,
 * dan apa yang harus dilakukan berikutnya. "HTTP 413" tidak menjawab keduanya.
 */
async function refusal(response: Response, host: string, slug?: string): Promise<ToolError> {
  let detail = ""
  try {
    const body = (await response.json()) as { detail?: string; error_description?: string }
    detail = body.detail ?? body.error_description ?? ""
  } catch {
    detail = (await response.text().catch(() => "")).slice(0, 200)
  }

  switch (response.status) {
    case 401:
      return new ToolError(
        `${host} rejected the token (401). Nothing was published. The session may have ` +
          "expired — ask the user to run `titah login` again.",
      )
    case 403:
      return new ToolError(
        `${host} refused (403): ${detail || "forbidden"}. Nothing was published. ` +
          "Turning on a public link is something the user does in the dashboard, " +
          "not something this tool can do.",
      )
    case 404:
      return new ToolError(
        slug === undefined
          ? `${host} has no artifacts endpoint (404). Nothing was published.`
          : `No artifact with slug "${slug}" on this account. Nothing was published. ` +
            "Publish again without a slug to create a new page.",
      )
    case 409:
    case 413:
      return new ToolError(`${detail} Nothing was published.`)
    case 429:
      return new ToolError(
        `Rate limited by ${host}: ${detail || "too many publishes"}. Nothing was ` +
          "published. Wait before trying again.",
      )
    default:
      return new ToolError(
        `${host} answered HTTP ${response.status}: ${detail || "(no body)"}. ` +
          "Nothing was published.",
      )
  }
}
