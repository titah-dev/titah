import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"
import { hooksFor, runAfterHooks, runBeforeHooks, runHook } from "../src/core/hook.ts"
import { Config } from "../src/core/schema.ts"

/**
 * Kait berupa perintah shell, di titik kait yang SUDAH ada.
 *
 * Titah sudah punya `tool.before` dan `tool.after` — tapi hanya lewat plugin
 * npm. Untuk satu aturan seperti "jalankan formatter setelah tiap edit", orang
 * harus membuat paket JavaScript, menulis factory, lalu mendaftarkannya:
 * ongkos yang jauh lebih besar daripada aturannya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-hook-")))

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const config = (hooks: Record<string, unknown>) => Config.parse({ hooks })

const event = {
  tool: "edit",
  input: { path: "a.ts" },
  sessionID: "ses_1",
  cwd: root,
}

// ---------- pemilihan ----------

test("`match` adalah regex atas nama tool; tanpa itu, semua tool", () => {
  const parsed = config({
    "tool.after": [{ match: "edit|write", run: "a" }, { run: "b" }, { match: "bash", run: "c" }],
  })

  assert.deepEqual(
    hooksFor(parsed, "tool.after", "edit").map((h) => h.run),
    ["a", "b"],
  )
  assert.deepEqual(
    hooksFor(parsed, "tool.after", "bash").map((h) => h.run),
    ["b", "c"],
  )
})

test("regex yang tidak sah tidak pernah cocok — dan tidak menjatuhkan giliran", () => {
  /*
   * Menolak seluruh giliran karena satu pola salah ketik jauh lebih merugikan
   * daripada kait yang tidak menyala. Yang melaporkan pola rusak adalah
   * `titah doctor`, bukan jalur panas ini.
   */
  const parsed = config({ "tool.after": [{ match: "([", run: "a" }] })
  assert.deepEqual(hooksFor(parsed, "tool.after", "edit"), [])
})

test("tanpa hooks di config, tidak ada yang dipilih", () => {
  assert.deepEqual(hooksFor(Config.parse({}), "tool.before", "edit"), [])
})

// ---------- menjalankan ----------

test("peristiwanya diberikan lewat STDIN sebagai JSON", async () => {
  /*
   * Lewat stdin, bukan argumen: masukan tool bisa berisi seluruh isi berkas,
   * dan baris perintah punya batas panjang yang berbeda antar sistem. Yang
   * gagal karena terlalu panjang akan gagal hanya pada berkas besar —
   * kegagalan yang muncul sesekali dan mustahil dihubungkan dengan sebabnya.
   */
  const out = path.join(root, "stdin.json")
  await runHook({ run: `cat > ${JSON.stringify(out)}` }, event)

  const received = JSON.parse(fs.readFileSync(out, "utf8"))
  assert.equal(received.tool, "edit")
  assert.equal(received.sessionID, "ses_1")
  assert.deepEqual(received.input, { path: "a.ts" })
})

test("nilai yang sering dipakai juga tersedia sebagai env var", async () => {
  // `$TITAH_TOOL` di skrip satu baris jauh lebih ringan daripada mengurai JSON.
  const out = path.join(root, "env.txt")
  await runHook({ run: `printf '%s' "$TITAH_TOOL" > ${JSON.stringify(out)}` }, event)
  assert.equal(fs.readFileSync(out, "utf8"), "edit")
})

test("kait dijalankan di cwd sesi", async () => {
  const out = path.join(root, "cwd.txt")
  await runHook({ run: `pwd > ${JSON.stringify(out)}` }, event)
  assert.equal(fs.readFileSync(out, "utf8").trim(), root)
})

test("kait yang menggantung DIBUNUH, bukan menahan giliran selamanya", async () => {
  const outcome = await runHook({ run: "sleep 5", timeout: 120 }, event)
  assert.equal(outcome.timedOut, true)
})

test("kait yang tidak membaca stdin tidak menjatuhkan apa pun", async () => {
  // Menutup stdin lebih dulu menghasilkan EPIPE, dan itu bukan kesalahan.
  const outcome = await runHook({ run: "true" }, event)
  assert.equal(outcome.code, 0)
})

// ---------- tool.before menolak ----------

test("keluar bukan-nol MENOLAK panggilan, dan stderr jadi alasannya", async () => {
  const parsed = config({
    "tool.before": [{ run: "echo 'jangan sentuh berkas itu' >&2; exit 1" }],
  })
  const refusal = await runBeforeHooks(parsed, event)

  assert.match(refusal?.deny ?? "", /jangan sentuh berkas itu/)
  assert.match(refusal?.deny ?? "", /hook/, "menyebut bahwa yang menolak adalah kait")
})

test("keluar nol meloloskan", async () => {
  assert.equal(await runBeforeHooks(config({ "tool.before": [{ run: "true" }] }), event), undefined)
})

test("kait yang GAGAL DIJALANKAN juga menolak", async () => {
  /*
   * Penjaga yang diam saat rusak lebih buruk daripada tidak ada penjaga:
   * kegagalannya persis terjadi pada panggilan yang mungkin ingin ia hentikan.
   */
  const parsed = config({ "tool.before": [{ run: "perintah-yang-tidak-ada-sama-sekali" }] })
  const refusal = await runBeforeHooks(parsed, event)
  assert.ok(refusal?.deny)
})

