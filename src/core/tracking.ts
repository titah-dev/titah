import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { currentAccount } from "./account.ts"
import { bus } from "./event.ts"
import { matchesPattern } from "./match.ts"
import { configDir } from "./paths.ts"
import type { Config } from "./schema.ts"
import { collectStats, priceOf, turnCost } from "./stats.ts"
import { database } from "./storage/db.ts"
import { getSession, listMessages, projectKey } from "./storage/session.ts"
import type { Message } from "./message.ts"

/**
 * Satu-satunya hal yang Titah kirim tentang pekerjaanmu.
 *
 * Metadata proyek — nama, bahasa, git, dan angka yang sudah dibaca `titah
 * stats`. Tidak ada isi berkas, tidak ada transkrip, tidak ada keluaran tool.
 *
 * # Kenapa modul ini nyaris tidak menghitung apa pun sendiri
 *
 * Angkanya dari `collectStats`, identitasnya dari `projectKey`. Keduanya sudah
 * ada dan sudah dipakai untuk hal lain. Repo ini berkali-kali kena satu kelas
 * bug yang sama — yang diukur bukan yang dikirim — dan menghitung ulang di sini
 * adalah cara paling mudah mengulanginya: angka di dashboard dan angka di
 * `titah stats` akan menyimpang, dan tidak ada yang tahu mana yang benar sampai
 * ada yang membandingkannya.
 */

/** Jeda minimum antar heartbeat untuk satu proyek. */
const WINDOW_MS = 5 * 60_000

/**
 * Batas satu request.
 *
 * Sepuluh detik, bukan lima. Diukur: request panas selesai ~200ms, tapi koneksi
 * HTTPS PERTAMA di mesin dingin (DNS + TLS) sempat melewati lima detik dan
 * gagal diam-diam. Menaikkannya tidak berbiaya bagi siapa pun: pengirimannya
 * fire-and-forget, dan yang benar-benar menentukan lamanya `titah run` keluar
 * adalah batas `flush()`, bukan yang ini.
 */
const TIMEOUT_MS = 10_000

/**
 * Batas per pesan dalam transkrip.
 *
 * Angka yang SAMA dengan ambang keluaran tool Titah. Satu angka, bukan dua yang
 * bisa menyimpang tanpa ada yang menyadarinya.
 */
const MESSAGE_CAP = 32 * 1024

/** Batas seluruh transkrip yang diunggah. */
const TRANSCRIPT_CAP = 512 * 1024

/*
 * Log di config dir, diminta eksplisit.
 *
 * Konvensi repo sebenarnya `logDir()` — `~/.config` untuk hal yang ditulis
 * user, log adalah state. Satu konstanta, jadi memindahkannya satu baris.
 */
const LOG_FILE = (): string => path.join(configDir(), "tracking.log")

export type TrackingReason = "ok" | "disabled" | "not-signed-in" | "excluded"

export interface HeartbeatPayload {
  path_hash: string
  name: string
  language: string
  git_remote_url: string
  git_branch: string
  cli_version: string
  stats: {
    total_sessions: number
    total_tokens: number
    total_cost_usd: number
  }
}

/**
 * Identitas proyek di server, dari kunci yang SAMA dengan yang dipakai lokal.
 *
 * Kalau ini menormalkan path dengan caranya sendiri, `~/proj` dan `~/proj/`
 * bisa jadi dua baris di dashboard sementara lokal keduanya satu proyek.
 */
export function pathHash(directory: string): string {
  return crypto.createHash("sha256").update(projectKey(directory)).digest("hex")
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function isExcluded(config: Config, directory: string): boolean {
  const target = projectKey(directory)
  return config.tracking.exclude.some((pattern) => matchesPattern(expandHome(pattern), target))
}

/**
 * Kenapa proyek ini dilaporkan — atau kenapa tidak.
 *
 * Mengembalikan alasan, bukan boolean, karena `titah doctor` harus bisa
 * mengatakan MANA dari empat sakelar yang sedang berlaku. "Tidak terkirim"
 * tanpa sebab adalah keadaan yang tidak bisa diperbaiki siapa pun.
 *
 * `disabled` diperiksa lebih dulu daripada login: user yang sengaja mematikan
 * tracking lebih ingin membaca "disabled" daripada "not signed in".
 */
export function trackingReason(config: Config, directory: string): TrackingReason {
  if (!config.tracking.enabled) return "disabled"
  if (currentAccount() === undefined) return "not-signed-in"
  if (isExcluded(config, directory)) return "excluded"
  return "ok"
}

// ---------------------------------------------------------------------------
// Manifest: nama dan bahasa
// ---------------------------------------------------------------------------

function jsonName(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const name = (parsed as { name?: unknown }).name
    return typeof name === "string" ? name : ""
  } catch {
    return ""
  }
}

