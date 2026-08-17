import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { Config } from "../src/core/schema.ts"
import { ensureDeclared, instructionPaths, scaffoldNotice } from "../src/core/scaffold.ts"
import { buildSystemPrompt } from "../src/core/prompt.ts"

/**
 * Berkas yang dijanjikan config, dibuat sebelum prompt pertama.
 *
 * Sebelum ini, path instruksi yang salah ketik dilewati tanpa suara: instruksi
 * yang user kira sedang berlaku tidak pernah ikut, dan tidak ada satu pun
 * gejala yang menunjukkannya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-scaf-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "scaf.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const config = (extra: Record<string, unknown>) =>
  Config.parse({ skills: { discover: [], paths: [] }, ...extra })

// ---------- tiga bentuk, satu arti ----------

test("instructions menerima string, objek, dan array campuran", () => {
  /*
   * Bentuk tunggal diterima karena itu yang orang tulis lebih dulu. Menolak
   * config yang maksudnya sudah jelas hanya memindahkan pekerjaan ke user.
   */
  const satu = config({ instructions: "a.md" })
  const objek = config({ instructions: { path: "b.md" } })
  const campur = config({ instructions: ["c.md", { path: "d.md" }] })

  assert.deepEqual(instructionPaths(satu, project).map((p) => path.basename(p)), ["a.md"])
  assert.deepEqual(instructionPaths(objek, project).map((p) => path.basename(p)), ["b.md"])
  assert.deepEqual(
    instructionPaths(campur, project).map((p) => path.basename(p)),
    ["c.md", "d.md"],
  )
})

test("path relatif diresolusi ke direktori proyek, ~ ke home", () => {
  const parsed = config({ instructions: ["docs/aturan.md", "~/global.md"] })
  const [pertama, kedua] = instructionPaths(parsed, project)

  assert.equal(pertama, path.join(project, "docs/aturan.md"))
  assert.equal(kedua, path.join(os.homedir(), "global.md"))
})

test("tanpa instructions, tidak ada path sama sekali", () => {
  assert.deepEqual(instructionPaths(config({}), project), [])
})

// ---------- membuat yang belum ada ----------

test("berkas instruksi yang belum ada DIBUAT, dengan isi yang bisa dibaca", () => {
  const parsed = config({ instructions: { path: "titah-instruction.md" } })
  const hasil = ensureDeclared(parsed, project)

  const file = path.join(project, "titah-instruction.md")
  assert.deepEqual(hasil.files, [file])
  assert.equal(fs.existsSync(file), true)

  const isi = fs.readFileSync(file, "utf8")
  assert.match(isi, /Titah instructions/)
  assert.match(isi, /sub-agent/, "contohnya nyata, bukan placeholder kosong")
})

test("direktori induk ikut dibuat", () => {
  // `docs/rules/titah.md` di repo baru tidak punya `docs/` sama sekali.
  const parsed = config({ instructions: "docs/rules/titah.md" })
  ensureDeclared(parsed, project)
  assert.equal(fs.existsSync(path.join(project, "docs/rules/titah.md")), true)
})

test("berkas yang SUDAH ada tidak pernah ditimpa", () => {
  const file = path.join(project, "punyaku.md")
  fs.writeFileSync(file, "aturan saya sendiri\n")

  const hasil = ensureDeclared(config({ instructions: "punyaku.md" }), project)

  assert.deepEqual(hasil.files, [], "tidak dilaporkan sebagai dibuat")
  assert.equal(fs.readFileSync(file, "utf8"), "aturan saya sendiri\n")
})

test("berkas KOSONG juga tidak ditimpa", () => {
  /*
   * Berkas kosong adalah keputusan yang sah — user sengaja mematikan sebuah
   * instruksi tanpa menghapusnya dari config. Menimpanya dengan template akan
   * menghapus keputusan itu, dan diam-diam menghidupkan lagi aturan contoh.
   */
  const file = path.join(project, "sengaja-kosong.md")
  fs.writeFileSync(file, "")

  ensureDeclared(config({ instructions: "sengaja-kosong.md" }), project)
  assert.equal(fs.readFileSync(file, "utf8"), "")
})