test("kait yang menggantung menolak, dengan sebab yang menyebut waktunya", async () => {
  const parsed = config({ "tool.before": [{ run: "sleep 5", timeout: 120 }] })
  const refusal = await runBeforeHooks(parsed, event)
  assert.match(refusal?.deny ?? "", /timed out/)
})

test("kait pertama yang menolak menghentikan sisanya", async () => {
  // Kait kedua akan membuat berkas kalau sempat jalan; ia tidak boleh sempat.
  const bukti = path.join(root, "kedua.txt")
  const parsed = config({
    "tool.before": [{ run: "exit 1" }, { run: `touch ${JSON.stringify(bukti)}` }],
  })

  await runBeforeHooks(parsed, event)
  assert.equal(fs.existsSync(bukti), false)
})

test("kait yang tidak cocok `match` tidak dijalankan", async () => {
  const bukti = path.join(root, "bash.txt")
  const parsed = config({
    "tool.before": [{ match: "^bash$", run: `touch ${JSON.stringify(bukti)}; exit 1` }],
  })

  assert.equal(await runBeforeHooks(parsed, event), undefined)
  assert.equal(fs.existsSync(bukti), false)
})

// ---------- tool.after membentuk ----------

const afterEvent = { ...event, output: "hasil asli", title: "edit a.ts" }

test("kait yang berhasil tidak mengubah keluaran", async () => {
  const parsed = config({ "tool.after": [{ run: "true" }] })
  assert.equal((await runAfterHooks(parsed, afterEvent)).output, "hasil asli")
})

test("kait yang GAGAL tidak membatalkan apa pun — pekerjaannya sudah terjadi", async () => {
  const parsed = config({ "tool.after": [{ run: "echo 'prettier meledak' >&2; exit 2" }] })
  const { output } = await runAfterHooks(parsed, afterEvent)

  assert.match(output, /^hasil asli/, "hasil aslinya utuh di depan")
  assert.match(output, /prettier meledak/)
})

test("kegagalannya ditempelkan ke keluaran TOOL, bukan sekadar ke layar", async () => {
  /*
   * Yang perlu tahu formatter baru saja gagal adalah MODEL — ia yang akan
   * memutuskan apakah perlu memperbaikinya. Notice hanya sampai ke layar user,
   * dan model melanjutkan pekerjaan di atas berkas yang ia kira rapi.
   */
  const parsed = config({ "tool.after": [{ run: "exit 1" }] })
  const { output } = await runAfterHooks(parsed, afterEvent)
  assert.match(output, /\[hook .* failed/)
})

test("beberapa kait berjalan berurutan, semuanya", async () => {
  const satu = path.join(root, "1.txt")
  const dua = path.join(root, "2.txt")
  const parsed = config({
    "tool.after": [{ run: `touch ${JSON.stringify(satu)}` }, { run: `touch ${JSON.stringify(dua)}` }],
  })

  await runAfterHooks(parsed, afterEvent)
  assert.equal(fs.existsSync(satu), true)
  assert.equal(fs.existsSync(dua), true)
})

test("contoh nyata: formatter setelah tiap edit", async () => {
  // Aturan yang memicu seluruh fitur ini, dan yang dulu menuntut satu paket npm.
  const jejak = path.join(root, "format.log")
  const parsed = config({
    "tool.after": [{ match: "edit|write|patch", run: `printf '%s\\n' "$TITAH_TOOL" >> ${JSON.stringify(jejak)}` }],
  })

  await runAfterHooks(parsed, afterEvent)
  await runAfterHooks(parsed, { ...afterEvent, tool: "read" })

  assert.equal(fs.readFileSync(jejak, "utf8"), "edit\n", "read tidak ikut memicu formatter")
})

// ---------- kait shell harus jalan TANPA plugin ----------

test("kait shell tidak bergantung pada plugin npm mana pun", async () => {
  /*
   * Versi pertama menaruh pemanggilannya di dalam `if (plugins.length > 0)` —
   * dan seluruh fiturnya mati untuk siapa pun yang tidak memasang plugin npm,
   * yaitu PERSIS orang yang menulis kait shell supaya tidak perlu memasang
   * plugin npm.
   *
   * Lulus semua unit test, nol efek di lapangan; ketahuan hanya karena dicoba
   * pada giliran sungguhan. Test ini yang menahannya, dari sisi config: tidak
   * ada satu pun plugin di sini, dan kaitnya tetap harus menyala.
   */
  const jejak = path.join(root, "tanpa-plugin.txt")
  const parsed = Config.parse({
    plugin: {},
    hooks: { "tool.after": [{ run: `touch ${JSON.stringify(jejak)}` }] },
  })
  assert.deepEqual(Object.keys(parsed.plugin), [], "memang tanpa plugin")

  await runAfterHooks(parsed, { ...event, output: "x", title: "t" })
  assert.equal(fs.existsSync(jejak), true)
})
