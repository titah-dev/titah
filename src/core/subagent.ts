import path from "node:path"
import type { Agent, Config } from "./schema.ts"

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
