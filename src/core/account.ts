import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { accountFile, dataDir } from "./paths.ts"
import type { Config } from "./schema.ts"

/**
 * Akun Titah — login SSO ke titah-web, terverifikasi kembali di CLI.
 *
 * Dipisah dari auth.ts dengan sengaja. auth.json menyimpan kunci PROVIDER: kunci
 * yang kamu bawa sendiri, yang dipakai untuk memanggil model. account.json
 * menyimpan identitas KAMU di titah-web. Keduanya rahasia, tapi mencampurnya
 * berarti `titah auth remove anthropic` bisa ikut menghapus sesi loginmu — dua
 * hal yang tidak punya alasan apa pun untuk hidup bersama.
 *
 * Alurnya adalah Device Authorization Grant (RFC 8628), bukan loopback redirect.
 * Alasannya satu dan menentukan: coding agent sangat sering dijalankan lewat
 * SSH, di dalam container, atau di mesin tanpa browser sama sekali — dan di
 * sana redirect ke 127.0.0.1 mengarah ke loopback mesin YANG SALAH. Device flow
 * berjalan identik di kedua tempat: kode yang sama diketik di browser mana pun,
 * di mesin mana pun.
 */

/**
 * Dipakai kalau tidak ada konfigurasi maupun env var yang menyebut server lain.
 *
 * # Kenapa nilai ini lebih mahal diganti daripada kelihatannya
 *
 * Ia IKUT TERKOMPILASI ke paket npm. Setiap instalasi memegang salinannya
 * sendiri, dan tidak pernah berubah pikiran — mengganti baris ini hanya
 * mengubah nasib orang yang memasang SESUDAHNYA. Yang sudah terpasang tetap
 * menghubungi host lama sampai mereka upgrade, dan sebagian tidak akan pernah.
 *
 * Karena itu hostname di sini harus yang bisa dijaga hidup selamanya, bukan
 * yang paling ingin dipakai. Subdomain di domain yang SUDAH dimiliki lebih
 * aman daripada domain yang belum dibeli: kalau nanti pindah, yang lama tinggal
 * jadi alias — satu record DNS, dan instalasi lama tetap jalan.
 *
 * Alias, bukan redirect. API ini dipanggil dengan POST, dan 301 pada POST
 * diperlakukan berbeda oleh berbagai klien HTTP.
 *
 * # Kenapa BUKAN alamat privat
 *
 * Sebelum ini nilainya `http://10.10.100.54:8080` — titah-web di jaringan
 * lokal, benar selama Titah belum pernah dipublikasikan. Begitu paketnya
 * terbit, alamat itu di mesin orang lain menunjuk JARINGAN MEREKA SENDIRI:
 * `titah login` menghubungi host acak di LAN mereka. Bukan sekadar rusak —
 * terlihat mencurigakan, dan itu kesan pertama yang tidak bisa ditarik.
 *
 * `account.server` dan $TITAH_ACCOUNT_SERVER tetap menutupi semua orang yang
 * menjalankan instance mereka sendiri, termasuk pengembangan lokal.
 */
export const DEFAULT_SERVER = "https://titah.dev"

const CLIENT_ID = "titah-cli"
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const VERSION = 1

/** Batas atas polling, supaya `titah login` yang ditinggal pergi tidak menggantung selamanya. */
const MAX_POLL_MS = 15 * 60 * 1000

export class AccountError extends Error {
  readonly code: string

  constructor(message: string, code = "account_error") {
    super(message)
    this.name = "AccountError"
    this.code = code
  }
}

export interface AccountUser {
  email: string
  name?: string
}

export interface AccountState {
  /** Server tempat token ini berlaku. Disimpan supaya pindah server tidak diam-diam memakai token lama. */
  server: string
  token: string
  tokenType: string
  /** Epoch ms. Tidak ada artinya kalau server memilih token tanpa kedaluwarsa. */
  expiresAt?: number
  user: AccountUser
  /** Label yang ditampilkan di daftar perangkat pada dashboard web. */
  deviceName: string
  signedInAt: number
}

