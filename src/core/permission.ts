import crypto from "node:crypto"
import { bus } from "./event.ts"
import type { Agent, Config } from "./schema.ts"

/**
 * Deny-by-default (Q9), dengan satu aturan yang tidak bisa ditawar (Q17):
 * kalau tidak ada klien yang terhubung, permintaan izin DITOLAK otomatis dan
 * alasannya dicatat.
 *
 * Blokir tanpa batas akan menggantung agent selamanya di CI; izin otomatis
 * membuat mode headless jadi celah keamanan diam-diam. Jalur yang benar untuk
 * otomasi adalah `--auto` atau allowlist eksplisit, bukan perilaku implisit.
 */

export type PermissionKind = "edit" | "write" | "bash" | "network" | "delete" | "mcp"

export type PermissionDecision = "once" | "always" | "reject"

export interface PermissionRequest {
  id: string
  sessionID: string
  kind: PermissionKind
  /** Ringkasan satu baris untuk dialog, mis. `bash: git status`. */
  title: string
  /** Isi lengkap yang akan dieksekusi/ditulis, untuk ditinjau user. */
  detail: string
  /**
   * Pola yang akan masuk allowlist kalau user menjawab "always",
   * mis. `git *` untuk bash atau `edit` untuk seluruh kelas tool.
   */
  pattern: string
  created: number
  /** Nama agent yang meminta, agar dialog bisa membedakan sub-agent mana yang bertanya. */
  agent?: string
}

export interface PermissionResult {
  granted: boolean
  reason: string
}

interface Pending {
  request: PermissionRequest
  /**
   * Sesi yang dipakai allowlist "always" — id INDUK kalau permintaan ini
   * datang dari giliran sub-agent, supaya satu jawaban menutup seluruh
   * giliran dan bukan cuma anak yang bertanya.
   */
  allowlistSessionID: string
  /**
   * True kalau permintaan ini datang dari giliran sub-agent. Menentukan gudang
   * mana yang ditulis jawaban "always" — lihat komentar di `respond()`.
   */
  turnScoped: boolean
  resolve: (result: PermissionResult) => void
}

const pending = new Map<string, Pending>()

/** Allowlist PERMANEN milik satu sesi TOP-LEVEL, dari jawaban "always" user sendiri. */
const sessionAllowlist = new Map<string, Set<string>>()

/**
 * Allowlist yang HANYA berlaku sepanjang satu giliran induk, keyed by id
 * sesi INDUK. Jawaban "always" dari sub-agent masuk ke sini, bukan ke
 * `sessionAllowlist` — kalau tidak, grant sekali-pakai yang dimaksudkan untuk
 * satu sub-agent akan hidup selamanya di proses dan diwarisi setiap sub-agent
 * berikutnya di giliran-giliran lain, termasuk yang tidak pernah diberi izin
 * apa pun oleh user. Dibersihkan oleh `clearTurn()`, dipanggil dari `finally`
 * `prompt()` saat giliran TOP-LEVEL (bukan tiap sub-agent) selesai.
 */
const turnAllowlist = new Map<string, Set<string>>()

/** Sesi yang berjalan dengan --auto. */
const autoSessions = new Set<string>()

export function setAutoApprove(sessionID: string, enabled: boolean): void {
  if (enabled) autoSessions.add(sessionID)
  else autoSessions.delete(sessionID)
}

export function isAutoApprove(sessionID: string): boolean {
  return autoSessions.has(sessionID)
}

export function allowlistFor(sessionID: string): string[] {
  return [...(sessionAllowlist.get(sessionID) ?? [])]
}

export function clearSession(sessionID: string): void {
  sessionAllowlist.delete(sessionID)
  turnAllowlist.delete(sessionID)
  autoSessions.delete(sessionID)
  for (const [id, entry] of pending) {
    if (entry.request.sessionID !== sessionID) continue
    entry.resolve({ granted: false, reason: "Session ended." })
    pending.delete(id)
  }
}

