import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { snapshotDir } from "./paths.ts"
import { which } from "./which.ts"

const run = promisify(execFile)

/**
 * Snapshot berbasis git dalam repo BAYANGAN.
 *
 * Repo bayangan (git dir terpisah, work-tree menunjuk ke proyek) dipilih supaya
 * Titah tidak pernah menyentuh `.git` milik user: tidak ada commit liar, tidak
 * ada staging area yang teraduk, tidak ada stash yang tiba-tiba muncul.
 *
 * Ini yang membuat izin "selalu izinkan write" (Q9) terasa aman: apa pun yang
 * ditulis agent bisa dikembalikan persis dengan `/undo`.
 */

const IGNORE = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.log",
]

export class SnapshotError extends Error {}

export function gitAvailable(): boolean {
  return which("git") !== undefined
}

/**
 * Nama direktori repo bayangan untuk sebuah proyek.
 *
 * Diekspor karena retensi perlu tahu snapshot mana milik siapa. Kalau penamaan
 * ini didefinisikan dua kali, penyapuan bisa menghapus snapshot yang salah.
 */
export function shadowDirName(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16)
}

function shadowDir(cwd: string): string {
  return path.join(snapshotDir(), shadowDirName(cwd))
}

async function git(gitDir: string, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["--git-dir", gitDir, "--work-tree", cwd, ...args],
    {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "titah",
        GIT_AUTHOR_EMAIL: "titah@localhost",
        GIT_COMMITTER_NAME: "titah",
        GIT_COMMITTER_EMAIL: "titah@localhost",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  )
  return stdout
}

async function ensureRepo(cwd: string): Promise<string> {
  const gitDir = shadowDir(cwd)
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    fs.mkdirSync(gitDir, { recursive: true })
    await run("git", ["init", "--bare", "--quiet", gitDir])
    // .gitignore proyek tetap dihormati karena ia ada di work-tree; daftar ini
    // hanya jaring pengaman untuk proyek yang belum punya .gitignore.
    fs.mkdirSync(path.join(gitDir, "info"), { recursive: true })
    fs.writeFileSync(path.join(gitDir, "info", "exclude"), `${IGNORE.join("\n")}\n`)
  }
  return gitDir
}

/**
 * Mengambil snapshot seluruh work-tree. Mengembalikan sha commit, atau
 * undefined kalau git tidak tersedia (Titah tetap jalan, hanya tanpa undo).
 */
export async function take(cwd: string): Promise<string | undefined> {
  if (!gitAvailable()) return undefined

  try {
    const gitDir = await ensureRepo(cwd)
    await git(gitDir, cwd, ["add", "-A"])
    const tree = (await git(gitDir, cwd, ["write-tree"])).trim()

    let parent: string | undefined
    try {
      parent = (await git(gitDir, cwd, ["rev-parse", "HEAD"])).trim()
    } catch {
      parent = undefined
    }

    // Kalau isi work-tree tidak berubah, pakai ulang commit sebelumnya.
    if (parent) {
      const parentTree = (await git(gitDir, cwd, ["rev-parse", `${parent}^{tree}`])).trim()
      if (parentTree === tree) return parent
    }

    const commit = (
      await git(gitDir, cwd, [
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        `snapshot ${new Date().toISOString()}`,
      ])
    ).trim()
    await git(gitDir, cwd, ["update-ref", "HEAD", commit])
    return commit
  } catch (error) {
    throw new SnapshotError(
      `Failed to take snapshot: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export interface RestoreResult {
  files: string[]
}

/**
 * Mengembalikan work-tree ke keadaan snapshot.
 *
 * Termasuk menghapus file yang dibuat SETELAH snapshot — kalau tidak, "undo"
 * hanya setengah jalan dan meninggalkan file baru yang tidak diminta siapa pun.
 */
export async function restore(cwd: string, commit: string): Promise<RestoreResult> {
  if (!gitAvailable()) throw new SnapshotError("git is not available, so undo is not possible.")

  const gitDir = shadowDir(cwd)
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    throw new SnapshotError("No snapshot exists for this directory.")
  }

  const changed = (await git(gitDir, cwd, ["diff", "--name-only", commit]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  await git(gitDir, cwd, ["read-tree", commit])
  await git(gitDir, cwd, ["checkout-index", "-f", "-a"])

  // File yang ada di work-tree tapi tidak ada di snapshot harus dibuang.
  const extra = (await git(gitDir, cwd, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (const file of extra) {
    const full = path.resolve(cwd, file)
    if (full.startsWith(path.resolve(cwd) + path.sep)) fs.rmSync(full, { force: true })
  }

  return { files: [...new Set([...changed, ...extra])].sort() }
}