export type AccountChoice = "signed-in" | "anonymous"

export interface AccountFileShape {
  version: number
  /**
   * Apa yang sudah dipilih user tentang akun.
   *
   * Ini yang membuat pertanyaan pembuka hanya muncul SEKALI. Tanpa merekamnya,
   * "lanjut tanpa akun" akan ditanyakan lagi setiap kali Titah dibuka — dan
   * pertanyaan yang tidak pernah berhenti bertanya adalah pertanyaan yang
   * berhenti dibaca.
   */
  choice?: AccountChoice
  chosenAt?: number
  account?: AccountState
}

// ---------------------------------------------------------------------------
// Penyimpanan
// ---------------------------------------------------------------------------

export function readAccountFile(): AccountFileShape {
  const file = accountFile()
  if (!fs.existsSync(file)) return { version: VERSION }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (parsed === null || typeof parsed !== "object") return { version: VERSION }
    return parsed as AccountFileShape
  } catch {
    // File rusak tidak boleh menjatuhkan sesi. Yang hilang cuma status login,
    // dan itu bisa diperbaiki dengan satu `titah login`.
    return { version: VERSION }
  }
}

export function writeAccountFile(state: AccountFileShape): void {
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const file = accountFile()
  // Tulis-lalu-rename dengan mode diset SEBELUM rename, sama seperti auth.json:
  // token tidak boleh sekejap pun bisa dibaca proses lain.
  const tmp = path.join(dir, `.account.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify({ ...state, version: VERSION }, null, 2)}\n`, {
    mode: FILE_MODE,
  })
  fs.chmodSync(tmp, FILE_MODE)
  fs.renameSync(tmp, file)
}

/** Akun yang masih berlaku, atau undefined. Token kedaluwarsa dianggap tidak ada. */
export function currentAccount(now = Date.now()): AccountState | undefined {
  const state = readAccountFile()
  const account = state.account
  if (!account) return undefined
  if (account.expiresAt !== undefined && account.expiresAt <= now) return undefined
  return account
}

export function isSignedIn(now = Date.now()): boolean {
  return currentAccount(now) !== undefined
}

/**
 * Apakah user pernah memilih antara login dan lanjut tanpa akun?
 *
 * Token yang kedaluwarsa TETAP dihitung sebagai sudah memilih. Kalau tidak,
 * kedaluwarsanya token akan memunculkan kembali layar sambutan mesin-baru,
 * yang membaca seperti Titah lupa siapa dirinya.
 */
export function hasChosen(): boolean {
  return readAccountFile().choice !== undefined
}

export function chooseAnonymous(now = Date.now()): void {
  const state = readAccountFile()
  writeAccountFile({ ...state, choice: "anonymous", chosenAt: now })
}

export function saveAccount(account: AccountState, now = Date.now()): void {
  writeAccountFile({ version: VERSION, choice: "signed-in", chosenAt: now, account })
}

/**
 * Menghapus token, tapi MEMPERTAHANKAN fakta bahwa user pernah memilih.
 *
 * Sign out adalah tindakan sengaja. Menanyakan lagi "login atau lanjut tanpa
 * akun?" di pembukaan berikutnya akan membuat sign out terasa seperti reset
 * pabrik.
 */
export function signOut(now = Date.now()): boolean {
  const state = readAccountFile()
  if (!state.account) return false
  writeAccountFile({ version: VERSION, choice: "anonymous", chosenAt: now })
  return true
}