/**
 * Mengakhiri satu giliran TOP-LEVEL: menghapus allowlist turun-temurun yang
 * lahir dari sub-agent selama giliran itu. Dipanggil dari `finally` `prompt()`
 * supaya giliran yang gagal atau dibatalkan tetap membersihkannya — grant
 * yang bertahan lewat giliran yang memberikannya adalah persis bug-nya.
 *
 * TIDAK menyentuh `sessionAllowlist`: grant permanen milik user sendiri untuk
 * sesi top-level-nya sendiri harus tetap hidup lintas giliran, seperti semula.
 */
export function clearTurn(sessionID: string): void {
  turnAllowlist.delete(sessionID)
}

function remember(sessionID: string, pattern: string): void {
  const set = sessionAllowlist.get(sessionID) ?? new Set<string>()
  set.add(pattern)
  sessionAllowlist.set(sessionID, set)
}

function rememberForTurn(sessionID: string, pattern: string): void {
  const set = turnAllowlist.get(sessionID) ?? new Set<string>()
  set.add(pattern)
  turnAllowlist.set(sessionID, set)
}

function turnAllowlistFor(sessionID: string): string[] {
  return [...(turnAllowlist.get(sessionID) ?? [])]
}

/**
 * Pencocokan pola gaya glob sederhana: `*` cocok dengan apa saja.
 * Dipakai untuk allowlist bash seperti `git *` atau `npm test`.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/** Operator shell — tidak pernah muncul di dalam satu segmen perintah. */