/** `name = "x"` di blok mana pun. Cukup untuk pyproject dan Cargo. */
function tomlName(text: string): string {
  return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? ""
}

/** `module github.com/a/b` → `b`. Yang berguna adalah ruas terakhirnya. */
function goModule(text: string): string {
  const module = /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? ""
  return module === "" ? "" : (module.split("/").pop() as string)
}

const MANIFESTS: { file: string; language: string; name: (text: string) => string }[] = [
  { file: "package.json", language: "javascript", name: jsonName },
  { file: "pyproject.toml", language: "python", name: tomlName },
  { file: "go.mod", language: "go", name: goModule },
  { file: "Cargo.toml", language: "rust", name: tomlName },
  { file: "composer.json", language: "php", name: jsonName },
]

function readIfFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function describeProject(directory: string): { name: string; language: string } {
  const fallback = path.basename(projectKey(directory)) || "unnamed"

  for (const manifest of MANIFESTS) {
    const text = readIfFile(path.join(directory, manifest.file))
    if (text === undefined) continue

    let language = manifest.language
    // Satu-satunya penajaman yang layak: sebuah paket npm dengan tsconfig
    // adalah proyek TypeScript, dan menyebutnya "javascript" salah di mata
    // siapa pun yang membaca dashboardnya.
    if (manifest.file === "package.json" && fs.existsSync(path.join(directory, "tsconfig.json"))) {
      language = "typescript"
    }
    return { name: manifest.name(text) || fallback, language }
  }

  return { name: fallback, language: "" }
}

/**
 * Git lewat perintahnya sendiri, dan GAGAL-DIAM ke string kosong.
 *
 * Folder tanpa git bukan kesalahan, dan heartbeat yang batal karena `git` tidak
 * terpasang adalah heartbeat yang tidak pernah terkirim di setengah mesin.
 */
function git(directory: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 2_000,
      // stderr DIBUANG, bukan diwariskan: modul ini tidak boleh menulis
      // sebyte pun ke stream milik proses.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

export function buildPayload(config: Config, directory: string, version: string): HeartbeatPayload {
  const { name, language } = describeProject(directory)
  const stats = collectStats(config, { directory })

  return {
    path_hash: pathHash(directory),
    name,
    language,
    git_remote_url: config.tracking.git ? git(directory, ["config", "--get", "remote.origin.url"]) : "",
    git_branch: config.tracking.git ? git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]) : "",
    cli_version: version,
    stats: {
      total_sessions: stats.sessions,
      total_tokens: stats.input + stats.output,
      // `collectStats` hanya menjumlahkan model yang PUNYA harga — model tanpa
      // harga tidak dihitung nol, ia tidak dihitung. Sama seperti `titah stats`.
      total_cost_usd: stats.cost,
    },
  }
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export function lastSent(hash: string): number | undefined {
  const row = database().prepare("SELECT sent FROM tracking WHERE path_hash = ?").get(hash) as
    | { sent: number }
    | undefined
  return row?.sent
}

export function markSent(hash: string, at: number): void {
  database()
    .prepare(
      "INSERT INTO tracking (path_hash, sent) VALUES (?, ?) " +
        "ON CONFLICT(path_hash) DO UPDATE SET sent = excluded.sent",
    )
    .run(hash, at)
}

// ---------------------------------------------------------------------------
// Sakelar server, dipelajari dari respons heartbeat
// ---------------------------------------------------------------------------

export function serverSyncEnabled(hash: string): boolean {
  const row = database().prepare("SELECT sync FROM tracking WHERE path_hash = ?").get(hash) as
    | { sync: number }
    | undefined
  return row?.sync === 1
}

export function setServerSync(hash: string, enabled: boolean): void {
  database()
    .prepare(
      "INSERT INTO tracking (path_hash, sent, sync) VALUES (?, 0, ?) " +
        "ON CONFLICT(path_hash) DO UPDATE SET sync = excluded.sync",
    )
    .run(hash, enabled ? 1 : 0)
}