/** Melaporkan izin file kalau lebih longgar dari 0600 — cermin checkPermissions() di auth.ts. */
export function checkAccountPermissions(): { file: string; mode: string } | undefined {
  const file = accountFile()
  if (!fs.existsSync(file)) return undefined
  const mode = fs.statSync(file).mode & 0o777
  if (mode === FILE_MODE) return undefined
  return { file, mode: mode.toString(8).padStart(3, "0") }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Server akun, dari yang paling spesifik ke yang paling umum.
 *
 * Env var menang atas config supaya satu sesi shell bisa diarahkan ke instance
 * lain tanpa menyunting file yang dipakai bersama.
 */
export function accountServer(config?: Pick<Config, "account">): string {
  const fromEnv = process.env.TITAH_ACCOUNT_SERVER?.trim()
  if (fromEnv) return normaliseServer(fromEnv)
  const fromConfig = config?.account?.server?.trim()
  if (fromConfig) return normaliseServer(fromConfig)
  return DEFAULT_SERVER
}

export function normaliseServer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//.test(trimmed)) {
    throw new AccountError(
      `Account server must start with http:// or https:// — got "${value}".`,
      "bad_server",
    )
  }
  return trimmed
}

function endpoint(server: string, route: string): string {
  return `${server}/cli/${route}`
}

/** Nama perangkat yang muncul di dashboard web. Cukup untuk mengenali baris mana milik mesin mana. */
export function deviceName(): string {
  const user = os.userInfo().username
  return `${user}@${os.hostname()} (${os.platform()})`
}

async function readError(response: Response): Promise<{ error: string; description?: string }> {
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === "object") {
      const record = body as Record<string, unknown>
      return {
        error: typeof record.error === "string" ? record.error : `http_${response.status}`,
        ...(typeof record.error_description === "string"
          ? { description: record.error_description }
          : {}),
      }
    }
  } catch {
    // Bukan JSON. Status code saja sudah lebih baik daripada melempar di sini.
  }
  return { error: `http_${response.status}` }
}

/** Membungkus kegagalan jaringan jadi pesan yang menyebut server yang dituju. */
async function post(url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new AccountError(
      `Cannot reach the account server at ${new URL(url).origin}.\n` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        "Point Titah somewhere else with TITAH_ACCOUNT_SERVER, or set `account.server` in titah.json.",
      "unreachable",
    )
  }
}

// ---------------------------------------------------------------------------
// Device Authorization Grant (RFC 8628)
// ---------------------------------------------------------------------------

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** URL yang sudah membawa kodenya, supaya user tidak perlu mengetik apa pun. */
  verificationUriComplete?: string
  /** Jarak minimum antar-polling, dalam ms. */
  interval: number
  expiresAt: number
}

export async function startDeviceAuthorization(
  server: string,
  now = Date.now(),
): Promise<DeviceAuthorization> {
  const response = await post(endpoint(server, "device/"), {
    client_id: CLIENT_ID,
    scope: "profile",
    device_name: deviceName(),
  })

  if (!response.ok) {
    const { error, description } = await readError(response)
    throw new AccountError(
      description ?? `The account server refused to start a login (${error}).`,
      error,
    )
  }

  const body = (await response.json()) as Record<string, unknown>
  const deviceCode = body.device_code
  const userCode = body.user_code
  const verificationUri = body.verification_uri

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new AccountError(
      `The account server at ${server} did not answer with a device authorization. ` +
        "Is that really a Titah server?",
      "bad_response",
    )
  }

  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600
  const interval = typeof body.interval === "number" ? body.interval : 5

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof body.verification_uri_complete === "string"
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    interval: Math.max(1, interval) * 1000,
    expiresAt: now + expiresIn * 1000,
  }
}

