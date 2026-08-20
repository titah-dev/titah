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
import { collectStats } from "./stats.ts"
import { database } from "./storage/db.ts"
import { getSession, projectKey } from "./storage/session.ts"

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

/** Heartbeat adalah metadata. Ia tidak boleh menahan apa pun selama ini. */
const TIMEOUT_MS = 5_000

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

        const pending = sendHeartbeat(config, session.directory, version)
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
