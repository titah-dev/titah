import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import { Config } from "../src/core/schema.ts"
import { killAllProcesses } from "../src/core/process.ts"
import { bashOutputTool, bashStartTool, bashStopTool } from "../src/core/tool/background.ts"
import { diagnosticsTool } from "../src/core/tool/diagnostics.ts"
import { ToolError } from "../src/core/tool/types.ts"

/**
 * Gap 4 (proses yang hidup lebih lama dari satu panggilan) dan gap 8
 * (tidak ada yang memberi tahu model bahwa ia baru membuat type error).
 */

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "titah-bg-"))

const ctx = (config = Config.parse({}), sessionID = "ses_bg") =>
  ({
    cwd,
    sessionID,
    callID: "call_1",
    signal: new AbortController().signal,
    config,
  }) as never

/*
 * Test di berkas ini menunggu KONDISI (perulangan sampai teksnya muncul), bukan
 * durasi tetap — pelajaran dari flake tui-input yang sudah dua kali ditutup:
 * `await tick()` lulus di mesin senggang dan gagal di mesin sibuk.
 */

after(() => killAllProcesses())

test("proses latar hidup melewati panggilan tool yang menyalakannya", async () => {
  // Inti gap 4: `bash` mem-spawn lalu menunggu, jadi tidak ada cara menyalakan
  // dev server dan tetap bekerja.
  const started = await bashStartTool.execute(
    { command: "printf mulai; sleep 30" },
    ctx(),
  )
  const id = (started.metadata as { id: string }).id
  assert.match(started.output, /Started proc_/)

  // Panggilan tool sudah kembali, dan prosesnya masih jalan — itu seluruh
  // maksudnya. `bash` biasa baru kembali setelah 30 detik.
  const read = await bashOutputTool.execute({ id, all: true }, ctx())
  assert.match(read.output, /running/, "statusnya harus masih running")

  await bashStopTool.execute({ id }, ctx())
})

test("bash_output memberi yang BARU sejak pembacaan terakhir", async () => {
  const started = await bashStartTool.execute(
    { command: "printf satu; sleep 0.3; printf dua; sleep 30" },
    ctx(),
  )
  const id = (started.metadata as { id: string }).id

  // Baca sampai "satu" muncul.
  let first = ""
  for (let i = 0; i < 100 && !first.includes("satu"); i += 1) {
    first = (await bashOutputTool.execute({ id, all: true }, ctx())).output
    if (!first.includes("satu")) await new Promise((r) => setTimeout(r, 20))
  }
  assert.match(first, /satu/)

  // Pembacaan inkremental berikutnya TIDAK mengulang "satu".
  let next = ""
  for (let i = 0; i < 200 && !next.includes("dua"); i += 1) {
    next = (await bashOutputTool.execute({ id, all: false }, ctx())).output
    if (!next.includes("dua")) await new Promise((r) => setTimeout(r, 20))
  }
  assert.match(next, /dua/)
  assert.doesNotMatch(next, /satu/, "pembacaan inkremental tidak boleh mengulang yang sudah dibaca")

  await bashStopTool.execute({ id }, ctx())
})

test("status exit terbaca setelah proses selesai sendiri", async () => {
  const started = await bashStartTool.execute({ command: "exit 3" }, ctx())
  const id = (started.metadata as { id: string }).id

  let result = await bashOutputTool.execute({ id, all: true }, ctx())
  for (let i = 0; i < 200 && !/exited/.test(result.output); i += 1) {
    await new Promise((r) => setTimeout(r, 20))
    result = await bashOutputTool.execute({ id, all: true }, ctx())
  }
  assert.match(result.output, /exited/)
  assert.match(result.output, /exit 3/)
})

test("bash_start memakai sumbu dan segmentasi yang SAMA dengan bash", () => {
  // Kalau berbeda, `bash_start` jadi pintu belakang yang melewati aturan
  // allowlist yang baru diperbaiki di issue #12.
  const need = bashStartTool.permission?.({ command: "npm run dev && rm -rf ~" }, ctx())
  assert.equal(need?.kind, "bash")
  assert.deepEqual(need?.segments, ["npm run dev", "rm -rf ~"])
  assert.equal(need?.pattern, "npm *")
})

test("bash_start menyatakan bahwa prosesnya tetap hidup setelah tool kembali", () => {
  const need = bashStartTool.permission?.({ command: "npm run dev" }, ctx())
  assert.match(need?.detail ?? "", /keeps running after the tool call returns/)
})

test("bash_output tanpa id mendaftar semua proses sesi ini", async () => {
  const result = await bashOutputTool.execute({ all: false }, ctx(Config.parse({}), "ses_kosong"))
  assert.match(result.output, /No background processes/)
})

test("membaca atau menghentikan id yang tidak ada memberi pesan, bukan crash", async () => {
  await assert.rejects(() => bashOutputTool.execute({ id: "proc_hantu", all: false }, ctx()), ToolError)
  await assert.rejects(() => bashStopTool.execute({ id: "proc_hantu" }, ctx()), ToolError)
})

test("bash_output dan bash_stop tidak meminta izin sama sekali", () => {
  // Membaca log bukan menjalankan apa pun. Satu tool bermode akan memaksa
  // ketiganya memakai sumbu yang paling ketat, dan user ditanya tiap kali
  // model mengintip.
  assert.equal(bashOutputTool.permission, undefined)
  assert.equal(bashStopTool.permission, undefined)
})

// ---------- diagnostics ----------

test("diagnostics menolak menebak perintah yang belum dinyatakan", async () => {
  await assert.rejects(
    () => diagnosticsTool.execute({}, ctx(Config.parse({}))),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /No checker is configured/)
      assert.match(error.message, /diagnostics\.command/)
      // Menyebut ALASAN tidak menebak, bukan cuma faktanya.
      assert.match(error.message, /harder to read than no command at all/)
      return true
    },
  )
})

test("exit non-nol adalah TEMUAN, bukan tool yang gagal", async () => {
  // Kalau ia dilempar, "ada tiga type error" terlihat sama persis dengan
  // "checker-nya sendiri rusak" — dan tindakan model berbeda untuk keduanya.
  const config = Config.parse({ diagnostics: { command: "echo 'a.ts(1,1): error TS1005' >&2; exit 2" } })
  const result = await diagnosticsTool.execute({}, ctx(config))

  assert.match(result.output, /exited 2/)
  assert.match(result.output, /error TS1005/)
  assert.equal((result.metadata as { clean: boolean }).clean, false)
})

test("exit nol dilaporkan bersih", async () => {
  const config = Config.parse({ diagnostics: { command: "true" } })
  const result = await diagnosticsTool.execute({}, ctx(config))
  assert.match(result.output, /Clean/)
  assert.equal((result.metadata as { clean: boolean }).clean, true)
})

test("diagnostics memakai sumbu bash, dan dialognya menampilkan perintahnya", () => {
  const config = Config.parse({ diagnostics: { command: "npm run typecheck" } })
  const need = diagnosticsTool.permission?.({}, ctx(config))
  // Perintahnya datang dari config user, bukan dari model — itu membuatnya
  // lebih aman, bukan membuatnya bukan perintah shell.
  assert.equal(need?.kind, "bash")
  assert.match(need?.detail ?? "", /npm run typecheck/)
})