export interface PollOptions {
  signal?: AbortSignal
  /** Dipanggil saat server meminta pelan-pelan, supaya UI bisa mengatakannya. */
  onSlowDown?: (nextIntervalMs: number) => void
  /** Disuntik di test supaya tidak ada yang benar-benar tidur. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(new AccountError("Login cancelled.", "cancelled"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AccountError("Login cancelled.", "cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Menunggu user menyetujui di browser.
 *
 * Empat balasan yang wajib dibedakan (RFC 8628 §3.5): `authorization_pending`
 * berarti terus tunggu, `slow_down` berarti tunggu lebih lama, `expired_token`
 * dan `access_denied` berarti berhenti. Menyamakan keempatnya jadi "gagal"
 * membuat "belum diklik" terlihat persis seperti "ditolak".
 */
export async function pollForToken(
  server: string,
  authorization: DeviceAuthorization,
  options: PollOptions = {},
): Promise<AccountState> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const startedAt = now()
  let interval = authorization.interval

  for (;;) {
    if (options.signal?.aborted === true) throw new AccountError("Login cancelled.", "cancelled")
    if (now() >= authorization.expiresAt) {
      throw new AccountError(
        "The login code expired before it was approved. Run `titah login` again.",
        "expired_token",
      )
    }
    if (now() - startedAt >= MAX_POLL_MS) {
      throw new AccountError("Gave up waiting for the browser approval.", "timeout")
    }

    await sleep(interval, options.signal)

    const response = await post(endpoint(server, "token/"), {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: authorization.deviceCode,
      client_id: CLIENT_ID,
    })

    if (response.ok) {
      return toAccountState(server, (await response.json()) as Record<string, unknown>, now())
    }

    const { error, description } = await readError(response)
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      interval += 5000
      options.onSlowDown?.(interval)
      continue
    }
    if (error === "access_denied") {
      throw new AccountError("The login request was denied in the browser.", "access_denied")
    }
    if (error === "expired_token") {
      throw new AccountError(
        "The login code expired before it was approved. Run `titah login` again.",
        "expired_token",
      )
    }
    throw new AccountError(description ?? `Login failed (${error}).`, error)
  }
}

function toAccountState(
  server: string,
  body: Record<string, unknown>,
  now: number,
): AccountState {
  const token = body.access_token
  if (typeof token !== "string" || token === "") {
    throw new AccountError("The account server returned no access token.", "bad_response")
  }

  const user = body.user
  const email =
    user !== null && typeof user === "object" && typeof (user as { email?: unknown }).email === "string"
      ? ((user as { email: string }).email)
      : undefined
  if (email === undefined) {
    throw new AccountError("The account server returned a token with no user.", "bad_response")
  }
  const name =
    user !== null && typeof user === "object" && typeof (user as { name?: unknown }).name === "string"
      ? (user as { name: string }).name
      : undefined

  return {
    server,
    token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    ...(typeof body.expires_in === "number" ? { expiresAt: now + body.expires_in * 1000 } : {}),
    user: { email, ...(name ? { name } : {}) },
    deviceName: deviceName(),
    signedInAt: now,
  }
}

// ---------------------------------------------------------------------------
// Orkestrasi
// ---------------------------------------------------------------------------

export interface LoginHandlers {
  /**
   * Dipanggil sekali, segera setelah kode terbit — SEBELUM polling dimulai.
   *
   * `browserOpened` menentukan apa yang layak dicetak: kalau browser sudah
   * terbuka, URL panjang cuma kebisingan; kalau tidak, URL itu satu-satunya
   * jalan keluar.
   */
  onPrompt: (authorization: DeviceAuthorization, browserOpened: boolean) => void
  onSlowDown?: (nextIntervalMs: number) => void
}

export interface LoginOptions extends PollOptions {
  /** Dimatikan di test, dan saat user memang tidak mau browsernya diambil alih. */
  openBrowser?: boolean
}

/**
 * Satu jalur login, dipakai baik oleh `titah login` maupun `/login` di TUI.
 *
 * Dibuat di core dan bukan di masing-masing pemanggil supaya keduanya tidak
 * bisa melenceng: dua salinan alur ini akan berbeda dalam menangani `slow_down`
 * dalam sebulan, dan yang satu akan diam-diam lebih buruk.
 */
