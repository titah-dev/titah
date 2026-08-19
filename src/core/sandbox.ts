import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"

/**
 * Pagar di lapisan PROSES, bukan lapisan tool.
 *
 * # Lubang yang ditutupnya
 *
 * Model izin Titah punya delapan sumbu dan yang paling teliti dari tiga agent
 * yang dibandingkan — tapi ia menjaga di lapisan tool. Begitu sebuah perintah
 * `bash` diizinkan, ia berjalan dengan hak penuh milik user: `rm -rf ~`,
 * `curl | sh`, menulis ke `~/.ssh`. Sumbu `delete` mengatur tool `remove`, dan
 * `bash` tidak pernah melewatinya.
 *
 * Ini yang menutup jarak itu, dan HANYA untuk `bash`. Tool lain — `edit`,
 * `write`, `remove` — sudah lewat pemeriksaan path Titah sendiri, dan
 * menyandbox mereka berarti dua pagar yang harus dijaga sepakat.
 *
 * # Kebijakannya, dan kenapa hanya TULIS
 *
 * Baca dibiarkan bebas. Kompiler membaca `/usr/lib`, Node membaca
 * `node_modules` di tempat lain, `git` membaca config global — mengurung
 * bacaan berarti mengurung pekerjaan yang sah, dan user akan mematikan seluruh
 * fiturnya dalam sehari.
 *
 * Yang dikurung: TULIS di luar direktori proyek dan temp. Itu satu-satunya
 * pagar yang menghentikan `rm -rf ~` tanpa menghentikan `npm install`.
 *
 * # GAGAL TERTUTUP, dan itu keputusan yang disengaja
 *
 * Kalau sandbox dinyalakan tapi platformnya tidak mendukung, `bash` DITOLAK —
 * bukan dijalankan tanpa pagar. User yang menyalakannya percaya ada pagar di
 * sana; menjalankannya tanpa pagar sambil diam adalah bentuk kebohongan paling
 * mahal yang bisa dilakukan fitur keamanan.
 */

export type SandboxKind = "seatbelt" | "bubblewrap" | "none"

/**
 * Sandbox apa yang tersedia di mesin ini.
 *
 * Diperiksa dari BERKASNYA, bukan dari `process.platform` saja: macOS tanpa
 * `sandbox-exec` dan Linux tanpa `bwrap` sama-sama ada, dan menganggapnya
 * tersedia karena platformnya cocok berarti gagal saat perintah pertama
 * dijalankan — jauh setelah user mengira dirinya terlindungi.
 */
export function available(): SandboxKind {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return "seatbelt"
  if (process.platform === "linux") {
    for (const dir of (process.env["PATH"] ?? "").split(":")) {
      if (dir && fs.existsSync(path.join(dir, "bwrap"))) return "bubblewrap"
    }
  }
  return "none"
}

/** Direktori yang selalu boleh ditulis, apa pun proyeknya. */
function writable(cwd: string): string[] {
  const dirs = [path.resolve(cwd), os.tmpdir(), "/tmp", "/private/tmp", "/dev", "/private/var/folders"]
  // `realpath` karena `/tmp` di macOS adalah symlink ke `/private/tmp`, dan
  // profil yang menyebut symlinknya saja tidak mengizinkan targetnya.
  return [...new Set(dirs.map((dir) => {
    try {
      return fs.realpathSync(dir)
    } catch {
      return dir
    }
  }))]
}

/**
 * Profil Seatbelt (macOS).
 *
 * `(allow default)` lalu larangan yang spesifik — bukan sebaliknya. Menyusun
 * daftar-putih untuk seluruh syscall yang dibutuhkan `npm`, `git`, dan
 * kompiler adalah pekerjaan tanpa ujung, dan setiap yang terlewat muncul
 * sebagai kegagalan misterius pada satu perintah saja.
 */
export function seatbeltProfile(cwd: string, network: boolean): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"]
  for (const dir of writable(cwd)) {
    lines.push(`(allow file-write* (subpath ${JSON.stringify(dir)}))`)
  }
  if (!network) lines.push("(deny network*)")
  return lines.join("\n")
}

export interface Wrapped {
  command: string
  /** Berkas sementara yang harus dibuang setelah perintahnya selesai. */
  cleanup?: string
}

/**
 * Membungkus satu perintah shell dengan sandbox yang tersedia.
 *
 * Mengembalikan perintahnya APA ADANYA kalau sandbox mati di config — jalur
 * tanpa sandbox tidak boleh berubah bentuk sedikit pun, supaya perilaku lama
 * tetap persis perilaku lama.
 */
export function wrap(config: Config, command: string, cwd: string): Wrapped {
  if (!config.sandbox.bash) return { command }

  const kind = available()
  if (kind === "seatbelt") {
    /*
     * Profil ditulis ke BERKAS, bukan diberikan lewat `-p`.
     *
     * `-p` menaruh seluruh profil di baris perintah, dan profil ini memuat
     * setiap path yang boleh ditulis — pada proyek dengan path panjang ia
     * menabrak batas panjang argumen, dan kegagalannya muncul hanya di
     * sebagian mesin.
     */
    const file = path.join(os.tmpdir(), `titah-sb-${process.pid}-${Date.now()}.sb`)
    fs.writeFileSync(file, seatbeltProfile(cwd, config.sandbox.network), { mode: 0o600 })
    return {
      command: `/usr/bin/sandbox-exec -f ${JSON.stringify(file)} /bin/sh -c ${JSON.stringify(command)}`,
      cleanup: file,
    }
  }

  if (kind === "bubblewrap") {
    const binds = writable(cwd).flatMap((dir) => (fs.existsSync(dir) ? ["--bind", dir, dir] : []))
    const net = config.sandbox.network ? [] : ["--unshare-net"]
    const args = [
      "bwrap",
      "--ro-bind", "/", "/",
      ...binds,
      "--dev", "/dev",
      "--proc", "/proc",
      ...net,
      "--chdir", cwd,
      "/bin/sh", "-c", command,
    ]
    return { command: args.map((a) => JSON.stringify(a)).join(" ") }
  }

  /*
   * Tidak ada sandbox di mesin ini, dan config memintanya. Ditolak, bukan
   * dijalankan tanpa pagar — lihat komentar berkas ini.
   */
  throw new SandboxUnavailable(
    process.platform === "darwin"
      ? "sandbox.bash is on, but /usr/bin/sandbox-exec is missing on this Mac."
      : process.platform === "linux"
        ? "sandbox.bash is on, but bwrap (bubblewrap) is not installed. Install it, or set sandbox.bash to false."
        : `sandbox.bash is on, but Titah has no sandbox for ${process.platform}. Set sandbox.bash to false to run without one.`,
  )
}

export class SandboxUnavailable extends Error {}

/** Dibuang setelah perintahnya selesai; kegagalannya tidak pernah penting. */
export function cleanup(wrapped: Wrapped): void {
  if (!wrapped.cleanup) return
  try {
    fs.rmSync(wrapped.cleanup, { force: true })
  } catch {
    // Berkas sementara yang tertinggal di tmp bukan alasan menjatuhkan giliran.
  }
}
