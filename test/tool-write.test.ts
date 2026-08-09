import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"
import { editTool, writeTool, bashTool, ToolError } from "../src/core/tool/index.ts"
import { allowlistPattern } from "../src/core/tool/bash.ts"
import type { ToolContext } from "../src/core/tool/types.ts"
import { Config } from "../src/core/schema.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-write-")))

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(
    path.join(root, "kode.ts"),
    "export function tambah(a: number, b: number) {\n  return a - b\n}\n",
  )
  fs.writeFileSync(path.join(root, "ulang.txt"), "halo\nhalo\nhalo\n")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// discover: [] karena tool-tool ini tidak pernah menyentuh skill — config di
// sini hanya mengisi bidang wajib ToolContext, bukan diuji.
const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: root,
  sessionID: "ses_test",
  callID: "call_test",
  signal: signal ?? new AbortController().signal,
  config: Config.parse({ skills: { discover: [] } }),
})

const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8")

// ---------- edit ----------

test("edit mengganti teks persis dan menulis hasilnya", async () => {
  const result = await editTool.execute(
    { path: "kode.ts", oldString: "return a - b", newString: "return a + b" },
    ctx(),
  )
  assert.match(read("kode.ts"), /return a \+ b/)
  assert.match(result.title, /^edit kode\.ts \(1× at line 2\)$/)
})

test("edit GAGAL KERAS kalau oldString tidak ada, dan file tidak tersentuh", async () => {
  const sebelum = read("kode.ts")
  await assert.rejects(
    () => editTool.execute({ path: "kode.ts", oldString: "tidak ada ini", newString: "x" }, ctx()),
    /not found/,
  )
  assert.equal(read("kode.ts"), sebelum, "file tidak boleh berubah sedikit pun")
})

test("edit menolak oldString yang tidak unik dan menyebut jumlah kemunculannya", async () => {
  const sebelum = read("ulang.txt")
  await assert.rejects(
    () => editTool.execute({ path: "ulang.txt", oldString: "halo", newString: "hai" }, ctx()),
    /appears 3 times/,
  )
  assert.equal(read("ulang.txt"), sebelum)
})

test("edit dengan replaceAll mengganti semuanya", async () => {
  const result = await editTool.execute(
    { path: "ulang.txt", oldString: "halo", newString: "hai", replaceAll: true },
    ctx(),
  )
  assert.equal(read("ulang.txt"), "hai\nhai\nhai\n")
  assert.match(result.title, /3×/)
})

test("edit menolak oldString kosong dan mengarahkan ke write", async () => {
  await assert.rejects(
    () => editTool.execute({ path: "kode.ts", oldString: "", newString: "x" }, ctx()),
    /use the write tool/i,
  )
})

test("edit menolak kalau lama dan baru identik", async () => {
  await assert.rejects(
    () => editTool.execute({ path: "kode.ts", oldString: "return", newString: "return" }, ctx()),
    /identical/,
  )
})

test("edit menolak file yang tidak ada", async () => {
  await assert.rejects(
    () => editTool.execute({ path: "hantu.ts", oldString: "a", newString: "b" }, ctx()),
    /not found/,
  )
})

test("edit tidak bisa keluar dari direktori kerja", async () => {
  await assert.rejects(
    () => editTool.execute({ path: "../luar.txt", oldString: "a", newString: "b" }, ctx()),
    ToolError,
  )
})

test("edit selalu meminta izin, dengan diff lama/baru di detailnya", () => {
  const need = editTool.permission?.(
    { path: "kode.ts", oldString: "a - b", newString: "a + b" },
    ctx(),
  )
  assert.equal(need?.kind, "edit")
  assert.match(need?.detail ?? "", /a - b/)
  assert.match(need?.detail ?? "", /a \+ b/)
})

// ---------- write ----------

test("write membuat file beserta direktori induknya", async () => {
  await writeTool.execute({ path: "baru/dalam/file.txt", content: "isi\n" }, ctx())
  assert.equal(read("baru/dalam/file.txt"), "isi\n")
})

test("write menimpa file yang ada dan mengatakannya", async () => {
  const result = await writeTool.execute({ path: "kode.ts", content: "kosong\n" }, ctx())
  assert.equal(read("kode.ts"), "kosong\n")
  assert.match(result.output, /Overwrote/)
})

test("write menolak menulis ke direktori", async () => {
  fs.mkdirSync(path.join(root, "dir"))
  await assert.rejects(() => writeTool.execute({ path: "dir", content: "x" }, ctx()), /directory/)
})

test("write meminta izin dan membedakan buat vs timpa", () => {
  const buat = writeTool.permission?.({ path: "belum-ada.txt", content: "a\nb\n" }, ctx())
  assert.match(buat?.title ?? "", /^create belum-ada\.txt \(2 lines\)$/)

  const timpa = writeTool.permission?.({ path: "kode.ts", content: "a\n" }, ctx())
  assert.match(timpa?.title ?? "", /^overwrite kode\.ts/)
})

// ---------- bash ----------

test("bash mengembalikan stdout", async () => {
  const result = await bashTool.execute({ command: "echo halo-titah" }, ctx())
  assert.match(result.output, /halo-titah/)
  assert.equal(result.metadata?.exitCode, 0)
})

test("bash berjalan di direktori kerja sesi", async () => {
  const result = await bashTool.execute({ command: "pwd" }, ctx())
  assert.match(result.output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("bash melaporkan exit code bukan-nol tanpa melempar error", async () => {
  const result = await bashTool.execute({ command: "exit 3" }, ctx())
  assert.match(result.output, /exit code 3/)
  assert.equal(result.metadata?.exitCode, 3)
  assert.match(result.title, /exit 3/)
})

test("bash memisahkan stderr agar bisa dibaca", async () => {
  const result = await bashTool.execute({ command: "echo galat 1>&2" }, ctx())
  assert.match(result.output, /--- stderr ---/)
  assert.match(result.output, /galat/)
})

test("bash menghentikan perintah yang melewati timeout", async () => {
  await assert.rejects(
    () => bashTool.execute({ command: "sleep 5", timeout: 200 }, ctx()),
    /200 ms timeout/,
  )
})

test("bash berhenti saat sinyal abort", async () => {
  const controller = new AbortController()
  const running = bashTool.execute({ command: "sleep 5" }, ctx(controller.signal))
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(() => running, /Cancelled/)
})

test("pola allowlist bash memakai kata pertama, bukan seluruh perintah", () => {
  assert.equal(allowlistPattern("git status --short"), "git *")
  assert.equal(allowlistPattern("  npm   test "), "npm *")
})

test("bash meminta izin dengan perintah utuh di detailnya", () => {
  const need = bashTool.permission?.({ command: "rm -rf /tmp/x", description: "hapus" }, ctx())
  assert.equal(need?.kind, "bash")
  assert.equal(need?.pattern, "rm *")
  assert.match(need?.detail ?? "", /rm -rf \/tmp\/x/)
})
