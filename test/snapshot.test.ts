import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-snap-")))
process.env.XDG_DATA_HOME = path.join(root, "data")

const { take, restore, gitAvailable, SnapshotError } = await import("../src/core/snapshot.ts")

const project = path.join(root, "proyek")
const skip = gitAvailable() ? false : "git tidak tersedia"

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi awal A\n")
  fs.writeFileSync(path.join(project, "b.txt"), "isi awal B\n")
  fs.mkdirSync(path.join(project, "sub"), { recursive: true })
  fs.writeFileSync(path.join(project, "sub", "c.txt"), "isi awal C\n")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const read = (rel: string) => fs.readFileSync(path.join(project, rel), "utf8")

test("snapshot mengembalikan file yang diubah ke isi semula", { skip }, async () => {
  const commit = await take(project)
  assert.ok(commit)

  fs.writeFileSync(path.join(project, "a.txt"), "SUDAH DIRUSAK\n")
  fs.writeFileSync(path.join(project, "sub", "c.txt"), "JUGA DIRUSAK\n")

  const result = await restore(project, commit as string)

  assert.equal(read("a.txt"), "isi awal A\n")
  assert.equal(read("sub/c.txt"), "isi awal C\n")
  assert.deepEqual(result.files, ["a.txt", "sub/c.txt"])
})

test("undo juga MENGHAPUS file yang dibuat setelah snapshot", { skip }, async () => {
  const commit = await take(project)
  fs.writeFileSync(path.join(project, "baru.txt"), "tidak diminta siapa pun\n")

  const result = await restore(project, commit as string)

  assert.equal(
    fs.existsSync(path.join(project, "baru.txt")),
    false,
    "undo setengah jalan meninggalkan sampah — file baru harus ikut dibuang",
  )
  assert.ok(result.files.includes("baru.txt"))
})

test("file yang dihapus agent dikembalikan oleh undo", { skip }, async () => {
  const commit = await take(project)
  fs.rmSync(path.join(project, "b.txt"))

  await restore(project, commit as string)
  assert.equal(read("b.txt"), "isi awal B\n")
})

test("snapshot tidak membuat repo git di dalam proyek user", { skip }, async () => {
  await take(project)
  assert.equal(
    fs.existsSync(path.join(project, ".git")),
    false,
    "Titah tidak boleh menyentuh .git milik user",
  )
})

test("snapshot tanpa perubahan memakai ulang commit sebelumnya", { skip }, async () => {
  const pertama = await take(project)
  const kedua = await take(project)
  assert.equal(kedua, pertama, "isi identik tidak perlu commit baru")
})

test("snapshot berurutan membentuk riwayat yang bisa dikembalikan satu per satu", { skip }, async () => {
  const s1 = await take(project)
  fs.writeFileSync(path.join(project, "a.txt"), "versi 2\n")
  const s2 = await take(project)
  fs.writeFileSync(path.join(project, "a.txt"), "versi 3\n")

  await restore(project, s2 as string)
  assert.equal(read("a.txt"), "versi 2\n")

  await restore(project, s1 as string)
  assert.equal(read("a.txt"), "isi awal A\n")
})

test("node_modules diabaikan meski proyek tidak punya .gitignore", { skip }, async () => {
  fs.mkdirSync(path.join(project, "node_modules", "paket"), { recursive: true })
  fs.writeFileSync(path.join(project, "node_modules", "paket", "index.js"), "besar\n")

  const commit = await take(project)
  fs.writeFileSync(path.join(project, "node_modules", "paket", "index.js"), "diubah\n")

  const result = await restore(project, commit as string)
  assert.deepEqual(result.files, [], "isi node_modules tidak boleh masuk snapshot")
  assert.equal(
    fs.readFileSync(path.join(project, "node_modules", "paket", "index.js"), "utf8"),
    "diubah\n",
    "dan tidak boleh ikut dikembalikan atau dihapus",
  )
})

test("restore tanpa snapshot sebelumnya melapor jelas", { skip }, async () => {
  await assert.rejects(
    () => restore(project, "0000000000000000000000000000000000000000"),
    SnapshotError,
  )
})
