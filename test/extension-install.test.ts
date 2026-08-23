import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  InstallError,
  installExtension,
  installedVersion,
  integrityFrom,
  readLockfile,
  removeExtension,
  writeLockfile,
  type Runner,
} from "../src/core/extension-install.ts"
import { installedExtensions } from "../src/core/extension.ts"

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "titah-install-"))
}

/** Runner palsu: mencatat argumen dan memasang paket seperti npm melakukannya. */
function fakeNpm(options: { version?: string; fail?: string; skipWrite?: boolean } = {}) {
  const calls: string[][] = []
  const run: Runner = async (command, args, cwd) => {
    calls.push([command, ...args])
    if (options.fail !== undefined) return { code: 1, stdout: "", stderr: options.fail }

    const target = args[1] ?? ""
    const at = target.lastIndexOf("@")
    const name = at > 0 ? target.slice(0, at) : target
    const version = at > 0 ? target.slice(at + 1) : (options.version ?? "1.0.0")

    if (args[0] === "uninstall") {
      fs.rmSync(path.join(cwd, "node_modules", name), { recursive: true, force: true })
      return { code: 0, stdout: "", stderr: "" }
    }
    if (options.skipWrite !== true) {
      const dir = path.join(cwd, "node_modules", name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }))
      fs.writeFileSync(
        path.join(cwd, "package-lock.json"),
        JSON.stringify({ packages: { [`node_modules/${name}`]: { integrity: `sha512-fake-${version}` } } }),
      )
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls }
}

test("memasang menyematkan versi dan mencatat integrity hash", async () => {
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm()

  const result = await installExtension({ packageName: "@acme/titah-git", version: "1.2.3", root, lockFile: lock, run: npm.run })

  assert.deepEqual(result, {
    packageName: "@acme/titah-git",
    version: "1.2.3",
    integrity: "sha512-fake-1.2.3",
    changed: true,
  })
  assert.deepEqual(readLockfile(lock).extension["@acme/titah-git"], {
    version: "1.2.3",
    integrity: "sha512-fake-1.2.3",
  })
})

test("versi yang dikunci lockfile mendahului latest", async () => {
  /*
   * Inilah gunanya lockfile. Memasang di mesin kedua harus menghasilkan kode
   * yang SAMA, bukan kode terbaru — kalau tidak, "panel yang sama di laptop dan
   * di server" cuma harapan.
   */
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  writeLockfile({ version: 1, extension: { "@acme/git": { version: "0.9.0" } } }, lock)

  const npm = fakeNpm()
  await installExtension({ packageName: "@acme/git", root, lockFile: lock, run: npm.run })
  assert.ok(npm.calls[0]?.includes("@acme/git@0.9.0"), JSON.stringify(npm.calls[0]))
})

test("tanpa lockfile dan tanpa versi, npm dipanggil tanpa penyemat versi", async () => {
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm({ version: "2.0.0" })
  const result = await installExtension({ packageName: "solo", root, lockFile: lock, run: npm.run })
  assert.ok(npm.calls[0]?.includes("solo"), JSON.stringify(npm.calls[0]))
  assert.equal(result.version, "2.0.0")
})

test("versi yang sudah terpasang tidak memanggil npm sama sekali", async () => {
  // `changed: false` yang dipakai picker untuk memutuskan apakah perlu memberi
  // tahu apa pun. Selalu memanggil npm berarti setiap pembukaan picker menunggu
  // jaringan untuk pekerjaan yang tidak ada.
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm()
  await installExtension({ packageName: "dup", version: "1.0.0", root, lockFile: lock, run: npm.run })
  const again = await installExtension({ packageName: "dup", version: "1.0.0", root, lockFile: lock, run: npm.run })
  assert.equal(again.changed, false)
  assert.equal(npm.calls.length, 1)
})

test("npm yang gagal meneruskan stderr-nya apa adanya", async () => {
  /*
   * "Failed to install" tidak memberi tahu apa pun. Baris npm yang sebenarnya
   * menyebut 404, EACCES, atau ETARGET — dan itu yang menentukan langkah
   * berikutnya.
   */
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm({ fail: "npm error code E404\nnpm error 404 Not Found - GET ..." })
  await assert.rejects(
    () => installExtension({ packageName: "ghost", root, lockFile: lock, run: npm.run }),
    (error: Error) => error instanceof InstallError && /E404/.test(error.message),
  )
})

