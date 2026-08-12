import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Config } from "../src/core/schema.ts"
import { moveTool, removeTool } from "../src/core/tool/fileops.ts"
import { applyEdits, patchTool } from "../src/core/tool/patch.ts"
import { ToolError } from "../src/core/tool/types.ts"

/**
 * `patch` (gap 17), `move`, dan `remove`.
 *
 * Yang dipaku bukan "berkasnya berpindah" — itu `fs.renameSync`, dan menguji
 * pustaka standar orang lain tidak membuktikan apa pun. Yang dipaku adalah
 * JANJI ketiganya: patch tidak pernah menulis separuh, move tidak pernah
 * menghilangkan apa pun, dan remove tidak pernah menumpang sumbu `write`.
 */

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "titah-fileops-"))
}

const ctx = (cwd: string) =>
  ({
    cwd,
    sessionID: "ses_file",
    callID: "call_1",
    signal: new AbortController().signal,
    config: Config.parse({}),
  }) as never

// ---------- patch ----------

test("beberapa suntingan diterapkan berurutan dalam satu panggilan", () => {
  const { text, applied } = applyEdits("satu dua tiga", [
    { find: "satu", replace: "1" },
    { find: "tiga", replace: "3" },
  ])
  assert.equal(text, "1 dua 3")
  assert.equal(applied, 2)
})

test("suntingan berikutnya melihat hasil suntingan sebelumnya", () => {
  // Berurutan, bukan serentak. Kalau serentak, `find: "b"` di bawah tidak akan
  // pernah cocok, dan modelnya harus memikirkan dua model mental sekaligus.
  const { text } = applyEdits("a", [
    { find: "a", replace: "b" },
    { find: "b", replace: "c" },
  ])
  assert.equal(text, "c")
})

test("satu potongan yang tidak cocok membatalkan SELURUHNYA", () => {
  const target = project()
  const file = path.join(target, "x.txt")
  fs.writeFileSync(file, "asli")

  assert.throws(
    () =>
      applyEdits("asli", [
        { find: "asli", replace: "diubah" },
        { find: "tidak ada", replace: "apa pun" },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /Edit 2 of 2/)
      assert.match(error.message, /Nothing was written/)
      // Menyebut bahwa kegagalannya bisa disebabkan suntingan SEBELUMNYA —
      // tanpa itu model membaca ulang berkas asli dan bingung kenapa cocok.
      assert.match(error.message, /after the earlier edits were applied/)
      return true
    },
  )
})

test("berkas benar-benar tidak tersentuh saat satu potongan gagal", async () => {
  const target = project()
  fs.writeFileSync(path.join(target, "x.txt"), "asli")

  await assert.rejects(() =>
    patchTool.execute(
      { path: "x.txt", edits: [{ find: "asli", replace: "diubah" }, { find: "hantu", replace: "!" }] },
      ctx(target),
    ),
  )
  // Inti janjinya: separuh tersunting lebih buruk daripada belum disentuh,
  // karena kompilasinya gagal dengan cara yang tidak jelas milik siapa.
  assert.equal(fs.readFileSync(path.join(target, "x.txt"), "utf8"), "asli")
})

test("potongan yang ambigu ditolak, tidak diam-diam memilih yang pertama", () => {
  assert.throws(
    () => applyEdits("x x", [{ find: "x", replace: "y" }]),
    (error: unknown) => {
      assert.match((error as Error).message, /ambiguous/)
      assert.match((error as Error).message, /Nothing was written/)
      return true
    },
  )
})

test("patch memakai sumbu edit, dan dialognya menampilkan setiap potongan", () => {
  const need = patchTool.permission?.(
    { path: "a.ts", edits: [{ find: "p", replace: "q" }, { find: "r", replace: "s" }] },
    ctx("/tmp"),
  )
  assert.equal(need?.kind, "edit")
  assert.match(need?.detail ?? "", /edit 1/)
  assert.match(need?.detail ?? "", /edit 2/)
  assert.match(need?.detail ?? "", /- p\n\+ q/)
})

test("suntingan yang hasilnya identik tidak menulis ulang berkas", async () => {
  const target = project()
  const file = path.join(target, "x.txt")
  fs.writeFileSync(file, "sama")
  const before = fs.statSync(file).mtimeMs

  const result = await patchTool.execute({ path: "x.txt", edits: [{ find: "sama", replace: "sama" }] }, ctx(target))

  // Menulis ulang isi yang sama menggerakkan mtime dan membangunkan watcher
  // orang lain tanpa alasan.
  assert.match(result.output, /not rewritten/)
  assert.equal(fs.statSync(file).mtimeMs, before)
})