export type SyncReason = TrackingReason | "sync-off-locally" | "sync-off-on-server"

/**
 * Kenapa transkrip proyek ini diunggah — atau kenapa tidak.
 *
 * TIGA gerbang, dan semuanya harus lolos. Yang lokal diperiksa lebih dulu
 * daripada yang server: user yang sengaja tidak menyalakannya lebih ingin
 * membaca itu daripada keadaan sakelar yang tidak pernah ia sentuh.
 */
export function syncReason(config: Config, directory: string): SyncReason {
  const base = trackingReason(config, directory)
  if (base !== "ok") return base
  if (!config.tracking.sync) return "sync-off-locally"
  if (!serverSyncEnabled(pathHash(directory))) return "sync-off-on-server"
  return "ok"
}

// ---------------------------------------------------------------------------
// Transkrip
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
}

export interface Transcript {
  project_path_hash: string
  session_id: string
  title: string
  created_at: string
  messages: TranscriptMessage[]
  stats: { tokens: number; cost_usd: number }
}

/**
 * Meratakan `parts` jadi satu string — dan MEMBUANG dua dari tiga jenisnya.
 *
 * # Keluaran tool tidak pernah ikut
 *
 * Di situlah rahasia tinggal. `read .env`, `bash env`, `grep -r password`
 * adalah panggilan wajar dalam pekerjaan wajar, dan hasilnya masuk transkrip.
 * Menyaringnya otomatis bukan pilihan: penyaring rahasia yang bisa diandalkan
 * tidak ada, dan yang menangkap `AKIA…` lalu melewatkan token internal
 * perusahaan lebih buruk daripada tidak menyaring — ia menghasilkan rasa aman.
 *
 * # Argumen tool juga tidak
 *
 * Lebih halus, dan tetap tidak. `edit` membawa `oldString` dan `newString`, dan
 * itu kode. `write` membawa seluruh isi berkas. `▸ edit` mengatakan bahwa
 * sesuatu disunting; argumennya mengatakan apa isinya.
 *
 * # `reasoning` juga tidak
 *
 * Bukan karena ukurannya. Titah sengaja memisahkannya dari `text` karena text
 * adalah jawaban dan ini jalan menuju jawaban. Yang paling panjang dan paling
 * tidak pernah dibaca ulang adalah kandidat terburuk untuk keluar dari mesin.
 */
function flatten(message: Message): string {
  const lines: string[] = []
  for (const part of message.parts) {
    if (part.type === "text") lines.push(part.text)
    else if (part.type === "tool") lines.push(`▸ ${part.tool}`)
    // reasoning: sengaja dilewati
  }
  const text = lines.join("\n").trim()
  if (text.length <= MESSAGE_CAP) return text
  return `${text.slice(0, MESSAGE_CAP)}\n\n[dipotong — ${text.length - MESSAGE_CAP} karakter lagi ada di sesi lokal]`
}

/**
 * Transkrip satu sesi, atau `undefined` kalau sesi itu tidak layak diunggah.
 *
 * Sesi anak tidak punya transkrip: ia punya barisnya sendiri secara lokal, dan
 * mengunggahnya memunculkan baris dashboard yang tidak diminta siapa pun. Yang
 * terlihat di transkrip induk cukup — satu baris `▸ task`.
 */
export function buildTranscript(config: Config, sessionID: string): Transcript | undefined {
  const session = getSession(sessionID)
  if (session === undefined || session.parentID !== undefined) return undefined

  let tokens = 0
  let cost = 0
  const all: TranscriptMessage[] = []
  for (const message of listMessages(sessionID)) {
    tokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0)
    cost += turnCost(priceOf(config, message.model), message.usage ?? {}) ?? 0
    const content = flatten(message)
    if (content === "") continue
    all.push({
      role: message.role,
      content,
      timestamp: new Date(message.created).toISOString(),
    })
  }

  /*
   * Yang lewat batas dibuang dari YANG TERTUA, dan jumlahnya DISEBUT.
   *
   * Transkrip yang dipotong diam-diam terlihat lengkap, dan orang akan
   * menyimpulkan sesuatu dari percakapan yang ternyata bukan seluruhnya. Yang
   * tertua yang pergi karena bagian terbarulah yang orang buka untuk dilihat.
   */
  const messages: TranscriptMessage[] = []
  let total = 0
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index] as TranscriptMessage
    if (total + message.content.length > TRANSCRIPT_CAP) {
      messages.unshift({
        role: "user",
        content: `[${index + 1} pesan sebelumnya tidak diunggah — transkrip penuhnya ada di sesi lokal ${sessionID}]`,
        timestamp: message.timestamp,
      })
      break
    }
    total += message.content.length
    messages.unshift(message)
  }

  return {
    project_path_hash: pathHash(session.directory),
    session_id: session.id,
    title: session.title.slice(0, 255),
    created_at: new Date(session.created).toISOString(),
    messages,
    stats: { tokens, cost_usd: cost },
  }
}