test("folder skill yang didaftarkan dibuat kalau belum ada", () => {
  const parsed = Config.parse({
    skills: { discover: [], paths: [{ path: "skills", as: "punyaku" }] },
  })
  const hasil = ensureDeclared(parsed, project)

  assert.deepEqual(hasil.dirs, [path.join(project, "skills")])
  assert.equal(fs.statSync(path.join(project, "skills")).isDirectory(), true)
})

test("folder skill hasil AUTO-DETEKSI tidak pernah dibuat", () => {
  /*
   * `~/.claude/skills` milik Claude Code. Titah mengintip ke sana kalau
   * `discover` menyalakannya, dan mengintip tidak memberinya hak membuat
   * direktori di wilayah alat lain.
   */
  const parsed = Config.parse({ skills: { discover: ["claude", "opencode"], paths: [] } })
  const hasil = ensureDeclared(parsed, project)

  assert.deepEqual(hasil.dirs, [])
  assert.equal(fs.existsSync(path.join(os.homedir(), ".claude")), false)
})

test("tidak menebak: berkas yang tidak didaftarkan tidak dibuat", () => {
  // Berkas yang muncul tanpa pernah diminta lebih buruk daripada berkas yang
  // hilang — user tidak punya cara menghubungkannya dengan apa pun.
  ensureDeclared(config({}), project)
  assert.deepEqual(fs.readdirSync(project), [])
})

// ---------- kabarnya ----------

test("yang dibuat DILAPORKAN, dengan path yang bisa dibuka", () => {
  const parsed = Config.parse({
    skills: { discover: [], paths: ["skills"] },
    instructions: "titah-instruction.md",
  })
  const notice = scaffoldNotice(ensureDeclared(parsed, project), project) ?? ""

  assert.match(notice, /titah-instruction\.md/)
  assert.match(notice, /skills/)
  assert.match(notice, /next turn/, "dan menyebut kapan berlakunya")
})

test("tidak ada yang dibuat berarti tidak ada kabar", () => {
  assert.equal(scaffoldNotice({ files: [], dirs: [] }, project), undefined)
})

// ---------- sampai ke prompt ----------

test("instruksi yang baru dibuat IKUT ke system prompt", () => {
  /*
   * Sambungan yang paling mudah putus: `ensureDeclared` dan `buildSystemPrompt`
   * harus meresolusi path dengan cara yang SAMA. Kalau berbeda, berkasnya
   * muncul di disk tapi instruksinya tetap tidak pernah berlaku — persis
   * kegagalan yang ingin ditutup fitur ini.
   */
  const parsed = config({ instructions: { path: "aturan.md" } })
  ensureDeclared(parsed, project)
  fs.writeFileSync(path.join(project, "aturan.md"), "WAJIB pakai sub-agent untuk semua task.")

  const system = buildSystemPrompt(parsed, project).system
  assert.match(system, /WAJIB pakai sub-agent/)
})

// ---------- giliran sungguhan ----------

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

function mock(): void {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "siap" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
  restore?.()
  restore = setModelResolver(
    () =>
      new MockLanguageModelV4({
        doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
      }),
  )
}

test("giliran PERTAMA sebuah sesi membuat berkas yang dijanjikan config", async () => {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: ["skills"] },
      instructions: { path: "titah-instruction.md" },
    }),
  )
  mock()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "halo", agent: "build" })

  assert.equal(fs.existsSync(path.join(project, "titah-instruction.md")), true)
  assert.equal(fs.existsSync(path.join(project, "skills")), true)
})

test("berkas yang user HAPUS di tengah sesi tidak dibuat ulang tiap giliran", async () => {
  /*
   * Sekali per sesi, bukan per giliran. Kalau tiap giliran, menghapus berkas
   * yang sengaja tidak diinginkan jadi mustahil selama sesi berjalan — ia
   * muncul lagi sebelum prompt berikutnya sempat dikirim.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] }, instructions: "sekali.md" }),
  )
  mock()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "pertama", agent: "build" })
  assert.equal(fs.existsSync(path.join(project, "sekali.md")), true)

  fs.rmSync(path.join(project, "sekali.md"))
  await prompt({ sessionID: session.id, text: "kedua", agent: "build" })

  assert.equal(
    fs.existsSync(path.join(project, "sekali.md")),
    false,
    "giliran kedua tidak boleh menyentuh disk lagi",
  )
})
