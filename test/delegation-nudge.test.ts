import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * Mengapa sub-agent tidak pernah dipanggil, dan empat hal yang menyebabkannya.
 *
 * Diukur sebelum perbaikan pada `9router/ant` dengan tugas yang jelas cocok:
 * satu delegasi dari lima percobaan. Bukan "tidak pernah", tapi cukup dekat
 * sehingga panel sub-agent praktis selalu kosong.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-dn-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "dn.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver, planSteps } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")
const { buildSystemPrompt, rosterSection } = await import("../src/core/prompt.ts")
const { Config, DEFAULT_AGENTS } = await import("../src/core/schema.ts")

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

const ROSTER = { explore: { mode: "all", description: "Menelusuri codebase" } }

function configWith(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] }, agent: ROSTER, ...extra }),
  )
}

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: body },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", usage: USAGE },
]

/**
 * `id` WAJIB berbeda antar panggilan.
 *
 * `upsert` menyimpan state tool berdasarkan callID, jadi dua panggilan dengan
 * id yang sama saling menimpa — dan test yang memeriksa panggilan PERTAMA
 * diam-diam membaca hasil yang kedua.
 */
const call = (tool: string, input: unknown, id = "c1"): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: tool, input: JSON.stringify(input) },
  { type: "finish", finishReason: "tool-calls", usage: USAGE },
]

function mock(steps: LanguageModelV4StreamPart[][]): void {
  let index = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = steps[Math.min(index, steps.length - 1)] as LanguageModelV4StreamPart[]
      index += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)
}

const planOutput = (sessionID: string): string =>
  listMessages(sessionID)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool")
    .map((part) => (part as { state: { output?: string } }).state.output ?? "")
    .join("\n")

const RENCANA_PANJANG = "1. baca semua modul\n2. jalankan test\n3. tulis laporan\n4. rapikan"

// ---------- 1. inventaris tool ----------

test("daftar tool di prompt menyebut `task` — dulu tidak", () => {
  /*
   * Sebab paling merugikan, karena bentuknya daftar yang terlihat berwibawa.
   * "Available tools:" dulu memuat tujuh baris tanpa `task` sama sekali, jadi
   * model membaca inventaris resmi yang mengatakan delegasi bukan bagian dari
   * kemampuannya — lalu jauh di bawah menemukan roster yang menyebutnya.
   */
  const built = buildSystemPrompt(Config.parse({ agent: ROSTER }), project, "build")
  const daftar = built.system.slice(
    built.system.indexOf("Available tools:"),
    built.system.indexOf("About `plan`"),
  )
  assert.match(daftar, /task/, "`task` harus ada di inventaris, bukan hanya di roster")
  assert.match(daftar, /skill/)
  assert.match(daftar, /github/)
})

// ---------- 2. prompt build ----------

test('prompt `build` tidak lagi menyuruh mengerjakan "directly"', () => {
  // Satu kata itu meniadakan seluruh blok roster beberapa baris di bawahnya:
  // perintah tegas mengalahkan saran bersyarat.
  const build = DEFAULT_AGENTS["build"]?.prompt ?? ""
  assert.doesNotMatch(build, /request directly/)
  assert.match(build, /task/, "sebaliknya, ia menyebut delegasi sebagai jalan yang sah")
})

test("prompt `build-auto` justru mendorong delegasi", () => {
  const auto = DEFAULT_AGENTS["build-auto"]?.prompt ?? ""
  assert.match(auto, /roster/i)
  assert.match(auto, /parallel work costs you nothing/)
})

// ---------- 3. kriteria roster ----------

test("roster memberi kriteria yang bisa dinilai, bukan ajakan bersyarat", () => {
  /*
   * Versi lama: "when it matches their description better than doing it
   * yourself". Untuk tugas kecil itu memang salah — membaca tiga berkas sendiri
   * lebih murah. Modelnya menalar dengan benar; kalimatnya yang tidak memicu.
   */
  const roster = rosterSection(Config.parse({ agent: ROSTER })) ?? ""
  assert.match(roster, /reading many files/)
  assert.match(roster, /do not depend on each other/)
  assert.doesNotMatch(roster, /better than doing it/)
})

