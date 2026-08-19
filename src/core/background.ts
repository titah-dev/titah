import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { database } from "./storage/db.ts"
import { dataDir } from "./paths.ts"

/**
 * Giliran yang dilepas ke latar, dan terminal yang langsung dikembalikan.
 *
 * # Kenapa proses terpisah, bukan thread atau antrean di dalam satu proses
 *
 * Karena terminalnya harus benar-benar bebas. Giliran latar yang hidup di dalam
 * proses `titah run` yang sama akan mati begitu shell-nya ditutup — dan itu
 * persis keadaan yang membuat orang memakainya: menyalakan pekerjaan panjang
 * lalu pergi.
 *
 * # Kenapa registri di DATABASE, bukan berkas JSON
 *
 * Registri ini ditulis satu proses dan dibaca proses lain. Itu persis keadaan
 * yang membuat berkas JSON rusak: dua penulis yang bertemu di tengah
 * menghasilkan berkas yang tidak bisa diurai siapa pun. SQLite sudah menangani
 * itu, dan sudah ada di sini.
 *
 * # `pid` yang dicatat mungkin sudah mati
 *
 * Proses latar bisa selesai kapan saja, dan tidak ada yang membersihkan
 * barisnya. Karena itu tidak ada kolom `status` sama sekali — status yang
 * disimpan akan basi tanpa ada yang tahu, dan pembacanya akan menampilkan
 * "running" untuk proses yang sudah lama mati. Yang ditanya adalah SISTEM
 * OPERASI, tiap kali dibaca.
 */

export interface BackgroundTurn {
  id: string
  sessionID: string
  pid: number
  prompt: string
  directory: string
  log: string
  started: number
}

export interface BackgroundStatus extends BackgroundTurn {
  /** Ditanyakan ke sistem operasi saat dibaca, bukan dibaca dari kolom. */
  alive: boolean
}

const logDir = (): string => path.join(dataDir(), "background")

/**
 * Apakah prosesnya masih hidup.
 *
 * `kill(pid, 0)` tidak mengirim sinyal apa pun — ia hanya menanyakan apakah
 * proses itu ada dan boleh disinyali. Satu-satunya cara portabel untuk bertanya
 * tanpa mengganggu.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM berarti prosesnya ADA tapi milik user lain — hidup, bukan mati.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function record(turn: Omit<BackgroundTurn, "id" | "started">): BackgroundTurn {
  const entry: BackgroundTurn = {
    ...turn,
    id: `bg_${crypto.randomUUID().slice(0, 8)}`,
    started: Date.now(),
  }
  database()
    .prepare(
      "INSERT INTO background (id, session_id, pid, prompt, directory, log, started) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      entry.id,
      entry.sessionID,
      entry.pid,
      entry.prompt,
      entry.directory,
      entry.log,
      entry.started,
    )
  return entry
}

function toTurn(row: Record<string, unknown>): BackgroundTurn {
  return {
    id: row["id"] as string,
    sessionID: row["session_id"] as string,
    pid: row["pid"] as number,
    prompt: row["prompt"] as string,
    directory: row["directory"] as string,
    log: row["log"] as string,
    started: row["started"] as number,
  }
}

export function listBackground(directory?: string): BackgroundStatus[] {
  const rows = database()
    .prepare(
      /*
       * `rowid` sebagai pemecah seri, dan itu bukan kehalusan: dua giliran yang
       * dilepas dalam milidetik yang sama punya `started` identik, dan urutan
       * tanpa pemecah seri boleh berbeda tiap kali dibaca. Daftar yang
       * urutannya berubah sendiri antara dua pemanggilan membuat orang ragu
       * mana yang baru saja ia mulai.
       */
      "SELECT * FROM background WHERE (? IS NULL OR directory = ?) ORDER BY started DESC, rowid DESC",
    )
    .all(directory ?? null, directory ?? null) as Record<string, unknown>[]

  return rows.map((row) => {
    const turn = toTurn(row)
    return { ...turn, alive: alive(turn.pid) }
  })
}

/** Dicari lewat id penuh atau awalannya — id delapan huruf tetap merepotkan. */
export function findBackground(id: string): BackgroundStatus | undefined {
  const rows = database()
    .prepare(
      "SELECT * FROM background WHERE id = ? OR id LIKE ? ORDER BY started DESC, rowid DESC",
    )
    .all(id, `${id}%`) as Record<string, unknown>[]

  const row = rows[0]
  if (!row) return undefined
  const turn = toTurn(row)
  return { ...turn, alive: alive(turn.pid) }
}

/**
 * Membuang catatan yang prosesnya sudah mati DAN lognya sudah hilang.
 *
 * Catatan yang lognya masih ada sengaja DIPERTAHANKAN meski prosesnya mati:
 * itulah satu-satunya cara membaca hasil pekerjaan yang selesai saat kamu tidak
 * di depan layar. Yang dibuang hanya baris yang tidak menunjuk apa pun lagi.
 */
export function pruneBackground(): number {
  let removed = 0
  for (const turn of listBackground()) {
    if (turn.alive || fs.existsSync(turn.log)) continue
    database().prepare("DELETE FROM background WHERE id = ?").run(turn.id)
    removed += 1
  }
  return removed
}

export function stopBackground(turn: BackgroundTurn): boolean {
  try {
    /*
     * Grup proses, bukan pid tunggal.
     *
     * Giliran latar bisa melahirkan sub-agent dan perintah bash miliknya
     * sendiri. Membunuh induknya saja meninggalkan anak-anak itu berjalan,
     * memakai token, tanpa satu pun cara menemukannya lagi.
     */
    process.kill(-turn.pid, "SIGTERM")
    return true
  } catch {
    try {
      process.kill(turn.pid, "SIGTERM")
      return true
    } catch {
      return false
    }
  }
}

export interface SpawnOptions {
  prompt: string
  directory: string
  sessionID: string
  /** Argumen `titah run` selain promptnya — model, agent, format, dan seterusnya. */
  args: string[]
  /** Perintah yang menjalankan Titah. Dipisah supaya test bisa menggantinya. */
  argv0?: string
  execPath?: string
}

/**
 * Melepas satu giliran ke latar, lalu kembali seketika.
 *
 * `detached: true` plus `unref()` yang memutus tali terakhir: tanpa keduanya,
 * proses induk menunggu anaknya selesai dan seluruh gunanya hilang.
 *
 * Keluarannya ke BERKAS, bukan pipa. Pipa mati bersama induknya, dan yang
 * tersisa adalah pekerjaan yang berjalan tanpa satu pun jejak yang bisa dibaca
 * nanti — kegagalan yang persis kebalikan dari yang diinginkan orang saat
 * melepas sesuatu ke latar.
 */
export function spawnBackground(options: SpawnOptions): BackgroundTurn {
  fs.mkdirSync(logDir(), { recursive: true, mode: 0o700 })
  const log = path.join(logDir(), `${options.sessionID}.log`)
  const handle = fs.openSync(log, "a")

  const child = spawn(
    options.execPath ?? process.execPath,
    [options.argv0 ?? process.argv[1] ?? "titah", "run", ...options.args, options.prompt],
    {
      cwd: options.directory,
      detached: true,
      stdio: ["ignore", handle, handle],
      env: { ...process.env, TITAH_BACKGROUND: "1" },
    },
  )
  child.unref()
  fs.closeSync(handle)

  if (child.pid === undefined) throw new Error("Could not start the background turn.")

  return record({
    sessionID: options.sessionID,
    pid: child.pid,
    prompt: options.prompt,
    directory: options.directory,
    log,
  })
}
