import { spawn, type ChildProcess } from "node:child_process"

/**
 * Proses yang hidup lebih lama dari satu panggilan tool (gap 4).
 *
 * `bash` mem-spawn, menunggu, lalu mati — jadi agent TIDAK BISA menyalakan dev
 * server lalu mengetesnya, tidak bisa menonton `tsc --watch`, tidak bisa
 * menjalankan build lima belas menit sambil mengerjakan hal lain. Itu satu kelas
 * tugas utuh yang hilang, bukan satu ketidaknyamanan.
 *
 * Yang disimpan di sini sengaja SEDIKIT: satu registry proses, output bersangga
 * cincin, dan status. Tidak ada penjadwalan, tidak ada dependensi antarproses,
 * tidak ada restart otomatis. Semua itu bisa ditambahkan nanti kalau ternyata
 * dibutuhkan; yang tidak bisa ditarik kembali adalah permukaan yang terlanjur
 * dijanjikan.
 */

/**
 * Batas sangga per proses.
 *
 * Cincin, bukan potong-di-akhir: proses yang mencetak selamanya tidak boleh
 * menghabiskan RAM, dan yang dibuang adalah yang PALING LAMA. Pada log, yang
 * baru hampir selalu yang dicari — kebalikan dari berkas, di mana awalnya yang
 * penting.
 */
const MAX_BUFFER = 256 * 1024

/**
 * Batas jumlah proses hidup, per sesi.
 *
 * Tanpa hook teardown sesi di codebase ini (tidak ada satu pun pemanggil
 * `clearSession` di `src/`), proses hidup sampai Titah keluar. Batas ini yang
 * mencegah giliran yang salah arah meninggalkan lima puluh dev server.
 */
const MAX_PER_SESSION = 8

export type ProcessStatus = "running" | "exited" | "killed"

interface Entry {
  id: string
  sessionID: string
  command: string
  child: ChildProcess
  buffer: string
  /** Byte yang sudah dibuang cincin, supaya pembaca tahu ada yang hilang. */
  dropped: number
  /** Posisi baca terakhir, supaya `bash_output` bisa memberi yang BARU saja. */
  cursor: number
  status: ProcessStatus
  exitCode: number | null
  started: number
}

const running = new Map<string, Entry>()
let counter = 0

function append(entry: Entry, chunk: string): void {
  entry.buffer += chunk
  if (entry.buffer.length <= MAX_BUFFER) return
  const overflow = entry.buffer.length - MAX_BUFFER
  entry.buffer = entry.buffer.slice(overflow)
  entry.dropped += overflow
  // Kursor ikut digeser: tanpa ini ia menunjuk ke teks yang sudah dibuang, dan
  // pembacaan berikutnya mengembalikan potongan yang salah — diam-diam.
  entry.cursor = Math.max(0, entry.cursor - overflow)
}

export interface StartResult {
  id: string
  command: string
}

export function startProcess(sessionID: string, command: string, cwd: string): StartResult {
  const live = [...running.values()].filter(
    (entry) => entry.sessionID === sessionID && entry.status === "running",
  )
  if (live.length >= MAX_PER_SESSION) {
    throw new Error(
      `${live.length} background processes are already running in this session ` +
        `(the limit is ${MAX_PER_SESSION}). Stop one with bash_stop first.`,
    )
  }

  const child = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    // Grup sendiri, supaya `bash_stop` bisa membunuh SELURUH pohonnya. Dev
    // server yang menjalankan child-nya sendiri adalah kasus normal, bukan
    // kasus tepi, dan membunuh hanya induknya meninggalkan port tetap terpakai.
    detached: true,
  })

  const id = `proc_${(counter += 1)}`
  const entry: Entry = {
    id,
    sessionID,
    command,
    child,
    buffer: "",
    dropped: 0,
    cursor: 0,
    status: "running",
    exitCode: null,
    started: Date.now(),
  }

  child.stdout?.on("data", (chunk: Buffer) => append(entry, chunk.toString("utf8")))
  child.stderr?.on("data", (chunk: Buffer) => append(entry, chunk.toString("utf8")))
  child.on("error", (error) => append(entry, `\n[failed to start: ${error.message}]\n`))
  child.on("close", (code, signal) => {
    entry.status = signal === null ? "exited" : "killed"
    entry.exitCode = code
  })

  running.set(id, entry)
  return { id, command }
}

export interface OutputResult {
  id: string
  command: string
  status: ProcessStatus
  exitCode: number | null
  text: string
  dropped: number
  runningMs: number
}

export function readProcess(id: string, all: boolean): OutputResult {
  const entry = running.get(id)
  if (!entry) throw new Error(`No background process ${id}. It may have been cleaned up.`)

  const text = all ? entry.buffer : entry.buffer.slice(entry.cursor)
  entry.cursor = entry.buffer.length

  return {
    id,
    command: entry.command,
    status: entry.status,
    exitCode: entry.exitCode,
    text,
    dropped: entry.dropped,
    runningMs: Date.now() - entry.started,
  }
}

export function stopProcess(id: string): OutputResult {
  const entry = running.get(id)
  if (!entry) throw new Error(`No background process ${id}.`)

  if (entry.status === "running" && entry.child.pid !== undefined) {
    try {
      // Negatif = seluruh grup proses. Lihat `detached` di atas.
      process.kill(-entry.child.pid, "SIGTERM")
    } catch {
      // Sudah mati di antara pemeriksaan dan sinyal. Bukan kesalahan.
    }
    entry.status = "killed"
  }
  return readProcess(id, false)
}

export function listProcesses(sessionID: string): OutputResult[] {
  return [...running.values()]
    .filter((entry) => entry.sessionID === sessionID)
    .map((entry) => ({
      id: entry.id,
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      text: "",
      dropped: entry.dropped,
      runningMs: Date.now() - entry.started,
    }))
}

/** Dipakai test, dan oleh penutupan proses Titah. */
export function killAllProcesses(): void {
  for (const entry of running.values()) {
    if (entry.status !== "running" || entry.child.pid === undefined) continue
    try {
      process.kill(-entry.child.pid, "SIGKILL")
    } catch {
      // idem
    }
  }
  running.clear()
}

// Proses latar yang selamat dari Titah adalah kebocoran yang user tidak punya
// cara menemukannya — ia tidak muncul di daftar apa pun setelah TUI tutup.
process.on("exit", killAllProcesses)
