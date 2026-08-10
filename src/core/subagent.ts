import path from "node:path"
import { abort, prompt } from "./agent.ts"
import { bus } from "./event.ts"
import type { SubagentState } from "./event.ts"
import { textOf } from "./message.ts"
import type { Agent, Config } from "./schema.ts"
import { createChildSession } from "./storage/session.ts"

/**
 * Penjadwalan sub-agent.
 *
 * Dipisah dari agent.ts supaya bisa diuji tanpa model, tanpa sesi, dan tanpa
 * filesystem — kunci concurrency yang hanya bisa diuji lewat giliran sungguhan
 * adalah kunci yang tidak pernah benar-benar diuji.
 */

/**
 * Pembaca boleh jalan serentak tanpa batas; selain itu penulis, dan penulis antre.
 *
 * `bash` ikut dihitung: shell yang diizinkan bisa `sed -i`, dan memperlakukannya
 * sebagai pembaca membuka pintu belakang ke persoalan yang serialisasi ini ada
 * untuk mencegahnya. Izin yang TIDAK disebut juga bukan deny — ia mewarisi
 * kebijakan global, yang defaultnya "ask".
 */
export function isReader(agent: Agent): boolean {
  const permission = agent.permission
  if (!permission) return false
  return permission.edit === "deny" && permission.write === "deny" && permission.bash === "deny"
}

/** Ekor antrean penulis per direktori kerja. */
const tail = new Map<string, Promise<unknown>>()

/**
 * Menjalankan `run` setelah penulis sebelumnya di direktori yang sama selesai.
 *
 * Kuncinya per DIREKTORI KERJA, bukan per sesi, karena repo bayangan snapshot
 * memang dikunci di situ. Dua penulis di direktori yang sama akan membuat satu
 * snapshot memuat perubahan keduanya bercampur, dan `/undo` kehilangan cara
 * memisahkan siapa mengubah apa.
 */
export function withWriteLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(cwd)
  const previous = tail.get(key) ?? Promise.resolve()

  // `previous` sendiri TIDAK PERNAH reject — nilai yang tersimpan di `tail`
  // selalu sudah lewat `.catch()` di bawah sebelum disimpan. Jadi cukup satu
  // handler; onRejected di sini tidak akan pernah terpanggil.
  const result = previous.then(run)
  tail.set(
    key,
    // Ini jaring pengamannya: menyerap rejection SEBELUM masuk `tail` supaya
    // giliran berikutnya tetap melihat ekor yang resolve. Kalau kegagalan
    // menahan kunci, satu sub-agent yang error membuat setiap penulis
    // berikutnya di direktori itu menggantung sampai sesi ditutup.
    result.catch(() => undefined),
  )
  return result
}

/** Agent yang boleh dijadikan bawahan. `primary` tidak pernah termasuk. */
export function dispatchableAgents(config: Config): string[] {
  return Object.entries(config.agent)
    .filter(([, agent]) => agent.mode === "subagent" || agent.mode === "all")
    .map(([id]) => id)
}

export interface RunSubagentOptions {
  parentSessionID: string
  agentID: string
  instruction: string
  cwd: string
  config: Config
  signal: AbortSignal
}

export interface SubagentResult {
  answer: string
  childSessionID: string
  status: "done" | "failed" | "stopped"
}

/**
 * Menjalankan satu sub-agent sampai selesai.
 *
 * Pembaca langsung jalan; penulis melewati `withWriteLock` lebih dulu. Statusnya
 * disiarkan ke stream sesi INDUK — TUI hanya berlangganan satu sesi, jadi
 * kemajuan anak yang hanya disiarkan ke sesinya sendiri tidak akan pernah terlihat.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
  const definition = options.config.agent[options.agentID]
  if (!definition || definition.mode === "primary") {
    return {
      answer: `Agent "${options.agentID}" is not dispatchable. Available: ${dispatchableAgents(options.config).join(", ") || "(none)"}.`,
      childSessionID: "",
      status: "failed",
    }
  }

  const child = createChildSession(options.parentSessionID, options.cwd, options.agentID)
  const startedAt = Date.now()

  const publish = (status: SubagentState["status"], note: string) => {
    bus.publish({
      type: "subagent.updated",
      sessionID: options.parentSessionID,
      child: { sessionID: child.id, agent: options.agentID, status, startedAt, note },
    })
  }

  const reader = isReader(definition)
  publish(reader ? "running" : "queued", reader ? "starting" : "waiting for a turn")

  const work = async (): Promise<SubagentResult> => {
    // `withWriteLock` menunda `run`-nya lewat `.then()` bahkan saat antrean
    // kosong — itu SATU microtask, bukan nol. Kalau pembatalan datang tepat di
    // jendela itu, tanpa pengecekan ini giliran anak tetap mulai lewat
    // `prompt()` dan menghabiskan kerja yang seharusnya sudah dibatalkan,
    // padahal hasilnya toh akan dilabeli "stopped" juga di bawah.
    if (options.signal.aborted) {
      publish("stopped", "stopped by user")
      return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
    }

    publish("running", "working")
    try {
      const message = await prompt({
        sessionID: child.id,
        text: options.instruction,
        agent: options.agentID,
      })

      if (options.signal.aborted) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }

      // `prompt()` tidak melempar untuk kegagalan giliran biasa — ia menangkap
      // sendiri dan mengembalikan pesan dengan `.error` terisi. Tanpa
      // pengecekan ini, giliran yang sungguh gagal (bukan dibatalkan) akan
      // dilaporkan "done" dengan jawaban kosong.
      if (message.error !== undefined) {
        publish("failed", message.error)
        return { answer: `FAILED: ${message.error}`, childSessionID: child.id, status: "failed" }
      }

      publish("done", "done")
      return { answer: textOf(message).trim(), childSessionID: child.id, status: "done" }
    } catch (error) {
      if (options.signal.aborted) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }
      const reason = error instanceof Error ? error.message : String(error)
      publish("failed", reason)
      return { answer: `FAILED: ${reason}`, childSessionID: child.id, status: "failed" }
    }
  }

  // Sinyal induk membatalkan giliran anak lewat controller milik sesi anak.
  // Didaftarkan SEBELUM `work` dipanggil, dan `prompt()` mendaftarkan
  // controller giliran anak secara sinkron sebelum await pertamanya — jadi
  // abort yang datang segera setelah fungsi ini dipanggil tidak pernah jatuh
  // di jendela kosong tanpa pendengar (lihat pengecekan di awal `work` untuk
  // jendela `withWriteLock` yang tersisa).
  const stop = () => abort(child.id)
  options.signal.addEventListener("abort", stop, { once: true })
  try {
    return reader ? await work() : await withWriteLock(options.cwd, work)
  } finally {
    options.signal.removeEventListener("abort", stop)
  }
}

function stoppedNote(startedAt: number): string {
  return `STOPPED BY USER after ${Math.round((Date.now() - startedAt) / 1000)}s.`
}
