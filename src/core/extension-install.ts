import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { configDir } from "./paths.ts"
import { extensionRoot } from "./extension.ts"
import { satisfiesEngine } from "../extension.ts"

/**
 * Memasang extension: mengunduh, menyematkan versi, dan mencatat hash.
 *
 * # Kenapa `npm install` dan bukan mengunduh tarball sendiri
 *
 * Mengunduh tarball berarti menulis ekstraksi tar. Node tidak punya tar, jadi
 * pilihannya antara ~150 baris parser header tar atau memanggil `tar` — dan
 * `tar` tidak ada di Windows, yang `paths.ts` sudah menyatakan akan didukung.
 * npm ikut dengan Node, jalan di ketiga sistem, dan sudah memverifikasi
 * integrity serta menarik dependency transitif. Menulis ulang itu berarti
 * menulis ulang bagian yang paling sunyi cara gagalnya.
 *
 * # Bentuk direktorinya
 *
 *   ~/.local/share/titah/extension/
 *     package.json            ← daftar dependency yang Titah kelola
 *     package-lock.json       ← milik npm; sumber hash integrity
 *     node_modules/@acme/titah-git/
 *
 * Ini proyek npm biasa yang kebetulan dimiliki Titah, bukan proyek user. Itu
 * inti Q17: extension adalah preferensi ORANG, bukan dependency PROYEK.
 *
 * # Kenapa lockfile-nya ada di ~/.config dan bukan di sebelah node_modules
 *
 * `paths.ts` sudah menyatakan maksud kedua direktori: `configDir` untuk yang
 * boleh dibaca manusia dan di-commit, `dataDir` untuk state. Lockfile extension
 * adalah berkas yang memang ingin dibawa ke dotfiles — ia yang membuat "panel
 * yang sama di laptop dan di server" jadi mungkin. `package-lock.json` milik npm
 * tetap di dataDir sebagai kebenaran mesin, dan lockfile kita DITURUNKAN
 * darinya setiap kali — tidak pernah dirawat terpisah, karena dua berkas yang
 * merawat fakta yang sama akan menyimpang.
 */

export interface LockEntry {
  version: string
  /** `sha512-<base64>` dari registry npm. Kosong kalau npm tidak melaporkannya. */
  integrity?: string
}

export interface Lockfile {
  version: 1
  extension: Record<string, LockEntry>
}

export function lockfilePath(): string {
  return path.join(configDir(), "extension-lock.json")
}

export function readLockfile(file: string = lockfilePath()): Lockfile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Lockfile>
    if (parsed.version !== 1 || typeof parsed.extension !== "object" || parsed.extension === null) {
      return { version: 1, extension: {} }
    }
    return { version: 1, extension: parsed.extension }
  } catch {
    /*
     * Lockfile yang hilang atau rusak diperlakukan sebagai kosong, BUKAN sebagai
     * kegagalan yang menghentikan segalanya — kebalikan dari perlakuan terhadap
     * config user di `config-edit.ts`, dan bedanya disengaja: lockfile bisa
     * dibangun ulang dari apa yang terpasang, config tidak bisa dibangun ulang
     * dari apa pun.
     */
    return { version: 1, extension: {} }
  }
}

export function writeLockfile(lock: Lockfile, file: string = lockfilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, file)
}

/** Menjalankan sebuah perintah. Disuntikkan supaya test tidak memanggil npm. */
export type Runner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>

export const spawnRunner: Runner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

export class InstallError extends Error {}

export interface InstallOptions {
  /** Nama paket npm. Bentuk `./path` dan `market:` tidak dipasang lewat sini. */
  packageName: string
  /** Versi yang disematkan. Kosong berarti ambil dari lockfile, lalu `latest`. */
  version?: string
  root?: string
  lockFile?: string
  run?: Runner
}

export interface InstallResult {
  packageName: string
  version: string
  integrity?: string
  /** `false` kalau versi yang diminta memang sudah terpasang. */
  changed: boolean
}

