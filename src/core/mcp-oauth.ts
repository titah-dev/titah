import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { dataDir } from "./paths.ts"

/**
 * OAuth untuk server MCP remote.
 *
 * Alirannya adalah **authorization code + PKCE lewat loopback**, bukan device
 * flow yang dipakai akun Titah sendiri. Perbedaannya bukan selera: spesifikasi
 * otorisasi MCP menetapkan bentuk ini, dan server pihak ketiga tidak akan
 * menerima yang lain. Yang bisa dipilih Titah hanyalah bersikap jujur ketika
 * loopback tidak mungkin — lihat `authorize`.
 *
 * # Yang disimpan, dan di mana
 *
 * Token MCP TIDAK ikut `account.json` maupun `auth.json`. Tiga jenis rahasia
 * dengan tiga masa hidup dan tiga pemiliknya sendiri: kunci provider milik
 * user, identitas Titah milik user, dan token ini milik SERVER PIHAK KETIGA.
 * Menyatukannya berarti `titah auth remove` bisa menghapus hal yang tidak
 * disebut namanya.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export const mcpAuthFile = (): string => path.join(dataDir(), "mcp-auth.json")

export class OAuthError extends Error {}

export interface StoredToken {
  accessToken: string
  tokenType: string
  /** Epoch ms. Tidak ada artinya kalau server memilih token tanpa kedaluwarsa. */
  expiresAt?: number
  refreshToken?: string
  /** Server yang menerbitkannya — token tidak berarti apa-apa di tempat lain. */
  issuer: string
  clientId: string
  scope?: string
}

type Store = Record<string, StoredToken>

export function readTokens(): Store {
  const file = mcpAuthFile()
  if (!fs.existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" ? (parsed as Store) : {}
  } catch {
    // Berkas rusak tidak menjatuhkan sesi: yang hilang hanya status login, dan
    // satu `titah mcp login` memperbaikinya.
    return {}
  }
}

export function writeToken(serverId: string, token: StoredToken): void {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const store = readTokens()
  store[serverId] = token

  // Tulis-lalu-rename dengan mode diset SEBELUM rename, sama seperti auth.json:
  // token tidak boleh sekejap pun bisa dibaca proses lain.
  const tmp = path.join(dir, `.mcp-auth.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE })
  fs.chmodSync(tmp, FILE_MODE)
  fs.renameSync(tmp, mcpAuthFile())
}

export function forgetToken(serverId: string): boolean {
  const store = readTokens()
  if (!(serverId in store)) return false
  delete store[serverId]
  fs.writeFileSync(mcpAuthFile(), `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE })
  return true
}