// ---------- move ----------

test("move memindahkan, dan membuat direktori tujuan yang belum ada", async () => {
  const target = project()
  fs.writeFileSync(path.join(target, "a.txt"), "isi")

  await moveTool.execute({ from: "a.txt", to: "sub/b.txt" }, ctx(target))

  assert.equal(fs.existsSync(path.join(target, "a.txt")), false)
  assert.equal(fs.readFileSync(path.join(target, "sub/b.txt"), "utf8"), "isi")
})

test("move TIDAK PERNAH menimpa — itu yang membuatnya cukup di sumbu write", async () => {
  const target = project()
  fs.writeFileSync(path.join(target, "a.txt"), "sumber")
  fs.writeFileSync(path.join(target, "b.txt"), "penting")

  await assert.rejects(
    () => moveTool.execute({ from: "a.txt", to: "b.txt" }, ctx(target)),
    (error: unknown) => {
      assert.match((error as Error).message, /already exists/)
      assert.match((error as Error).message, /never overwrites/)
      return true
    },
  )
  // Kalau move boleh menimpa, ia bisa menghancurkan berkas tanpa lewat sumbu
  // `delete` sama sekali — pagar yang bisa dilangkahi lewat pintu sebelah.
  assert.equal(fs.readFileSync(path.join(target, "b.txt"), "utf8"), "penting")
  assert.equal(fs.existsSync(path.join(target, "a.txt")), true, "sumber juga harus utuh")
})

test("move tidak bisa keluar dari cwd", async () => {
  const target = project()
  fs.writeFileSync(path.join(target, "a.txt"), "isi")
  await assert.rejects(() => moveTool.execute({ from: "a.txt", to: "../lolos.txt" }, ctx(target)))
})

test("move memakai sumbu write, bukan delete", () => {
  assert.equal(moveTool.permission?.({ from: "a", to: "b" }, ctx("/tmp"))?.kind, "write")
})

// ---------- remove ----------

test("remove memakai sumbu delete SENDIRI, bukan menumpang write", () => {
  // Agent dengan `write: allow` yang dimaksudkan sebagai "boleh membuat berkas
  // baru" tidak pernah dimaksudkan sebagai "boleh menghapus berkas saya".
  const need = removeTool.permission?.({ path: "a.txt", recursive: false }, ctx("/tmp"))
  assert.equal(need?.kind, "delete")
})

test("menghapus direktori butuh recursive yang eksplisit", async () => {
  const target = project()
  fs.mkdirSync(path.join(target, "d"))
  fs.writeFileSync(path.join(target, "d/x.txt"), "isi")

  await assert.rejects(
    () => removeTool.execute({ path: "d", recursive: false }, ctx(target)),
    (error: unknown) => {
      // Menyebut BERAPA yang akan ikut terhapus: "direktori" saja tidak memberi
      // tahu model bahwa ia sedang membuang tiga ratus berkas.
      assert.match((error as Error).message, /1 entry/)
      assert.match((error as Error).message, /recursive: true/)
      return true
    },
  )
  assert.equal(fs.existsSync(path.join(target, "d/x.txt")), true)

  await removeTool.execute({ path: "d", recursive: true }, ctx(target))
  assert.equal(fs.existsSync(path.join(target, "d")), false)
})

test("remove menolak menghapus direktori kerja itu sendiri", async () => {
  // Ia lolos `resolveInside` — cwd memang "di dalam" cwd menurut definisi apa
  // pun yang masuk akal — dan hasilnya menghapus seluruh proyek dari bawah sesi
  // yang sedang berjalan.
  const target = project()
  await assert.rejects(
    () => removeTool.execute({ path: ".", recursive: true }, ctx(target)),
    /working directory itself/,
  )
  assert.equal(fs.existsSync(target), true)
})

test("dialog remove menyatakan konsekuensi rekursifnya dengan keras", () => {
  const need = removeTool.permission?.({ path: "src", recursive: true }, ctx("/tmp"))
  assert.match(need?.detail ?? "", /EVERYTHING INSIDE IT/)
})