export async function login(
  server: string,
  handlers: LoginHandlers,
  options: LoginOptions = {},
): Promise<AccountState> {
  const now = options.now ?? Date.now
  const authorization = await startDeviceAuthorization(server, now())

  const target = authorization.verificationUriComplete ?? authorization.verificationUri
  const opened = options.openBrowser === false ? false : openBrowser(target)
  handlers.onPrompt(authorization, opened)

  const account = await pollForToken(server, authorization, {
    ...options,
    ...(handlers.onSlowDown ? { onSlowDown: handlers.onSlowDown } : {}),
  })

  saveAccount(account, now())
  return account
}

// ---------------------------------------------------------------------------
// Verifikasi & pencabutan
// ---------------------------------------------------------------------------

/**
 * Menanyakan ke server siapa pemilik token ini.
 *
 * Inilah "terverifikasi di titah" yang sesungguhnya: yang menentukan sesi masih
 * sah bukan berkas lokal, melainkan server yang menerbitkannya. Token yang
 * dicabut lewat dashboard harus mati di CLI juga, dan hanya panggilan ini yang
 * bisa mengetahuinya.
 */
export async function fetchUserInfo(account: AccountState): Promise<AccountUser> {
  let response: Response
  try {
    response = await fetch(endpoint(account.server, "userinfo/"), {
      headers: { authorization: `${account.tokenType} ${account.token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new AccountError(
      `Cannot reach ${account.server}: ${error instanceof Error ? error.message : String(error)}`,
      "unreachable",
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AccountError(
      "This machine is no longer signed in — the token was revoked or expired. Run `titah login`.",
      "revoked",
    )
  }
  if (!response.ok) {
    const { error, description } = await readError(response)
    throw new AccountError(description ?? `Could not verify the session (${error}).`, error)
  }

  const body = (await response.json()) as Record<string, unknown>
  const email = body.email
  if (typeof email !== "string") {
    throw new AccountError("The account server returned no email.", "bad_response")
  }
  return { email, ...(typeof body.name === "string" && body.name ? { name: body.name } : {}) }
}

/**
 * Mencabut token di server, lalu menghapusnya secara lokal.
 *
 * Lokal dihapus APA PUN hasil panggilan server. Sign out yang gagal karena
 * jaringan mati tapi tetap meninggalkan token di disk adalah sign out yang
 * berbohong; token yang tertinggal di server bisa dicabut dari dashboard.
 */
export async function revokeToken(account: AccountState): Promise<boolean> {
  try {
    const response = await post(endpoint(account.server, "revoke/"), { token: account.token })
    return response.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * Membuka browser, dan melaporkan JUJUR kalau tidak bisa.
 *
 * Nilai baliknya dipakai untuk memutuskan apa yang dicetak: kalau browser
 * terbuka, URL panjang cuma kebisingan; kalau tidak, URL itu satu-satunya jalan
 * user menyelesaikan login. Menebak salah di sini berarti user menatap layar
 * yang menunggu sesuatu yang tidak pernah muncul.
 */
export function openBrowser(url: string): boolean {
  // SSH tanpa X11 dan container: ada perintahnya, tapi tidak ada yang akan
  // terbuka. Lebih baik langsung mencetak URL daripada berpura-pura berhasil.
  if (process.env.SSH_CONNECTION && !process.env.DISPLAY && process.platform !== "darwin") {
    return false
  }

  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]

  try {
    const child = spawn(command, args as string[], {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
    // `spawn` melempar secara asinkron saat perintahnya tidak ada, jadi error
    // ditangkap di sini dan tidak pernah menjatuhkan proses.
    child.on("error", () => {})
    return true
  } catch {
    return false
  }
}

/** `ABCD-EFGH` — dikelompokkan supaya bisa dibacakan dengan lantang tanpa salah. */
export function formatUserCode(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, "").toUpperCase()
  if (clean.length !== 8) return code.toUpperCase()
  return `${clean.slice(0, 4)}-${clean.slice(4)}`
}