/** Token yang masih berlaku, dengan margin supaya tidak kedaluwarsa di tengah jalan. */
export function validToken(serverId: string, now = Date.now()): StoredToken | undefined {
  const token = readTokens()[serverId]
  if (!token) return undefined
  if (token.expiresAt !== undefined && token.expiresAt - 30_000 <= now) return undefined
  return token
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * PKCE S256, bukan `plain`.
 *
 * `plain` mengirim verifier apa adanya di URL otorisasi, tempat ia berakhir di
 * riwayat browser dan log server. Seluruh gunanya PKCE adalah bahwa yang
 * terlihat di sana tidak cukup untuk menukar kode.
 */
export function createPkce(): Pkce {
  const verifier = crypto.randomBytes(32).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

// ---------------------------------------------------------------------------
// Penemuan
// ---------------------------------------------------------------------------

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
}

/**
 * Menemukan authorization server dari URL sumber daya MCP.
 *
 * Dua langkah, dan yang pertama boleh gagal. `/.well-known/oauth-protected-resource`
 * memberi tahu SIAPA yang menerbitkan token untuk sumber daya ini; kalau tidak
 * ada, spesifikasi mengizinkan menganggap sumber dayanya sendiri sebagai
 * issuer. Melewatkan langkah kedua tidak boleh: tanpa metadata authorization
 * server, endpoint-nya hanya bisa ditebak, dan endpoint tebakan yang salah
 * gagal sebagai "404" alih-alih "server ini tidak mendukung OAuth".
 */
export async function discover(
  resourceUrl: string,
  options: { metadataUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<AuthServerMetadata> {
  const call = options.fetchImpl ?? fetch
  const base = new URL(resourceUrl)
  let issuer = `${base.protocol}//${base.host}`

  const resourceMetadataUrl =
    options.metadataUrl ?? `${base.protocol}//${base.host}/.well-known/oauth-protected-resource`

  try {
    const response = await call(resourceMetadataUrl)
    if (response.ok) {
      const body = (await response.json()) as { authorization_servers?: string[] }
      const first = body.authorization_servers?.[0]
      if (typeof first === "string" && first !== "") issuer = first
    }
  } catch {
    // Sumber daya yang tidak mengumumkan metadata bukan kesalahan — ia hanya
    // berarti issuer-nya dirinya sendiri.
  }

  const trimmed = issuer.replace(/\/+$/, "")
  for (const candidate of [
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${trimmed}/.well-known/openid-configuration`,
  ]) {
    try {
      const response = await call(candidate)
      if (!response.ok) continue
      const metadata = (await response.json()) as AuthServerMetadata
      if (metadata.authorization_endpoint && metadata.token_endpoint) return metadata
    } catch {
      continue
    }
  }

  throw new OAuthError(
    `No OAuth metadata at ${trimmed}. The server may not support OAuth — ` +
      'if it just needs a static token, put it in "headers" instead and leave "oauth" off.',
  )
}

/**
 * Mendaftarkan klien secara dinamis (RFC 7591).
 *
 * Dibutuhkan karena tidak ada yang bisa mendaftarkan Titah lebih dulu di server
 * yang belum pernah dilihat siapa pun. Server yang tidak mendukungnya harus
 * diberi `client_id` lewat config, dan pesan kegagalannya menyebut itu.
 */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new OAuthError(
      "This authorization server does not offer dynamic client registration, " +
        "so Titah cannot register itself. Ask its operator for a client_id.",
    )
  }

  const call = fetchImpl ?? fetch
  const response = await call(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Titah",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })

  if (!response.ok) {
    throw new OAuthError(`Client registration failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { client_id?: string }
  if (typeof body.client_id !== "string") throw new OAuthError("Registration returned no client_id.")
  return body.client_id
}

// ---------------------------------------------------------------------------
// Aliran
// ---------------------------------------------------------------------------

export function authorizationUrl(options: {
  metadata: AuthServerMetadata
  clientId: string
  redirectUri: string
  pkce: Pkce
  state: string
  resource: string
  scope?: string
}): string {
  const url = new URL(options.metadata.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", options.clientId)
  url.searchParams.set("redirect_uri", options.redirectUri)
  url.searchParams.set("code_challenge", options.pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", options.state)
  // Menyebut sumber daya yang dituju supaya token yang terbit tidak berlaku
  // lebih luas dari yang dibutuhkan — dan supaya server yang melayani beberapa
  // sumber daya tahu yang mana.
  url.searchParams.set("resource", options.resource)
  if (options.scope) url.searchParams.set("scope", options.scope)
  return url.href
}

export interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export async function exchangeCode(options: {
  metadata: AuthServerMetadata
  clientId: string
  redirectUri: string
  code: string
  verifier: string
  resource: string
  fetchImpl?: typeof fetch
}): Promise<StoredToken> {
  const call = options.fetchImpl ?? fetch
  const response = await call(options.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      code_verifier: options.verifier,
      resource: options.resource,
    }).toString(),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new OAuthError(`Token exchange failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`)
  }

  return toStored(
    (await response.json()) as TokenResponse,
    options.metadata.issuer,
    options.clientId,
  )
}

export async function refresh(options: {
  metadata: AuthServerMetadata
  token: StoredToken
  resource: string
  fetchImpl?: typeof fetch
}): Promise<StoredToken> {
  if (!options.token.refreshToken) throw new OAuthError("No refresh token was issued.")
  const call = options.fetchImpl ?? fetch

  const response = await call(options.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.token.refreshToken,
      client_id: options.token.clientId,
      resource: options.resource,
    }).toString(),
  })

  if (!response.ok) throw new OAuthError(`Refresh failed: HTTP ${response.status}`)

  const fresh = toStored(
    (await response.json()) as TokenResponse,
    options.metadata.issuer,
    options.token.clientId,
  )
  // Sebagian server tidak mengirim refresh token baru saat menyegarkan; yang
  // lama tetap berlaku. Membiarkannya kosong akan membuat penyegaran berikutnya
  // mustahil dan memaksa login ulang tanpa sebab.
  return fresh.refreshToken ? fresh : { ...fresh, refreshToken: options.token.refreshToken }
}

function toStored(body: TokenResponse, issuer: string, clientId: string): StoredToken {
  if (typeof body.access_token !== "string") throw new OAuthError("No access_token in the response.")
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "Bearer",
    ...(typeof body.expires_in === "number"
      ? { expiresAt: Date.now() + body.expires_in * 1000 }
      : {}),
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    issuer,
    clientId,
  }
}

// ---------------------------------------------------------------------------
// Loopback
// ---------------------------------------------------------------------------

export interface LoopbackHandle {
  redirectUri: string
  /** Menunggu redirect masuk; menolak kalau `state`-nya tidak cocok. */
  code: Promise<string>
  close(): void
}

/**
 * Server sekali-pakai untuk menerima redirect.
 *
 * Portnya diminta ke sistem (0), bukan dipilih. Port tetap akan bentrok dengan
 * apa pun yang kebetulan memakainya, dan kegagalannya muncul sebagai login yang
 * menggantung — bukan sebagai "port terpakai".
 */
export async function loopback(state: string): Promise<LoopbackHandle> {
  let settle: (code: string) => void
  let reject: (error: Error) => void
  const code = new Promise<string>((resolve, no) => {
    settle = resolve
    reject = no
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const got = url.searchParams.get("state")
    const error = url.searchParams.get("error")

    const reply = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(message)
    }

    if (error) {
      reply(400, `Authorization failed: ${error}`)
      return reject(new OAuthError(`The authorization server returned "${error}".`))
    }

    /*
     * `state` diperiksa SEBELUM kodenya dipakai.
     *
     * Tanpa pemeriksaan ini, siapa pun yang bisa membuat browser user membuka
     * satu URL bisa menyuntikkan kode otorisasi milik akun LAIN ke sesi ini —
     * dan Titah akan menyimpannya sebagai token user.
     */
    if (got !== state) {
      reply(400, "State mismatch. This redirect did not come from the sign-in Titah started.")
      return reject(new OAuthError("State mismatch — the redirect did not match this sign-in."))
    }

    const value = url.searchParams.get("code")
    if (!value) {
      reply(400, "No authorization code in the redirect.")
      return reject(new OAuthError("The redirect carried no authorization code."))
    }

    reply(200, "Signed in. You can close this tab and return to Titah.")
    settle(value)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new OAuthError("Could not open a loopback port for the redirect.")
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    code,
    close: () => server.close(),
  }
}

/** Membuka browser, dan melaporkan apakah ia sungguh terbuka. */
export function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("hex")
}