const OPERATOR = /&&|\|\||[;\n|&]|\$\(|`/

/**
 * Entri allowlist yang tidak akan pernah cocok dengan apa pun.
 *
 * Pencocokan berjalan per SEGMEN, dan segmen tidak pernah mengandung operator
 * shell — jadi entri yang mengandungnya mati sejak ditulis. Sebelum issue #12
 * kelas entri mati jauh lebih luas (setiap pola sub-perintah), dan tidak ada
 * yang pernah menyebutkannya; itulah bagian yang paling merugikan user. Fungsi
 * ini ada supaya `titah doctor` bisa menyebut sisanya.
 */
export function neverMatchingAllowlistEntries(allowlist: string[]): string[] {
  return allowlist.filter((entry) => OPERATOR.test(entry))
}

/**
 * Entri allowlist mana yang mengizinkan permintaan ini — `undefined` kalau
 * tidak ada.
 *
 * Untuk bash, SETIAP segmen harus punya entri yang mengizinkannya. Dulu yang
 * dicocokkan cuma `"<kata-pertama> *"`, sehingga `git *` juga mengizinkan
 * `git status && rm -rf ~` (issue #12).
 */
function matchAllowlist(entries: string[], options: AskOptions): string | undefined {
  const hit = (value: string) => entries.find((entry) => matchesPattern(entry, value))

  if (options.kind !== "bash") return hit(options.pattern)

  const segments = options.segments
  // Dua penjagaan, dan keduanya perlu. Tanpa yang pertama, pemanggil bash yang
  // lupa mengirim segmen diam-diam kembali ke perilaku lama. Tanpa yang kedua,
  // `[].every(...)` yang bernilai true membuat perintah yang tidak bisa dinilai
  // — justru yang paling berbahaya — lolos sebagai kebenaran hampa.
  if (segments === undefined || segments.length === 0) return undefined

  const matched: string[] = []
  for (const segment of segments) {
    const entry = hit(segment)
    if (entry === undefined) return undefined
    matched.push(entry)
  }
  return [...new Set(matched)].join('", "')
}

export interface EffectivePermission {
  edit: "ask" | "allow" | "deny"
  write: "ask" | "allow" | "deny"
  bash: "ask" | "allow" | "deny"
  network: "ask" | "allow" | "deny"
  delete: "ask" | "allow" | "deny"
  mcp: "ask" | "allow" | "deny"
  allowlist: string[]
  /** Nama agent yang menentukan kebijakan ini, untuk pesan yang bisa dilacak. */
  source?: string
}

/**
 * Izin global ditimpa izin milik agent yang sedang aktif (Q21).
 *
 * Inilah yang membuat "Build Auto" dan "Build Manual" berbeda: keduanya punya
 * tool yang sama persis, hanya kebijakan izinnya yang berbeda.
 */
export function effectivePermission(
  config: Config,
  agentID?: string,
  agent?: Agent,
): EffectivePermission {
  const base = config.permission
  const override = agent?.permission
  return {
    edit: override?.edit ?? base.edit,
    write: override?.write ?? base.write,
    bash: override?.bash ?? base.bash,
    network: override?.network ?? base.network,
    delete: override?.delete ?? base.delete,
    mcp: override?.mcp ?? base.mcp,
    allowlist: [...base.allowlist, ...(override?.allowlist ?? [])],
    ...(override && agentID ? { source: agentID } : {}),
  }
}

export interface AskOptions {
  sessionID: string
  kind: PermissionKind
  title: string
  detail: string
  pattern: string
  /**
   * Bagian perintah yang masing-masing harus diizinkan allowlist. Diisi oleh
   * `bash`; tool lain membiarkannya kosong dan `pattern`-nya yang dicocokkan.
   *
   * Untuk `kind: "bash"` ini WAJIB ada dan tidak boleh kosong agar allowlist
   * bisa menyala sama sekali — lihat `matchAllowlist`.
   */
  segments?: string[]
  permission: EffectivePermission
  /** Jumlah klien yang sedang mendengarkan sesi ini. 0 berarti tolak. */
  listeners: number
  signal?: AbortSignal
  /** Nama agent yang meminta, untuk dialog saat beberapa sub-agent berjalan. */
  agent?: string
  /**
   * Sesi yang dipakai allowlist "always". Default `sessionID`.
   *
   * `prompt()` mengirim id sesi INDUK di sini untuk giliran sub-agent —
   * turunan yang sama seperti `isChild`, dibaca dari state sesi tersimpan,
   * bukan diteruskan lewat `runSubagent`. Nilai yang harus diingat pemanggil
   * adalah nilai yang akan terlupa, dan di sini lupa berarti user ditanya
   * pertanyaan yang sama sekali per sub-agent.
   */
  allowlistSessionID?: string
  /**
   * True kalau permintaan ini datang dari giliran sub-agent. Membuat jawaban
   * "always" masuk ke allowlist KHUSUS GILIRAN (lihat `turnAllowlist`) alih-alih
   * allowlist permanen sesi — tanpa ini, izin sekali-pakai untuk satu
   * sub-agent akan hidup selamanya dan diwarisi sub-agent lain di masa depan.
   */
  turnScoped?: boolean
  /**
   * Sesi yang stream event-nya harus menerima permintaan ini. Default
   * `sessionID`.
   *
   * Ini KONSEP YANG BERBEDA dari `allowlistSessionID`, meski nilainya sama di
   * kedalaman satu tingkat yang diizinkan sistem sekarang: yang itu menjawab
   * "izin ini milik giliran siapa", ini menjawab "klien mana yang benar-benar
   * mendengarkan". TUI/CLI/server hanya berlangganan stream sesi PALING ATAS
   * (lihat `client.events(session.id, …)` di `src/tui/app.tsx`) — event yang
   * disiarkan ke id sesi ANAK sendiri tidak akan pernah punya pendengar, dan
   * `listeners` yang dihitung dari sana selalu nol, sehingga `ask()` auto-deny
   * sebelum dialognya sempat dibuat.
   */
  streamSessionID?: string
}

export async function ask(options: AskOptions): Promise<PermissionResult> {
  const policy = options.permission[options.kind]
  const from = options.permission.source ? `agent "${options.permission.source}"` : "config"

  if (policy === "deny") {
    return { granted: false, reason: `Denied by ${from}: ${options.kind} = "deny".` }
  }
  if (policy === "allow") {
    return { granted: true, reason: `Allowed by ${from}: ${options.kind} = "allow".` }
  }

  const allowlistSessionID = options.allowlistSessionID ?? options.sessionID
  const configAllowlist = options.permission.allowlist
  const matched = matchAllowlist(
    [
      ...configAllowlist,
      ...allowlistFor(allowlistSessionID),
      ...turnAllowlistFor(allowlistSessionID),
    ],
    options,
  )
  if (matched) return { granted: true, reason: `Matched allowlist: "${matched}".` }

  // Sama seperti allowlist: sub-agent memeriksa --auto INDUKNYA, bukan
  // dirinya sendiri — `setAutoApprove` hanya pernah dipanggil untuk sesi
  // top-level yang membawa `--auto`, dan tanpa ini setiap tulisan pertama
  // sub-agent jatuh ke pengecekan listener di bawah lalu ditolak, meski user
  // sudah mengaktifkan --auto.
  if (autoSessions.has(allowlistSessionID)) {
    return { granted: true, reason: "--auto mode is on." }
  }

  // Sesi yang stream event-nya benar-benar didengarkan klien — lihat komentar
  // `streamSessionID` di atas. `listeners` di bawah SUDAH dihitung pemanggil
  // berdasarkan target ini (`bus.listenerCount(streamSessionID)`), bukan
  // sesi yang secara harfiah bertanya.
  const streamSessionID = options.streamSessionID ?? options.sessionID

  // Inti Q17. Tanpa klien, tidak ada yang bisa menjawab dialog — jadi jangan
  // menggantung, dan jangan mengizinkan.
  if (options.listeners === 0) {
    return {
      granted: false,
      reason:
        "Auto-denied: no client is connected to answer the permission request. " +
        "For automation use --auto, or add a pattern to permission.allowlist.",
    }
  }

  const request: PermissionRequest = {
    id: `perm_${crypto.randomUUID()}`,
    // Disiarkan ke `streamSessionID`, BUKAN `options.sessionID`: itulah satu
    // -satunya id yang klien (TUI/CLI/server) benar-benar berlangganan. Sama
    // dengan bagaimana `subagent.updated` menyiarkan ke sesi INDUK di
    // `src/core/subagent.ts` — pola yang sama, alasan yang sama.
    sessionID: streamSessionID,
    kind: options.kind,
    title: options.title,
    detail: options.detail,
    pattern: options.pattern,
    created: Date.now(),
    ...(options.agent ? { agent: options.agent } : {}),
  }

  return new Promise<PermissionResult>((resolve) => {
    const settle = (result: PermissionResult) => {
      pending.delete(request.id)
      bus.publish({
        type: "permission.resolved",
        sessionID: request.sessionID,
        permissionID: request.id,
        granted: result.granted,
      })
      resolve(result)
    }

    pending.set(request.id, {
      request,
      allowlistSessionID,
      turnScoped: options.turnScoped ?? false,
      resolve: settle,
    })
    options.signal?.addEventListener(
      "abort",
      () => {
        if (pending.has(request.id)) settle({ granted: false, reason: "Cancelled." })
      },
      { once: true },
    )

    bus.publish({ type: "permission.request", sessionID: request.sessionID, request })
  })
}

export function respond(permissionID: string, decision: PermissionDecision): boolean {
  const entry = pending.get(permissionID)
  if (!entry) return false

  if (decision === "reject") {
    entry.resolve({ granted: false, reason: "Refused by user." })
    return true
  }
  if (decision === "always") {
    // Sub-agent menulis ke gudang KHUSUS GILIRAN, bukan allowlist permanen —
    // lihat komentar `turnAllowlist`. Grant top-level tetap permanen, seperti
    // sebelum fitur sub-agent ada.
    if (entry.turnScoped) rememberForTurn(entry.allowlistSessionID, entry.request.pattern)
    else remember(entry.allowlistSessionID, entry.request.pattern)
  }
  entry.resolve({
    granted: true,
    reason:
      decision === "always"
        ? entry.turnScoped
          ? "Allowed for the rest of this turn."
          : "Allowed for the rest of this session."
        : "Allowed once.",
  })
  return true
}

export function listPending(sessionID?: string): PermissionRequest[] {
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => sessionID === undefined || request.sessionID === sessionID)
}
