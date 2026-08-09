import fs from "node:fs"
import path from "node:path"
import { snapshotDir, toolOutputDir } from "./paths.ts"
import { shadowDirName } from "./snapshot.ts"
import { database } from "./storage/db.ts"
import { listMessages, listSessions, pruneEmptySessions, pruneSessions } from "./storage/session.ts"

/**
 * Retensi yang menyapu SELURUH penyimpanan, bukan cuma baris DB.
 *
 * Menghapus sesi tanpa menyapu `tool-output/` dan `snapshot/` meninggalkan
 * direktori yang tumbuh selamanya — persis pola yang membuat DB opencode di
 * mesin pengembang membengkak jadi 580 MB, hanya berpindah tempat.
 */

export interface PruneResult {
  sessions: number
  files: number
  bytes: number
  snapshots: number
}

function directorySize(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directorySize(full)
    else {
      try {
        total += fs.statSync(full).size
      } catch {
        // file hilang di tengah sapuan — abaikan
      }
    }
  }
  return total
}

/** Semua `outputRef` yang masih disebut oleh pesan mana pun. */
export function referencedOutputs(): Set<string> {
  const referenced = new Set<string>()
  for (const session of listSessions(Number.MAX_SAFE_INTEGER)) {
    for (const message of listMessages(session.id)) {
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (part.state.status === "completed" && part.state.outputRef) {
          referenced.add(path.resolve(part.state.outputRef))
        }
      }
    }
  }
  return referenced
}

/** Direktori proyek yang masih punya sesi. */
function liveDirectories(): Set<string> {
  const live = new Set<string>()
  for (const session of listSessions(Number.MAX_SAFE_INTEGER)) {
    live.add(path.resolve(session.directory))
  }
  return live
}

/**
 * Menghapus blob tool-output yang tidak lagi disebut pesan mana pun.
 * Dijalankan SETELAH sesi dihapus, supaya referensinya sudah hilang.
 */
export function sweepToolOutput(): { files: number; bytes: number } {
  const dir = toolOutputDir()
  const referenced = referencedOutputs()
  let files = 0
  let bytes = 0

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { files: 0, bytes: 0 }
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.resolve(dir, entry.name)
    if (referenced.has(full)) continue
    try {
      bytes += fs.statSync(full).size
      fs.rmSync(full, { force: true })
      files += 1
    } catch {
      // dihapus proses lain — bukan masalah
    }
  }

  return { files, bytes }
}

/**
 * Menghapus repo snapshot milik direktori yang sudah tidak punya sesi ATAU
 * sudah tidak ada di disk.
 *
 * Snapshot dipertahankan selama proyeknya masih hidup — `titah undo` untuk
 * giliran lama harus tetap mungkin selama sesinya belum di-prune.
 */
export function sweepSnapshots(): { snapshots: number; bytes: number } {
  const root = snapshotDir()
  const live = liveDirectories()

  // Peta hash → direktori dibangun dari sesi yang hidup; hash yang tidak ada di
  // peta berarti proyeknya sudah tidak punya sesi sama sekali.
  const liveHashes = new Set<string>()
  for (const directory of live) {
    liveHashes.add(shadowDirName(directory))
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { snapshots: 0, bytes: 0 }
  }

  let snapshots = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (liveHashes.has(entry.name)) continue
    const full = path.join(root, entry.name)
    bytes += directorySize(full)
    fs.rmSync(full, { recursive: true, force: true })
    snapshots += 1
  }

  return { snapshots, bytes }
}

/**
 * Sesi kosong yang lebih tua dari ini disapu ikut `prune`.
 *
 * Satu jam, bukan nol: sesi kosong yang baru dibuat kemungkinan besar sedang
 * dibuka klien lain yang belum sempat mengetik.
 */
const EMPTY_SESSION_GRACE_MS = 60 * 60 * 1000

export function prune(olderThanMs: number): PruneResult {
  const { sessions } = pruneSessions(olderThanMs)
  // Sesi kosong yang tertinggal karena Titah tidak sempat membersihkan diri.
  const empty = pruneEmptySessions(EMPTY_SESSION_GRACE_MS)
  const outputs = sweepToolOutput()
  const snaps = sweepSnapshots()
  database().exec("VACUUM")

  return {
    sessions: sessions + empty.sessions,
    files: outputs.files,
    bytes: outputs.bytes + snaps.bytes,
    snapshots: snaps.snapshots,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