/**
 * Memastikan direktori extension adalah proyek npm yang sah.
 *
 * `private: true` supaya tidak pernah bisa dipublish karena salah ketik, dan
 * nama yang menyebut Titah supaya orang yang menemukan direktori ini tahu siapa
 * yang membuatnya.
 */
function ensureRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true })
  const manifest = path.join(root, "package.json")
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({ name: "titah-extensions", private: true, version: "0.0.0", dependencies: {} }, null, 2)}\n`,
    )
  }
}

/** Versi yang benar-benar terpasang, dibaca dari berkasnya. */
export function installedVersion(root: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", packageName, "package.json"), "utf8"),
    ) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}

/**
 * Hash integrity dari `package-lock.json` milik npm.
 *
 * Dibaca dari sana dan tidak dihitung sendiri: npm sudah memverifikasinya
 * terhadap registry saat mengunduh, dan menghitung ulang dari berkas yang sudah
 * diekstrak hanya membuktikan bahwa berkas itu adalah dirinya sendiri.
 */
export function integrityFrom(root: string, packageName: string): string | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: string }>
    }
    return lock.packages?.[`node_modules/${packageName}`]?.integrity
  } catch {
    return undefined
  }
}

/**
 * Memasang satu extension npm dan memperbarui lockfile.
 *
 * Versi diambil berurutan: yang diminta pemanggil, lalu lockfile, lalu `latest`.
 * Lockfile mendahului `latest` karena itulah gunanya — memasang di mesin kedua
 * harus menghasilkan kode yang sama, bukan kode terbaru.
 */
export async function installExtension(options: InstallOptions): Promise<InstallResult> {
  const root = options.root ?? extensionRoot()
  const lockFile = options.lockFile ?? lockfilePath()
  const run = options.run ?? spawnRunner
  const lock = readLockfile(lockFile)

  const wanted = options.version ?? lock.extension[options.packageName]?.version
  const current = installedVersion(root, options.packageName)
  if (wanted !== undefined && current === wanted) {
    return { packageName: options.packageName, version: current, changed: false }
  }

  ensureRoot(root)
  const target = wanted === undefined ? options.packageName : `${options.packageName}@${wanted}`
  const result = await run(
    "npm",
    ["install", target, "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error"],
    root,
  )
  if (result.code !== 0) {
    /*
     * stderr npm yang diteruskan apa adanya, bukan diganti kalimat sendiri.
     * "Failed to install" tidak memberi tahu apa pun; baris npm yang sebenarnya
     * menyebut 404, EACCES, atau ETARGET — dan itu yang menentukan langkah
     * berikutnya.
     */
    throw new InstallError(`npm install ${target} failed:\n${result.stderr.trim() || result.stdout.trim()}`)
  }

  const version = installedVersion(root, options.packageName)
  if (version === undefined) {
    throw new InstallError(
      `npm reported success but ${options.packageName} is not in ${root}/node_modules — refusing to lock a version that is not there.`,
    )
  }

  const integrity = integrityFrom(root, options.packageName)
  lock.extension[options.packageName] = { version, ...(integrity !== undefined ? { integrity } : {}) }
  writeLockfile(lock, lockFile)

  return { packageName: options.packageName, version, ...(integrity !== undefined ? { integrity } : {}), changed: true }
}

export type Fetcher = (url: string) => Promise<string>

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.text()
}

/**
 * Versi TERBARU yang `engines.titah`-nya masih menerima Titah ini.
 *
 * Bukan `dist-tags.latest`, dan bedanya menentukan. Extension yang menuntut
 * `^0.5.0` akan jadi `latest` di npm sementara Titah masih 0.4.0 — memasangnya
 * berarti mengganti extension yang bekerja dengan yang tidak bisa dimuat, dan
 * pesan kegagalannya baru muncul di sesi berikutnya, jauh dari perintah yang
 * menyebabkannya.
 *
 * Metadata `engines` ada di dalam packument, jadi ini bisa diketahui SEBELUM
 * mengunduh apa pun.
 */
export async function latestCompatible(
  packageName: string,
  titahVersion: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ version?: string; rejected: { version: string; needs: string }[] }> {
  const text = await fetcher(`https://registry.npmjs.org/${packageName.replace("/", "%2F")}`)
  const packument = JSON.parse(text) as {
    versions?: Record<string, { engines?: { titah?: string }; deprecated?: string }>
  }
  const versions = Object.entries(packument.versions ?? {})
    // Prerelease dilewati: ia tidak pernah yang dimaksud orang saat mengetik
    // `update`, dan menariknya diam-diam adalah kejutan yang tidak diminta.
    .filter(([version]) => !version.includes("-"))
    .filter(([, meta]) => meta.deprecated === undefined)
    .sort(([left], [right]) => (satisfiesEngine(left, `>=${right}`) ? -1 : 1))

  const rejected: { version: string; needs: string }[] = []
  for (const [version, meta] of versions) {
    const needs = meta.engines?.titah
    if (needs !== undefined && satisfiesEngine(titahVersion, needs)) return { version, rejected }
    if (needs !== undefined) rejected.push({ version, needs })
  }
  return { rejected }
}

