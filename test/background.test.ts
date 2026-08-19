import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

/**
 * Giliran yang dilepas ke latar, dan terminal yang langsung dikembalikan.
 *
 * Titah menahan terminal sampai gilirannya selesai — terasa makin mahal sejak
 * lanjutan otomatis bisa berjalan berjam-jam. Servernya sudah headless; yang
 * kurang manajemen sesinya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-bg-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "bg.db")
process.env.HOME = path.join(root, "home")

const {
  alive,
  findBackground,
  listBackground,
  pruneBackground,
  record,
  spawnBackground,
  stopBackground,
} = await import("../src/core/background.ts")

const project = path.join(root, "proyek")

beforeEach(() => {
  fs.mkdirSync(project, { recursive: true })
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const entry = (extra: Partial<Parameters<typeof record>[0]> = {}) =>
  record({
    sessionID: `ses_${Math.random().toString(16).slice(2, 8)}`,
    pid: process.pid,
    prompt: "kerjakan sesuatu",
    directory: project,
    log: path.join(root, "ada.log"),
    ...extra,
  })

// ---------- hidup atau mati ----------

test("proses yang hidup dikenali, yang tidak ada tidak", () => {
  assert.equal(alive(process.pid), true)
  // PID yang mustahil terpakai: di luar batas pid mana pun.
  assert.equal(alive(0x7fff_ffff), false)
})

test("status DITANYAKAN ke sistem, bukan dibaca dari kolom", () => {
  /*
   * Tidak ada kolom `status` sama sekali, dan itu disengaja: status yang
   * disimpan akan basi tanpa ada yang tahu, lalu pembacanya menampilkan
   * "running" untuk proses yang sudah lama mati.
   */
  const mati = entry({ pid: 0x7fff_ffff })
  const hidup = entry({ pid: process.pid })

  const listed = listBackground(project)
  assert.equal(listed.find((t) => t.id === mati.id)?.alive, false)
  assert.equal(listed.find((t) => t.id === hidup.id)?.alive, true)
})

// ---------- registri ----------

test("dicatat lalu ditemukan lagi, lengkap dengan sesinya", () => {
  const turn = entry({ prompt: "bangun fitur X" })
  const found = findBackground(turn.id)

  assert.equal(found?.sessionID, turn.sessionID)
  assert.equal(found?.prompt, "bangun fitur X")
  assert.equal(found?.directory, project)
})

test("dicari lewat AWALAN id — delapan huruf tetap merepotkan", () => {
  const turn = entry()
  assert.equal(findBackground(turn.id.slice(0, 6))?.id, turn.id)
})

test("id yang tidak ada menghasilkan undefined, bukan melempar", () => {
  assert.equal(findBackground("bg_tidakada"), undefined)
})

test("disaring per direktori", () => {
  const lain = path.join(root, "lain")
  fs.mkdirSync(lain, { recursive: true })
  entry({ directory: lain, prompt: "milik proyek lain" })

  const here = listBackground(project)
  assert.equal(
    here.some((t) => t.prompt === "milik proyek lain"),
    false,
  )
  assert.equal(
    listBackground().some((t) => t.prompt === "milik proyek lain"),
    true,
    "tanpa direktori: semuanya",
  )
})

test("yang terbaru lebih dulu", () => {
  const dir = path.join(root, "urut")
  fs.mkdirSync(dir, { recursive: true })
  entry({ directory: dir, prompt: "lebih dulu" })
  entry({ directory: dir, prompt: "paling baru" })

  assert.equal(listBackground(dir)[0]?.prompt, "paling baru")
})

// ---------- membersihkan ----------

test("catatan yang lognya MASIH ADA dipertahankan meski prosesnya mati", () => {
  /*
   * Itulah satu-satunya cara membaca hasil pekerjaan yang selesai saat kamu
   * tidak di depan layar. Membuangnya begitu prosesnya mati akan menghapus
   * justru hal yang membuat mode latar berguna.
   */
  const log = path.join(root, "selesai.log")
  fs.writeFileSync(log, "hasilnya di sini\n")
  const turn = entry({ pid: 0x7fff_ffff, log })

  pruneBackground()
  assert.ok(findBackground(turn.id), "masih terdaftar")
})

test("catatan yang tidak menunjuk apa pun lagi dibuang", () => {
  const turn = entry({ pid: 0x7fff_ffff, log: path.join(root, "hilang.log") })
  assert.ok(pruneBackground() >= 1)
  assert.equal(findBackground(turn.id), undefined)
})

test("yang masih HIDUP tidak pernah dibuang, walau lognya belum ada", () => {
  const turn = entry({ pid: process.pid, log: path.join(root, "belum-ada.log") })
  pruneBackground()
  assert.ok(findBackground(turn.id))
})

// ---------- melepas sungguhan ----------

test("melepas proses yang benar-benar terpisah, dan kembali seketika", async () => {
  /*
   * `detached` + `unref()` keduanya wajib: tanpa salah satunya, proses induk
   * menunggu anaknya selesai dan seluruh gunanya hilang.
   */
  const script = path.join(root, "lambat.js")
  fs.writeFileSync(script, "setTimeout(() => { console.log('selesai') }, 400)")

  const started = Date.now()
  const turn = spawnBackground({
    prompt: "apa saja",
    directory: project,
    sessionID: "ses_lepas",
    args: [],
    execPath: process.execPath,
    argv0: script,
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 300, `kembali dalam ${elapsed}ms — seharusnya seketika`)
  assert.ok(turn.pid > 0)

  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.match(fs.readFileSync(turn.log, "utf8"), /selesai/, "keluarannya masuk ke berkas log")
})

test("keluarannya ke BERKAS, bukan pipa", () => {
  /*
   * Pipa mati bersama induknya, dan yang tersisa adalah pekerjaan yang berjalan
   * tanpa satu pun jejak yang bisa dibaca nanti — persis kebalikan dari yang
   * diinginkan orang saat melepas sesuatu ke latar.
   */
  const script = path.join(root, "diam.js")
  fs.writeFileSync(script, "")
  const turn = spawnBackground({
    prompt: "x",
    directory: project,
    sessionID: "ses_berkas",
    args: [],
    execPath: process.execPath,
    argv0: script,
  })

  assert.ok(turn.log.endsWith(".log"))
  assert.equal(fs.existsSync(turn.log), true)
})

test("stop membunuh SELURUH pohon, bukan cuma induknya", async () => {
  /*
   * Giliran latar bisa melahirkan sub-agent dan perintah bash miliknya sendiri.
   * Membunuh induknya saja meninggalkan anak-anak itu berjalan, memakai token,
   * tanpa satu pun cara menemukannya lagi.
   */
  const script = path.join(root, "beranak.js")
  fs.writeFileSync(
    script,
    "const { spawn } = require('node:child_process');" +
      "spawn('sleep', ['30'], { stdio: 'ignore' });" +
      "setTimeout(() => {}, 30000)",
  )
  const turn = spawnBackground({
    prompt: "x",
    directory: project,
    sessionID: "ses_pohon",
    args: [],
    execPath: process.execPath,
    argv0: script,
  })

  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(alive(turn.pid), true)

  assert.equal(stopBackground(turn), true)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(alive(turn.pid), false)
})

test("menghentikan yang sudah mati tidak melempar", () => {
  assert.equal(stopBackground({ ...entry({ pid: 0x7fff_ffff }) }), false)
})