test("npm yang mengaku berhasil tapi tidak memasang apa pun DITOLAK", async () => {
  /*
   * Mengunci versi yang tidak ada di disk membuat pemasangan berikutnya
   * melewatkan npm (karena lockfile mengaku sudah terpasang) dan panelnya gagal
   * di-import — dengan sebab yang menunjuk ke import, bukan ke pemasangan.
   */
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm({ skipWrite: true })
  await assert.rejects(
    () => installExtension({ packageName: "phantom", root, lockFile: lock, run: npm.run }),
    /not in .*node_modules/,
  )
  assert.equal(readLockfile(lock).extension["phantom"], undefined)
})

test("lockfile yang rusak diperlakukan kosong, bukan menghentikan segalanya", () => {
  /*
   * Kebalikan dari perlakuan terhadap config user, dan bedanya disengaja:
   * lockfile bisa dibangun ulang dari apa yang terpasang, config tidak bisa
   * dibangun ulang dari apa pun.
   */
  const file = path.join(scratch(), "extension-lock.json")
  fs.writeFileSync(file, "{ rusak")
  assert.deepEqual(readLockfile(file), { version: 1, extension: {} })
})

test("lockfile dengan versi format yang tidak dikenal diperlakukan kosong", () => {
  const file = path.join(scratch(), "extension-lock.json")
  fs.writeFileSync(file, JSON.stringify({ version: 99, extension: { a: { version: "1" } } }))
  assert.deepEqual(readLockfile(file), { version: 1, extension: {} })
})

test("mencabut membuang entri lockfile meski npm gagal", async () => {
  /*
   * Lockfile yang menyebut paket yang tidak ada membuat pemasangan berikutnya
   * menyematkan versi lama tanpa alasan yang bisa dilihat siapa pun.
   */
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  writeLockfile({ version: 1, extension: { gone: { version: "1.0.0" } } }, lock)
  const npm = fakeNpm({ fail: "npm error" })
  await removeExtension({ packageName: "gone", root, lockFile: lock, run: npm.run })
  assert.equal(readLockfile(lock).extension["gone"], undefined)
})

test("daftar terpasang dibaca dari disk, dan menangani nama berskop", async () => {
  // Dibaca dari disk dan bukan dari lockfile: yang menentukan apakah panel bisa
  // dimuat adalah berkasnya, bukan catatan tentang berkasnya.
  const root = scratch()
  const lock = path.join(scratch(), "extension-lock.json")
  const npm = fakeNpm()
  await installExtension({ packageName: "@acme/titah-git", version: "1.0.0", root, lockFile: lock, run: npm.run })
  await installExtension({ packageName: "plain-panel", version: "1.0.0", root, lockFile: lock, run: npm.run })
  assert.deepEqual(installedExtensions(root), ["@acme/titah-git", "plain-panel"])
})

test("direktori titik di node_modules tidak dihitung sebagai extension", () => {
  // npm menaruh `.package-lock.json` dan `.bin` di sana. Menghitungnya membuat
  // picker menampilkan entri yang tidak pernah bisa dimuat.
  const root = scratch()
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true })
  fs.mkdirSync(path.join(root, "node_modules", "real"), { recursive: true })
  assert.deepEqual(installedExtensions(root), ["real"])
})

test("integrity dibaca dari package-lock npm, bukan dihitung ulang", () => {
  // npm sudah memverifikasinya terhadap registry saat mengunduh. Menghitung
  // ulang dari berkas yang sudah diekstrak hanya membuktikan bahwa berkas itu
  // adalah dirinya sendiri.
  const root = scratch()
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/x": { integrity: "sha512-abc" } } }),
  )
  assert.equal(integrityFrom(root, "x"), "sha512-abc")
  assert.equal(integrityFrom(root, "missing"), undefined)
  assert.equal(installedVersion(root, "x"), undefined)
})
