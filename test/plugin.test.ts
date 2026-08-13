import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  loadPlugins,
  parsePluginSpec,
  PluginError,
  resolveMarket,
  runAfter,
  runBefore,
  type LoadedPlugin,
} from "../src/core/plugin.ts"
import { Config } from "../src/core/schema.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titah-plugin-"))

function plugin(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return `./${name}`
}

const config = (spec: string, options: Record<string, unknown> = {}) =>
  Config.parse({ plugin: { [spec]: { options } } })

// ---------- sumber ----------

test("tiga bentuk spec dikenali, termasuk yang belum bisa dipakai", () => {
  /*
   * `market:` sengaja ada sekarang meski belum bisa diresolusi. Menambahkannya
   * belakangan berarti menebak bagaimana ia akan ditulis, dan tebakan yang
   * salah menjadi perubahan yang memutus config orang.
   */
  assert.deepEqual(parsePluginSpec("@acme/titah-x"), { kind: "npm", package: "@acme/titah-x" })
  assert.deepEqual(parsePluginSpec("./p.ts"), { kind: "file", path: "./p.ts" })
  assert.deepEqual(parsePluginSpec("market:prettier"), { kind: "market", id: "prettier" })
})

test("marketplace GAGAL dengan kalimat yang menyebut keadaannya", () => {
  // Bukan diam-diam diperlakukan sebagai nama paket npm, yang akan berujung
  // "module not found" — pesan yang menyesatkan tentang sebab yang berbeda.
  assert.throws(
    () => resolveMarket("prettier"),
    (error: unknown) =>
      error instanceof PluginError &&
      /not available yet/.test((error as Error).message) &&
      /npm/.test((error as Error).message),
  )
})

test("plugin market: dilaporkan sebagai kegagalan, bukan menjatuhkan sesi", async () => {
  const { plugins, failures } = await loadPlugins(config("market:apa-saja"), dir)
  assert.deepEqual(plugins, [])
  assert.equal(failures.length, 1)
  assert.match(failures[0]?.reason ?? "", /marketplace is not available yet/)
})

// ---------- pemuatan ----------

test("plugin lokal dimuat dan kaitnya terbaca", async () => {
  const spec = plugin(
    "ok.mjs",
    `export default (ctx) => ({
       name: "uji",
       "tool.after": ({ output }) => output + " [" + ctx.options.tanda + "]",
     })`,
  )

  const { plugins, failures } = await loadPlugins(config(spec, { tanda: "X" }), dir)
  assert.deepEqual(failures, [])
  assert.equal(plugins[0]?.name, "uji")
  assert.equal(plugins[0]?.source.kind, "file")
  assert.ok(plugins[0]?.hooks["tool.after"])
})

test("options diteruskan apa adanya ke factory", async () => {
  const spec = plugin(
    "opt.mjs",
    `export default (ctx) => ({ "tool.after": () => JSON.stringify(ctx.options) })`,
  )
  const { plugins } = await loadPlugins(config(spec, { a: 1, b: [2] }), dir)
  const hasil = await runAfter(plugins, {
    tool: "read",
    input: {},
    sessionID: "s",
    cwd: dir,
    output: "",
    title: "",
  })
  assert.equal(hasil.output, '{"a":1,"b":[2]}')
})

test("plugin yang bukan factory ditolak dengan contoh bentuk yang benar", async () => {
  const spec = plugin("bukan.mjs", `export default { "tool.after": () => "x" }`)
  const { failures } = await loadPlugins(config(spec), dir)
  assert.match(failures[0]?.reason ?? "", /default export is not a function/)
  assert.match(failures[0]?.reason ?? "", /export default \(ctx\)/, "contohnya ikut disebut")
})

test("satu plugin rusak tidak menjatuhkan yang lain", async () => {
  const rusak = plugin("rusak.mjs", `export default () => { throw new Error("meledak") }`)
  const baik = plugin("baik.mjs", `export default () => ({ name: "baik" })`)
  const both = Config.parse({ plugin: { [rusak]: {}, [baik]: {} } })

  const { plugins, failures } = await loadPlugins(both, dir)
  assert.equal(plugins.length, 1, "yang sehat tetap dimuat")
  assert.equal(plugins[0]?.name, "baik")
  assert.match(failures[0]?.reason ?? "", /meledak/)
})

