import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

/**
 * Apa yang sudah dihabiskan, dibaca dari yang memang sudah tersimpan.
 *
 * Titah mencatat token tiap giliran sejak awal dan tidak pernah punya cara
 * membacanya kembali: 30,2 juta token tercatat di satu database tanpa satu pun
 * perintah yang bisa menjumlahkannya. Angka yang ditulis rajin lalu tidak pernah
 * dilihat sama nilainya dengan angka yang tidak pernah ditulis.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-stat-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "stat.db")
process.env.HOME = path.join(root, "home")

const { collectStats, priceOf, sessionTokens, turnCost } = await import("../src/core/stats.ts")
const { createSession, createMessage, saveMessage } = await import(
  "../src/core/storage/session.ts"
)
const { Config } = await import("../src/core/schema.ts")

const project = path.join(root, "proyek")
const other = path.join(root, "lain")

const config = Config.parse({
  provider: {
    p: {
      options: { baseURL: "http://x/v1" },
      models: {
        mahal: { price: { input: 3, output: 15 } },
        gratisan: {},
      },
    },
  },
})

beforeEach(() => {
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function record(
  directory: string,
  model: string | undefined,
  usage: { input?: number; output?: number } | undefined,
  sessionID?: string,
): string {
  const id = sessionID ?? createSession(directory).id
  const message = createMessage(id, "assistant", [{ type: "text", text: "ok" }])
  if (model) message.model = model
  if (usage) message.usage = usage
  saveMessage(message)
  return id
}

// ---------- harga ----------

test("biaya dihitung per SEJUTA token", () => {
  const price = { input: 3, output: 15 }
  // 1M input = 3, 1M output = 15
  assert.equal(turnCost(price, { input: 1_000_000, output: 1_000_000 }), 18)
  assert.equal(turnCost(price, { input: 500_000, output: 0 }), 1.5)
})

test("model tanpa harga menghasilkan undefined, BUKAN nol", () => {
  /*
   * Nol dan "belum diberi harga" adalah dua keadaan yang berbeda, dan
   * menyamakannya membuat total berbohong ke arah paling berbahaya: terlihat
   * murah.
   */
  assert.equal(turnCost(undefined, { input: 1_000_000 }), undefined)
})

test("harga dicari lewat id provider/model", () => {
  assert.deepEqual(priceOf(config, "p/mahal"), { input: 3, output: 15 })
  assert.equal(priceOf(config, "p/gratisan"), undefined)
  assert.equal(priceOf(config, "tidakada/apa"), undefined)
  assert.equal(priceOf(config, "tanpa-slash"), undefined)
  assert.equal(priceOf(config, undefined), undefined)
})

// ---------- agregasi ----------

test("menjumlahkan token dan biaya per model", () => {
  record(project, "p/mahal", { input: 1_000_000, output: 100_000 })
  record(project, "p/mahal", { input: 1_000_000, output: 100_000 })

  const stats = collectStats(config, { directory: project })
  const mahal = stats.byModel.find((m) => m.model === "p/mahal")

  assert.equal(mahal?.turns, 2)
  assert.equal(mahal?.input, 2_000_000)
  assert.equal(mahal?.cost, 2 * (3 + 1.5))
  assert.equal(stats.cost, 9)
})

test("model tanpa harga tetap dihitung tokennya dan DISEBUT terpisah", () => {
  const dir = path.join(root, "campur")
  fs.mkdirSync(dir, { recursive: true })
  record(dir, "p/mahal", { input: 1_000_000, output: 0 })
  record(dir, "p/gratisan", { input: 5_000_000, output: 0 })

  const stats = collectStats(config, { directory: dir })
  assert.equal(stats.input, 6_000_000, "tokennya ikut dihitung")
  assert.equal(stats.cost, 3, "tapi biayanya hanya dari yang berharga")
  assert.deepEqual(stats.unpriced, ["p/gratisan"])
})

test("giliran TANPA usage tidak dihitung sebagai giliran", () => {
  /*
   * Pesan info dan error sebelum permintaan pertama tidak pernah sampai ke
   * provider. Menghitungnya akan menurunkan rata-rata per giliran tanpa sebab
   * yang bisa dilihat siapa pun.
   */
  const dir = path.join(root, "kosong")
  fs.mkdirSync(dir, { recursive: true })
  record(dir, "p/mahal", undefined)
  record(dir, "p/mahal", { input: 100, output: 10 })

  assert.equal(collectStats(config, { directory: dir }).turns, 1)
})

test("sesi dihitung unik, bukan per giliran", () => {
  const dir = path.join(root, "sesi")
  fs.mkdirSync(dir, { recursive: true })
  const one = record(dir, "p/mahal", { input: 10 })
  record(dir, "p/mahal", { input: 10 }, one)
  record(dir, "p/mahal", { input: 10 })

  const stats = collectStats(config, { directory: dir })
  assert.equal(stats.turns, 3)
  assert.equal(stats.sessions, 2)
})

test("disaring per direktori — dan --all melihat semuanya", () => {
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  fs.mkdirSync(a, { recursive: true })
  fs.mkdirSync(b, { recursive: true })
  record(a, "p/mahal", { input: 1000 })
  record(b, "p/mahal", { input: 2000 })

  assert.equal(collectStats(config, { directory: a }).input, 1000)
  assert.equal(collectStats(config, { directory: b }).input, 2000)
  assert.ok(collectStats(config).input >= 3000, "tanpa direktori: seluruh proyek")
})

test("dikelompokkan per hari LOKAL", () => {
  // Hari yang dimaksud user adalah harinya, bukan hari UTC. Sesi jam sepuluh
  // malam di Jakarta bukan milik besok.
  const dir = path.join(root, "hari")
  fs.mkdirSync(dir, { recursive: true })
  record(dir, "p/mahal", { input: 10 })

  const stats = collectStats(config, { directory: dir })
  assert.equal(stats.byDay.length, 1)
  assert.match(stats.byDay[0]?.day ?? "", /^\d{4}-\d{2}-\d{2}$/)
})

test("model diurut dari yang paling banyak dipakai", () => {
  // "Apa yang memakan biaya" adalah pertanyaan pertama; urutan abjad tidak
  // menjawabnya.
  const dir = path.join(root, "urut")
  fs.mkdirSync(dir, { recursive: true })
  record(dir, "p/gratisan", { input: 10 })
  record(dir, "p/mahal", { input: 5_000_000 })

  assert.equal(collectStats(config, { directory: dir }).byModel[0]?.model, "p/mahal")
})

test("riwayat kosong tidak meledak", () => {
  const dir = path.join(root, "hampa")
  fs.mkdirSync(dir, { recursive: true })
  const stats = collectStats(config, { directory: dir })

  assert.equal(stats.turns, 0)
  assert.equal(stats.cost, 0)
  assert.deepEqual(stats.byModel, [])
})

// ---------- anggaran sesi ----------

test("sessionTokens menjumlahkan input DAN output lintas giliran", () => {
  /*
   * Input dijumlahkan lintas langkah dan karena itu terhitung berkali-kali —
   * bukan kesalahan hitungan, itu memang yang ditagihkan.
   */
  const dir = path.join(root, "anggaran")
  fs.mkdirSync(dir, { recursive: true })
  const id = record(dir, "p/mahal", { input: 100, output: 20 })
  record(dir, "p/mahal", { input: 300, output: 50 }, id)

  assert.equal(sessionTokens(id), 470)
})

test("sesi tanpa giliran berbayar bernilai nol", () => {
  const id = createSession(path.join(root, "nol")).id
  assert.equal(sessionTokens(id), 0)
})