// ---------- 4. sakelar ----------

test('delegation "never" tidak mengirim roster sama sekali', () => {
  // Daftar yang tidak boleh dipakai tetap dibayar sebagai token setiap
  // permintaan — jadi ia tidak dikirim, bukan sekadar diabaikan.
  assert.equal(rosterSection(Config.parse({ agent: ROSTER, delegation: "never" })), undefined)
})

test('delegation "always" menambahkan kalimat yang tidak bersyarat', () => {
  const roster = rosterSection(Config.parse({ agent: ROSTER, delegation: "always" })) ?? ""
  assert.match(roster, /delegates by default/)
})

test("bawaannya `ask`", () => {
  assert.equal(Config.parse({}).delegation, "ask")
})

// ---------- 5. analisa sesudah rencana ----------

test("menghitung langkah dari BUTIR, bukan dari baris", () => {
  /*
   * Rencana yang ditulis sebagai satu paragraf panjang memang bukan rencana
   * bertahap; menghitungnya sebagai sepuluh langkah akan memicu pertanyaan pada
   * pekerjaan yang sebetulnya tunggal.
   */
  assert.equal(planSteps("1. satu\n2. dua\n3. tiga"), 3)
  assert.equal(planSteps("- satu\n* dua\n+ tiga\n4) empat"), 4)
  assert.equal(planSteps("kalimat panjang\nyang dibungkus\njadi tiga baris"), 0)
  assert.equal(planSteps(""), 0)
})

test("rencana panjang memicu catatan yang menyuruh model BERTANYA", async () => {
  configWith()
  mock([call("plan", { text: RENCANA_PANJANG }), text("baik")])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build", auto: true })

  const output = planOutput(session.id)
  assert.match(output, /before you start/)
  assert.match(output, /Delegate: hand matching steps/)
  assert.match(output, /Inline: do all of it yourself/)
  assert.match(output, /do NOT ask/, "dan kapan TIDAK boleh bertanya")
})

test("rencana pendek tidak memicu apa pun", async () => {
  // Dua langkah dikerjakan sendiri; menanyakannya hanya menambah dialog.
  configWith()
  mock([call("plan", { text: "1. baca\n2. tulis" }), text("baik")])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build", auto: true })
  assert.doesNotMatch(planOutput(session.id), /before you start/)
})

test("tanpa sub-agent, tidak ada yang bisa ditanyakan", async () => {
  configWith({ agent: {} })
  mock([call("plan", { text: RENCANA_PANJANG }), text("baik")])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build", auto: true })
  assert.doesNotMatch(planOutput(session.id), /before you start/)
})

test('delegation "auto" menghitung sendiri tanpa bertanya', async () => {
  configWith({ delegation: "auto" })
  mock([call("plan", { text: RENCANA_PANJANG }), text("baik")])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build", auto: true })
  assert.doesNotMatch(planOutput(session.id), /before you start/)
})

test("hanya SEKALI per sesi", async () => {
  /*
   * Rencana diperbarui berkali-kali dalam satu giliran panjang — itu memang
   * gunanya. Pertanyaan yang ikut muncul di setiap pembaruan berhenti dibaca
   * justru ketika ia mulai berarti.
   */
  configWith()
  mock([
    call("plan", { text: RENCANA_PANJANG }, "p1"),
    call("plan", { text: `${RENCANA_PANJANG}\n5. sekali lagi` }, "p2"),
    text("baik"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build", auto: true })

  const muncul = planOutput(session.id).split("before you start").length - 1
  assert.equal(muncul, 1, `catatan muncul ${muncul} kali`)
})
