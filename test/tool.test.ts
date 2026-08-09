import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before, after } from "node:test"
import { readTool, listTool, globTool, grepTool, ToolError, resolveInside } from "../src/core/tool/index.ts"
import type { ToolContext } from "../src/core/tool/types.ts"

let root: string

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-tool-")))
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.mkdirSync(path.join(root, "node_modules", "paket"), { recursive: true })
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })

  fs.writeFileSync(path.join(root, "src", "a.ts"), "satu\ndua\ntiga\nempat\nlima\n")
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const halo = 1\n// TODO: rapikan\n")
  fs.writeFileSync(path.join(root, "README.md"), "# Judul\n\nisi\n")
  fs.writeFileSync(path.join(root, "biner.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  fs.writeFileSync(path.join(root, "node_modules", "paket", "index.js"), "// TODO: jangan ketemu\n")
  fs.writeFileSync(path.join(root, ".git", "config"), "TODO rahasia\n")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const ctx = (): ToolContext => ({
  cwd: root,
  sessionID: "ses_test",
  callID: "call_test",
  signal: new AbortController().signal,
})

test("read memberi nomor baris mulai dari 1", async () => {
  const result = await readTool.execute({ path: "src/a.ts" }, ctx())
  const lines = result.output.split("\n")
  assert.match(lines[0] as string, /^\s+1\tsatu$/)
  assert.match(lines[2] as string, /^\s+3\ttiga$/)
})

test("read menghormati offset dan limit, dan memberi tahu sisanya", async () => {
  const result = await readTool.execute({ path: "src/a.ts", offset: 2, limit: 2 }, ctx())
  assert.match(result.output, /^\s+3\ttiga\n\s+4\tempat/)
  assert.doesNotMatch(result.output, /satu/)
  assert.match(result.output, /offset=4/, "harus memberi tahu cara membaca lanjutannya")
})

test("read menolak file biner alih-alih memuntahkan sampah ke konteks", async () => {
  await assert.rejects(() => readTool.execute({ path: "biner.bin" }, ctx()), ToolError)
})

test("read menolak direktori dan mengarahkan ke tool yang benar", async () => {
  await assert.rejects(
    () => readTool.execute({ path: "src" }, ctx()),
    /Use the list tool/,
  )
})

test("read melaporkan file yang tidak ada, bukan mengembalikan kosong", async () => {
  await assert.rejects(() => readTool.execute({ path: "tidak-ada.ts" }, ctx()), /not found/)
})

test("path di luar direktori kerja ditolak", () => {
  assert.throws(() => resolveInside(root, "../../etc/passwd"), ToolError)
  assert.throws(() => resolveInside(root, "/etc/passwd"), ToolError)
  assert.doesNotThrow(() => resolveInside(root, "src/a.ts"))
  assert.doesNotThrow(() => resolveInside(root, "."))
})

test("read tidak bisa keluar dari direktori kerja lewat ..", async () => {
  await assert.rejects(
    () => readTool.execute({ path: "../../../etc/passwd" }, ctx()),
    /outside the session working directory/,
  )
})

test("list melewati node_modules, .git, dan file tersembunyi", async () => {
  const result = await listTool.execute({ depth: 3 }, ctx())
  assert.match(result.output, /src\//)
  assert.match(result.output, /README\.md/)
  assert.doesNotMatch(result.output, /node_modules/)
  assert.doesNotMatch(result.output, /\.git/)
})

test("glob menemukan berdasarkan pola dan mengabaikan direktori terlarang", async () => {
  const result = await globTool.execute({ pattern: "**/*.ts" }, ctx())
  assert.match(result.output, /src\/a\.ts/)
  assert.match(result.output, /src\/b\.ts/)
  assert.doesNotMatch(result.output, /node_modules/)
})

test("glob tanpa kecocokan mengatakannya secara eksplisit", async () => {
  const result = await globTool.execute({ pattern: "**/*.rs" }, ctx())
  assert.match(result.output, /No matching files/)
})

test("grep mengembalikan file:baris: isi dan melewati node_modules/.git", async () => {
  const result = await grepTool.execute({ pattern: "TODO" }, ctx())
  assert.match(result.output, /src\/b\.ts:2: .*TODO/)
  assert.doesNotMatch(result.output, /node_modules/)
  assert.doesNotMatch(result.output, /rahasia/, ".git tidak boleh ikut ter-grep")
})

test("grep menghormati include", async () => {
  const result = await grepTool.execute({ pattern: "isi", include: "**/*.md" }, ctx())
  assert.match(result.output, /README\.md:3/)

  const kosong = await grepTool.execute({ pattern: "isi", include: "**/*.ts" }, ctx())
  assert.match(kosong.output, /No matches/)
})

test("grep dengan ignoreCase", async () => {
  const peka = await grepTool.execute({ pattern: "judul" }, ctx())
  assert.match(peka.output, /No matches/)

  const abai = await grepTool.execute({ pattern: "judul", ignoreCase: true }, ctx())
  assert.match(abai.output, /README\.md:1/)
})

test("grep dengan regex rusak melapor jelas, tidak melempar error mentah", async () => {
  await assert.rejects(() => grepTool.execute({ pattern: "([" }, ctx()), /Invalid regex/)
})

test("judul tool ringkas dan menyebut hasilnya", async () => {
  const read = await readTool.execute({ path: "src/a.ts" }, ctx())
  assert.match(read.title, /^read src\/a\.ts \(\d+ lines\)$/)

  const grep = await grepTool.execute({ pattern: "TODO" }, ctx())
  assert.match(grep.title, /matches in 1 files/)
})
