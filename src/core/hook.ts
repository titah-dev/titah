import { spawn } from "node:child_process"
import type { Config } from "./schema.ts"
import type { ToolAfter, ToolBefore } from "./plugin.ts"

/**
 * Kait berupa PERINTAH SHELL, ditulis langsung di config.
 *
 * # Apa yang sebenarnya kurang
 *
 * Titah sudah punya `tool.before` dan `tool.after` — tapi hanya lewat plugin
 * npm. Untuk memasang satu aturan seperti "jalankan formatter setelah tiap
 * edit", orang harus membuat paket JavaScript, menulis factory, lalu
 * mendaftarkannya. Itu ongkos yang jauh lebih besar daripada aturannya.
 *
 * Yang ditambahkan di sini bukan kait baru, melainkan CARA KEDUA memasang kait
 * yang sudah ada — dan cara yang lebih murah untuk hal-hal yang memang cuma
 * satu baris perintah.
 *
 * # Kenapa memakai titik kait yang SAMA dengan plugin
 *
 * Dua tempat berbeda yang sama-sama bisa menolak sebuah tool call adalah dua
 * tempat yang harus dijaga sepakat tentang urutan, tentang apa yang terjadi
 * saat keduanya menolak, dan tentang siapa yang melihat masukan yang sudah
 * diubah. Di sini keduanya melewati `runBefore`/`runAfter` yang sama: plugin
 * dulu, lalu kait shell.
 *
 * # Kontraknya, dan kenapa asimetris
 *
 * `tool.before` — keluar bukan-nol berarti TOLAK, dan stderr jadi alasannya.
 * Kait yang gagal dijalankan juga menolak: penjaga yang diam saat rusak lebih
 * buruk daripada tidak ada penjaga, karena kegagalannya persis terjadi pada
 * panggilan yang mungkin ingin ia hentikan.
 *
 * `tool.after` — keluar bukan-nol TIDAK membatalkan apa pun; pekerjaannya sudah
 * terjadi. Tapi stderr-nya ditempelkan ke keluaran tool, supaya modelnya tahu.
 * Formatter yang gagal dan tidak pernah disebut adalah formatter yang dianggap
 * berhasil oleh semua orang.
 */

const DEFAULT_TIMEOUT = 30_000

export interface HookOutcome {
  /** Perintah yang dijalankan, untuk disebut dalam pesan. */
  run: string
  code: number | null
  stderr: string
  stdout: string
  timedOut: boolean
}

/**
 * Kait mana yang berlaku untuk sebuah tool.
 *
 * `match` adalah regex atas NAMA tool, dan ketiadaannya berarti semua tool.
 * Regex yang tidak sah tidak pernah cocok — dan itu dilaporkan lewat
 * `titah doctor`, bukan didiamkan di sini: menolak seluruh giliran karena satu
 * pola salah ketik jauh lebih merugikan daripada kait yang tidak menyala.
 */
export function hooksFor(
  config: Config,
  event: "tool.before" | "tool.after",
  tool: string,
): { run: string; timeout?: number }[] {
  return (config.hooks[event] ?? []).filter((hook) => {
    if (hook.match === undefined) return true
    try {
      return new RegExp(hook.match).test(tool)
    } catch {
      return false
    }
  })
}

/**
 * Menjalankan satu kait, memberi peristiwanya lewat stdin sebagai JSON.
 *
 * Lewat stdin, bukan argumen: masukan tool bisa berisi seluruh isi berkas, dan
 * baris perintah punya batas panjang yang berbeda-beda antar sistem. Yang
 * gagal karena terlalu panjang akan gagal hanya pada berkas besar — kegagalan
 * yang muncul sesekali dan mustahil dihubungkan dengan sebabnya.
 *
 * Beberapa nilai juga dipasang sebagai env var, karena `$TITAH_TOOL` di skrip
 * satu baris jauh lebih ringan daripada mengurai JSON.
 */
export function runHook(
  hook: { run: string; timeout?: number },
  event: ToolBefore | (ToolAfter & { output?: string }),
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn(hook.run, {
      cwd: event.cwd,
      shell: true,
      env: {
        ...process.env,
        TITAH_TOOL: event.tool,
        TITAH_SESSION: event.sessionID,
        TITAH_CWD: event.cwd,
      },
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, hook.timeout ?? DEFAULT_TIMEOUT)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ run: hook.run, code: null, stdout, stderr: error.message, timedOut })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ run: hook.run, code, stdout, stderr, timedOut })
    })

    try {
      child.stdin?.end(JSON.stringify(event))
    } catch {
      // Kait yang tidak membaca stdin menutupnya lebih dulu; itu bukan
      // kesalahan, dan EPIPE di sini tidak boleh menjatuhkan giliran.
    }
  })
}

/** Ringkasan satu baris untuk pesan penolakan atau catatan. */
function why(outcome: HookOutcome): string {
  if (outcome.timedOut) return `timed out after ${DEFAULT_TIMEOUT / 1000}s`
  const said = outcome.stderr.trim() || outcome.stdout.trim()
  return said === "" ? `exited ${outcome.code}` : said.split("\n").slice(0, 5).join(" ")
}

export async function runBeforeHooks(
  config: Config,
  event: ToolBefore,
): Promise<{ deny?: string } | undefined> {
  for (const hook of hooksFor(config, "tool.before", event.tool)) {
    const outcome = await runHook(hook, event)
    if (outcome.code === 0) continue
    return { deny: `hook "${hook.run}" refused this call: ${why(outcome)}` }
  }
  return undefined
}

export async function runAfterHooks(
  config: Config,
  event: ToolAfter,
): Promise<{ output: string }> {
  let output = event.output

  for (const hook of hooksFor(config, "tool.after", event.tool)) {
    const outcome = await runHook(hook, { ...event, output })
    if (outcome.code === 0) continue
    /*
     * Ditempelkan ke keluaran tool, bukan diterbitkan sebagai notice.
     *
     * Yang perlu tahu formatter baru saja gagal adalah MODEL — ia yang akan
     * memutuskan apakah perlu memperbaikinya. Notice hanya sampai ke layar
     * user, dan model melanjutkan pekerjaan di atas berkas yang ia kira rapi.
     */
    output += `\n\n[hook "${hook.run}" failed: ${why(outcome)}]`
  }

  return { output }
}