/**
 * Unggah satu transkrip, atau jangan — dan JANGAN PERNAH melempar.
 *
 * `403 sync_disabled` ditangani khusus: ia mematikan flag lokal, supaya Titah
 * tidak mencoba lagi setiap giliran sampai heartbeat berikutnya mengabarkan
 * sebaliknya. Server adalah pemegang kebenaran untuk sakelarnya sendiri.
 */
export async function syncSession(
  config: Config,
  directory: string,
  sessionID: string,
): Promise<boolean> {
  const label = path.basename(projectKey(directory)) || directory
  try {
    if (syncReason(config, directory) !== "ok") return false

    const transcript = buildTranscript(config, sessionID)
    if (transcript === undefined || transcript.messages.length === 0) return false

    const account = currentAccount()
    if (account === undefined) return false

    const response = await fetch(`${account.server}/api/sessions/sync/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${account.tokenType} ${account.token}`,
      },
      body: JSON.stringify(transcript),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (response.status === 403) {
      setServerSync(pathHash(directory), false)
      log(`sync ditolak ${label}: server mematikannya untuk proyek ini`)
      return false
    }
    if (!response.ok) {
      log(`sync gagal ${label}: HTTP ${response.status}`)
      return false
    }

    log(`sync terkirim ${label}: ${transcript.messages.length} pesan`)
    return true
  } catch (error) {
    log(`sync gagal ${label}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/**
 * Satu baris per percobaan, append-only, dan kegagalannya sendiri diabaikan.
 *
 * Log yang gagal ditulis tidak boleh jadi masalah kedua — apalagi masalah yang
 * terdengar, karena seluruh modul ini berjanji tidak bersuara.
 */
function log(line: string): void {
  try {
    fs.mkdirSync(configDir(), { recursive: true })
    fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* sengaja dibiarkan */
  }
}

// ---------------------------------------------------------------------------
// Pengiriman
// ---------------------------------------------------------------------------

/**
 * Kirim satu heartbeat, atau jangan — dan JANGAN PERNAH melempar.
 *
 * Nilai baliknya `true` hanya kalau benar-benar terkirim dan diterima. Semua
 * jalur lain — dimatikan, tidak login, dikecualikan, masih di dalam jendela
 * debounce, jaringan mati, server menolak — mengembalikan `false` tanpa suara.
 *
 * Tidak ada retry. Heartbeat berikutnya membawa angka kumulatif yang sama
 * lengkapnya, jadi satu yang hilang tidak menghilangkan data apa pun.
 */
export async function sendHeartbeat(
  config: Config,
  directory: string,
  version: string,
  now: number = Date.now(),
): Promise<boolean> {
  const label = path.basename(projectKey(directory)) || directory
  try {
    const reason = trackingReason(config, directory)
    if (reason !== "ok") return false

    const hash = pathHash(directory)
    const previous = lastSent(hash)
    if (previous !== undefined && now - previous < WINDOW_MS) return false

    const account = currentAccount()
    if (account === undefined) return false

    const response = await fetch(`${account.server}/api/projects/heartbeat/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${account.tokenType} ${account.token}`,
      },
      body: JSON.stringify(buildPayload(config, directory, version)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) {
      log(`gagal ${label}: HTTP ${response.status}`)
      return false
    }

    // Dicatat SESUDAH server menerima. Menandai lebih awal berarti satu server
    // yang sedang mati membeli lima menit diam berikutnya secara gratis.
    markSent(hash, now)

    /*
     * Sakelar sinkronisasi dipelajari DI SINI, dari respons yang sudah ada.
     *
     * Tanpa ini satu-satunya cara mengetahuinya adalah mencoba mengunggah lalu
     * ditolak 403 — satu request terbuang setiap giliran, seumur hidup proyek
     * yang tidak pernah menyalakannya.
     */
    try {
      const body = (await response.json()) as { sync_enabled?: unknown }
      if (typeof body.sync_enabled === "boolean") setServerSync(hash, body.sync_enabled)
    } catch {
      /* respons tanpa JSON yang sah tidak mengubah apa pun */
    }

    log(`terkirim ${label}`)
    return true
  } catch (error) {
    log(`gagal ${label}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Menempel di `session.idle` — event yang SUDAH terbit tiap giliran selesai.
 *
 * Tidak ada perubahan di `agent.ts`, dan satu pelanggan menutup dua topologi:
 * `titah run` menjalankan core di dalam proses, `titah serve` (dan TUI yang
 * men-spawn-nya) di proses server. Keduanya menerbitkan event yang sama.
 *
 * `client: false` bukan detail. `listenerCount` dipakai permission engine untuk
 * tolak-otomatis, jadi pelanggan yang ikut dihitung akan membuat `titah run` di
 * CI berhenti menolak-otomatis dan menggantung.
 */
export interface Tracker {
  /** Berhenti berlangganan. */
  stop(): void
  /**
   * Tunggu pengiriman yang sedang berjalan, TAPI tidak lebih lama dari `ms`.
   *
   * Ada karena `titah run` keluar begitu gilirannya selesai: tanpa ini,
   * heartbeat yang baru saja dilepas mati bersama prosesnya, dan jalur headless
   * — yang paling sering dipakai — jadi satu-satunya yang tidak pernah
   * melaporkan apa pun.
   *
   * Berbatas, karena menunggu tanpa batas berarti server yang mati menahan
   * keluarnya `titah run` selama timeout penuh. Kalau lewat, prosesnya jalan
   * terus: requestnya mungkin tetap sampai, dan kalau tidak, heartbeat
   * berikutnya membawa angka kumulatif yang sama lengkapnya.
   */
  flush(ms?: number): Promise<void>
}

export function startTracking(config: Config, version: string): Tracker {
  const controller = new AbortController()
  const stream = bus.subscribe({ signal: controller.signal, client: false })
  const inflight = new Set<Promise<unknown>>()

  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type !== "session.idle") continue
        const session = getSession(event.sessionID)
        // Sesi anak dilewati: satu `/tim` menerbitkan belasan idle, dan yang
        // dihitung hanya giliran yang benar-benar dijalankan user.
        if (session === undefined || session.parentID !== undefined) continue

        /*
         * Heartbeat dulu, transkrip sesudahnya — urutannya wajib.
         *
         * Respons heartbeat-lah yang mengabarkan apakah server menyalakan
         * sinkronisasi, dan server menolak sync untuk proyek yang belum pernah
         * mengirim heartbeat ("Send a heartbeat first", 404). Membaliknya
         * membuat unggahan pertama selalu gagal.
         */
        const pending = sendHeartbeat(config, session.directory, version).then(() =>
          syncSession(config, session.directory, session.id),
        )
        inflight.add(pending)
        void pending.finally(() => inflight.delete(pending))
      }
    } catch {
      /* stream yang berakhir tidak wajar tidak boleh menjatuhkan apa pun */
    }
  })()

  return {
    stop: () => controller.abort(),
    async flush(ms = 1_500) {
      /*
       * Beri kesempatan event yang SUDAH antre di bus untuk sampai ke
       * `inflight` lebih dulu.
       *
       * Pelanggan bus memproses antreannya di microtask, jadi `flush()` yang
       * dipanggil tepat sesudah giliran selesai bisa melihat set kosong dan
       * langsung kembali — padahal heartbeatnya belum sempat dilepas sama
       * sekali. Gejalanya persis sama dengan "tidak ada yang perlu ditunggu",
       * dan itulah yang membuatnya tidak terlihat.
       */
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (inflight.size === 0) return
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
        timer.unref()
      })
      try {
        await Promise.race([Promise.allSettled([...inflight]), deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/** Untuk `titah doctor`: keadaan sebenarnya, bukan tebakan dari config saja. */
export function trackingStatus(
  config: Config,
  directory: string,
): { reason: TrackingReason; lastSent?: number } {
  const at = lastSent(pathHash(directory))
  return { reason: trackingReason(config, directory), ...(at === undefined ? {} : { lastSent: at }) }
}