export interface UpdateResult {
  packageName: string
  from?: string
  to?: string
  changed: boolean
  /** Versi yang lebih baru tapi menuntut Titah lain. Untuk dikatakan, bukan disembunyikan. */
  blocked: { version: string; needs: string }[]
}

/**
 * Memindahkan lockfile ke versi terbaru yang kompatibel, lalu memasangnya.
 *
 * Ada sebagai perintah TERSENDIRI dan bukan sebagai perilaku `install`, karena
 * keduanya menjawab pertanyaan yang berbeda. `install` menghormati lockfile —
 * itu seluruh gunanya lockfile, dan `install` yang diam-diam menaikkan versi
 * membuat "kode yang sama di dua mesin" jadi harapan lagi. `update` adalah
 * tempat user MENYATAKAN bahwa ia ingin bergerak maju.
 */
export async function updateExtension(
  options: InstallOptions & { titahVersion: string; fetcher?: Fetcher },
): Promise<UpdateResult> {
  const root = options.root ?? extensionRoot()
  const lockFile = options.lockFile ?? lockfilePath()
  const from = installedVersion(root, options.packageName) ?? readLockfile(lockFile).extension[options.packageName]?.version

  const { version, rejected } = await latestCompatible(
    options.packageName,
    options.titahVersion,
    options.fetcher ?? defaultFetcher,
  )

  if (version === undefined) {
    return { packageName: options.packageName, ...(from ? { from } : {}), changed: false, blocked: rejected }
  }
  if (version === from) {
    return { packageName: options.packageName, from, to: version, changed: false, blocked: rejected }
  }

  const result = await installExtension({ ...options, version })
  return {
    packageName: options.packageName,
    ...(from ? { from } : {}),
    to: result.version,
    changed: result.changed,
    blocked: rejected,
  }
}

/**
 * Mencabut satu extension: membuang paketnya dan entri lockfile-nya.
 *
 * Entri lockfile dibuang meski npm gagal. Lockfile yang menyebut paket yang
 * tidak ada akan membuat pemasangan berikutnya menyematkan versi lama tanpa
 * alasan yang bisa dilihat siapa pun.
 */
export async function removeExtension(options: InstallOptions): Promise<void> {
  const root = options.root ?? extensionRoot()
  const lockFile = options.lockFile ?? lockfilePath()
  const run = options.run ?? spawnRunner

  const lock = readLockfile(lockFile)
  delete lock.extension[options.packageName]
  writeLockfile(lock, lockFile)

  if (!fs.existsSync(path.join(root, "package.json"))) return
  await run("npm", ["uninstall", options.packageName, "--no-audit", "--no-fund", "--loglevel=error"], root)
}