test("enabled: false tidak pernah di-import", async () => {
  // Bukan sekadar tidak dipakai: modulnya tidak boleh dievaluasi sama sekali,
  // karena kode di level atas modul berjalan saat import.
  const spec = plugin("mati.mjs", `throw new Error("modul ini dievaluasi")`)
  const off = Config.parse({ plugin: { [spec]: { enabled: false } } })
  const { plugins, failures } = await loadPlugins(off, dir)
  assert.deepEqual(plugins, [])
  assert.deepEqual(failures, [], "yang dimatikan bukan kegagalan")
})

test("paket npm yang tidak terpasang menyebut cara memasangnya", async () => {
  const { failures } = await loadPlugins(config("@tidak-ada/paket-titah"), dir)
  assert.match(failures[0]?.reason ?? "", /npm install @tidak-ada\/paket-titah/)
})

// ---------- kait ----------

const hooked = (hooks: LoadedPlugin["hooks"], name = "p"): LoadedPlugin => ({
  spec: name,
  name,
  source: { kind: "file", path: name },
  hooks,
})

const before = { tool: "write", input: { file: "a.ts" }, sessionID: "s", cwd: dir }

test("tool.before bisa MENOLAK, dan penolaknya disebut", async () => {
  const hasil = await runBefore([hooked({ "tool.before": () => ({ deny: "berkas terkunci" }) })], before)
  assert.equal(hasil.deny, "berkas terkunci")
  assert.equal(hasil.by, "p")
})

test("tool.before bisa mengubah masukan, dan yang kedua melihat hasil yang pertama", async () => {
  /*
   * Berurutan, bukan paralel. Paralel membuat hasilnya bergantung pada siapa
   * yang selesai lebih dulu — dan dua plugin yang menyunting masukan yang sama
   * akan saling menimpa secara acak.
   */
  const satu = hooked({ "tool.before": ({ input }) => ({ input: { ...(input as object), a: 1 } }) }, "satu")
  const dua = hooked(
    { "tool.before": ({ input }) => ({ input: { ...(input as object), b: (input as { a: number }).a + 1 } }) },
    "dua",
  )

  const hasil = await runBefore([satu, dua], before)
  assert.deepEqual(hasil.input, { file: "a.ts", a: 1, b: 2 })
})

test("tool.before yang MELEMPAR berarti menolak, bukan meloloskan", async () => {
  /*
   * Arah ini menentukan. `tool.before` adalah penjaga; penjaga yang rusak lalu
   * diabaikan sama saja dengan tidak ada penjaga — dan kegagalannya persis
   * terjadi pada panggilan yang mungkin justru ingin ia hentikan.
   */
  const hasil = await runBefore(
    [hooked({ "tool.before": () => { throw new Error("regex jelek") } })],
    before,
  )
  assert.match(hasil.deny ?? "", /failed while checking this call/)
  assert.match(hasil.deny ?? "", /regex jelek/)
})

test("tool.after berantai, tiap plugin melihat keluaran sebelumnya", async () => {
  const hasil = await runAfter(
    [
      hooked({ "tool.after": ({ output }) => `${output}-satu` }, "a"),
      hooked({ "tool.after": ({ output }) => `${output}-dua` }, "b"),
    ],
    { ...before, output: "asal", title: "t" },
  )
  assert.equal(hasil.output, "asal-satu-dua")
})

test("tool.after yang melempar DIABAIKAN, kebalikan dari tool.before", async () => {
  /*
   * Kait ini hanya membentuk keluaran yang sudah terjadi. Membuang hasil tool
   * yang berhasil karena pencatat log-nya rusak menghilangkan pekerjaan
   * sungguhan demi hal yang tidak esensial.
   */
  const hasil = await runAfter(
    [
      hooked({ "tool.after": () => { throw new Error("disk penuh") } }, "log"),
      hooked({ "tool.after": ({ output }) => `${output}!` }, "lain"),
    ],
    { ...before, output: "asal", title: "t" },
  )

  assert.equal(hasil.output, "asal!", "yang sehat tetap berjalan")
  assert.equal(hasil.failures.length, 1)
  assert.match(hasil.failures[0]?.reason ?? "", /disk penuh/)
})

test("plugin tanpa kait yang relevan dilewati tanpa efek", async () => {
  const kosong = [hooked({ name: "diam" })]
  assert.deepEqual((await runBefore(kosong, before)).input, before.input)
  assert.equal((await runAfter(kosong, { ...before, output: "x", title: "t" })).output, "x")
})
