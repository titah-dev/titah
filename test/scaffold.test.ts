import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { Config } from "../src/core/schema.ts"
import {
  ensureDeclared,
  findInstructionFiles,
  instructionPaths,
  scaffoldNotice,
} from "../src/core/scaffold.ts"
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
  assert.ok(hasil.files.includes(file))
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

  assert.equal(hasil.files.includes(file), false, "tidak dilaporkan sebagai dibuat")
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

test("tidak menebak: hanya AGENTS.md, tidak ada berkas lain yang mengarang", () => {
  /*
   * AGENTS.md satu-satunya yang dibuat tanpa disebut config, dan itu keputusan
   * eksplisit — nama yang sama dipakai lintas alat, jadi ia bukan tebakan
   * tentang apa yang user inginkan. Selain itu tidak ada: berkas yang muncul
   * tanpa pernah diminta lebih buruk daripada berkas yang hilang, karena user
   * tidak punya cara menghubungkannya dengan apa pun yang ia lakukan.
   */
  ensureDeclared(config({}), project)
  assert.deepEqual(fs.readdirSync(project), ["AGENTS.md"])
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

// ---------- AGENTS.md ----------

test("proyek TANPA instruksi apa pun dapat AGENTS.md", () => {
  const hasil = ensureDeclared(config({}), project)

  const file = path.join(project, "AGENTS.md")
  assert.deepEqual(hasil.files, [file])
  assert.match(fs.readFileSync(file, "utf8"), /# AGENTS\.md/)
})

test("templatenya berisi PERTANYAAN, bukan aturan contoh", () => {
  /*
   * Template yang sudah berisi aturan punya nasib yang bisa ditebak: ia
   * dibiarkan apa adanya, dan Titah lalu bekerja menurut aturan yang tidak
   * pernah dipilih siapa pun. Pertanyaan tidak punya nasib itu — ia jelas belum
   * dijawab selama masih berbentuk pertanyaan.
   */
  ensureDeclared(config({}), project)
  const isi = fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")

  assert.match(isi, /## Commands/)
  assert.match(isi, /<!--/, "keterangannya komentar, jadi tidak ikut terbaca sebagai aturan")
  assert.match(isi, /Build:\n/, "kolom kosong yang menunggu diisi")
})

test("repo yang sudah punya CLAUDE.md TIDAK ditambahi AGENTS.md", () => {
  /*
   * Bukan "kalau AGENTS.md belum ada". Repo yang punya CLAUDE.md sudah menjawab
   * pertanyaan yang sama, dan menaruh AGENTS.md di sebelahnya menghasilkan dua
   * berkas instruksi yang bisa saling bertentangan — dibuat oleh alat yang
   * seharusnya membacanya, bukan menambahinya.
   */
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "aturan lama\n")
  const hasil = ensureDeclared(config({}), project)

  assert.deepEqual(hasil.files, [])
  assert.equal(fs.existsSync(path.join(project, "AGENTS.md")), false)
})

test("AGENTS.md yang sudah ada tidak pernah ditimpa", () => {
  fs.writeFileSync(path.join(project, "AGENTS.md"), "punyaku\n")
  ensureDeclared(config({}), project)
  assert.equal(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8"), "punyaku\n")
})

test("instruksi dari direktori INDUK juga dihitung sudah punya", () => {
  // Monorepo: aturan tinggal di root, dan tiap paket di bawahnya tidak butuh
  // salinannya sendiri. Pencariannya sama dengan yang membacanya ke prompt.
  fs.writeFileSync(path.join(project, "AGENTS.md"), "aturan root\n")
  const paket = path.join(project, "packages", "web")
  fs.mkdirSync(paket, { recursive: true })

  ensureDeclared(config({}), paket)
  assert.equal(fs.existsSync(path.join(paket, "AGENTS.md")), false)
})

test("AGENTS.md yang dibuat langsung IKUT terbaca", () => {
  // Sambungan yang paling mudah putus: dibuat oleh satu pencarian, dibaca oleh
  // pencarian lain. Keduanya `findInstructionFiles` yang sama.
  ensureDeclared(config({}), project)
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# AGENTS.md\n\nWAJIB pakai bahasa Indonesia.\n")

  assert.match(buildSystemPrompt(config({}), project).system, /WAJIB pakai bahasa Indonesia/)
})

// ---------- sakelarnya ----------

test('scaffold: false tidak menulis APA PUN', () => {
  const parsed = Config.parse({
    scaffold: false,
    skills: { discover: [], paths: ["skills"] },
    instructions: "aturan.md",
  })
  const hasil = ensureDeclared(parsed, project)

  assert.deepEqual(hasil, { files: [], dirs: [] })
  assert.deepEqual(fs.readdirSync(project), [], "termasuk AGENTS.md")
})

test("bawaannya menyala", () => {
  // Titah dibuka di repo sendiri jauh lebih sering daripada di repo orang lain,
  // dan berkas yang hilang diam-diam lebih merugikan daripada berkas yang
  // muncul dan bisa dihapus.
  assert.equal(Config.parse({}).scaffold, true)
})

// ---------- pembacanya ----------

test("findInstructionFiles membaca ketiga nama, urut menang-terakhir", () => {
  fs.writeFileSync(path.join(project, "AGENTS.md"), "a")
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "c")
  fs.writeFileSync(path.join(project, "TITAH.md"), "t")

  const found = findInstructionFiles(project).map((file) => path.basename(file.path))
  assert.deepEqual(found, ["AGENTS.md", "CLAUDE.md", "TITAH.md"])
})

test("berhenti di root git, tidak merayap sampai home", () => {
  /*
   * Tanpa batas ini, membuka Titah di sebuah repo akan menyeret AGENTS.md milik
   * setiap direktori di atasnya — termasuk milik proyek lain yang kebetulan
   * satu induk.
   */
  fs.writeFileSync(path.join(project, "AGENTS.md"), "root")
  fs.mkdirSync(path.join(project, ".git"), { recursive: true })
  const dalam = path.join(project, "src", "core")
  fs.mkdirSync(dalam, { recursive: true })
  fs.writeFileSync(path.join(dalam, "AGENTS.md"), "dalam")

  const found = findInstructionFiles(dalam).map((file) => file.content)
  assert.deepEqual(found, ["root", "dalam"], "yang terdekat dibaca terakhir supaya menang")
})

test("direktori tanpa instruksi menghasilkan daftar kosong", () => {
  assert.deepEqual(findInstructionFiles(project), [])
})
