import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, after, beforeEach } from "node:test"
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-agent-learn-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "learn.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, savePlan } = await import("../src/core/storage/session.ts")
const { LEARN_SYSTEM, reflectionDone } = await import("../src/core/learn.ts")
const { learnedSkillsDir } = await import("../src/core/paths.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi\n")
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

function configWith(learn: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [], learn },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow" },
      ...extra,
    }),
  )
}

/** Giliran yang membaca `a.txt` sebanyak `reads` kali lalu menjawab; refleksi menjawab `decision`. */
function model(reads: number, decision: string): { reflections: number } {
  const seen = { reflections: 0 }
  let step = 0
  const mock = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const system = options.prompt.find((m) => m.role === "system")
      const isReflection = system !== undefined && system.content === LEARN_SYSTEM
      let chunks: LanguageModelV4StreamPart[]
      if (isReflection) {
        seen.reflections += 1
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: decision },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ]
      } else if (step < reads) {
        step += 1
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `c${step}`, toolName: "read", input: JSON.stringify({ path: "a.txt" }) },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]
      } else {
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "selesai" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ]
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => mock)
  return seen
}

const CREATE = JSON.stringify({
  action: "create",
  name: "baca-berkas",
  description: "Use when reading a.txt repeatedly",
  body: "1. read a.txt",
})

test("giliran dengan 8 tool call memicu refleksi dan skill tertulis", async () => {
  configWith({ enabled: true })
  const seen = model(8, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 1)
  assert.ok(fs.existsSync(path.join(learnedSkillsDir(), "baca-berkas", "SKILL.md")))
})

test("learn: false mematikan refleksi walau syaratnya lolos — dipakai `titah run`", async () => {
  /*
   * `titah run` keluar begitu `session.idle` terbit; refleksi yang baru mulai
   * sesudahnya dibayar tapi tidak pernah selesai. `prompt({ learn: false })`
   * adalah caranya menolak membayar itu sama sekali.
   */
  configWith({ enabled: true })
  const seen = model(8, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang", learn: false })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 0)
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
})

test("7 tool call: model penilai tidak dipanggil sama sekali", async () => {
  configWith({ enabled: true })
  const seen = model(7, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 0)
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
})

test("learn mati: tidak ada refleksi walau giliran panjang", async () => {
  configWith({ enabled: false })
  const seen = model(12, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 0)
})

test("skill yang dipelajari muncul di katalog giliran berikutnya", async () => {
  configWith({ enabled: true })
  model(8, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  const { buildSkillIndex } = await import("../src/core/skill.ts")
  const { loadConfig } = await import("../src/core/config.ts")
  const ids = buildSkillIndex(loadConfig(project).config, project).skills.map((s) => s.id)
  assert.ok(ids.includes("learned:baca-berkas"), ids.join(","))
})

// ---------- refleksi sesudah auto-lanjutan ----------

test("giliran yang auto-lanjut merefleksikan PERMINTAAN ASLI, bukan teks lanjutan buatan Titah", async () => {
  /*
   * Giliran pertama mentok jatah langkah (steps: 10) sementara rencananya
   * masih punya sisa, jadi ia dilanjutkan sendiri (`limits.continueTurns: 1`).
   * Giliran lanjutan itu yang memicu refleksi — dan digest yang dikirim ke
   * model penilai harus memuat permintaan user ASLI ("kerjakan fitur X"),
   * bukan CONTINUE_TEXT ("[titah] Your previous turn ...") yang cuma instruksi
   * internal untuk model utama.
   */
  configWith({ enabled: true }, { limits: { continueTurns: 1 }, agent: { pendek: { mode: "primary", steps: 10 } } })

  const session = createSession(project)
  savePlan(session.id, "- [ ] satu\n- [ ] dua")

  let reflectionPrompt = ""
  let reflections = 0
  let segmentTwoCalls = 0

  const mock = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const system = options.prompt.find((m) => m.role === "system")
      const isReflection = system !== undefined && system.content === LEARN_SYSTEM

      if (isReflection) {
        reflections += 1
        const user = options.prompt.find((m) => m.role === "user")
        reflectionPrompt =
          typeof user?.content === "string"
            ? user.content
            : JSON.stringify(user?.content ?? "")
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: '{"action":"none"}' },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ],
          }),
        }
      }

      const users = options.prompt.filter((m) => m.role === "user")
      const last = users.at(-1)?.content
      const lastText = Array.isArray(last)
        ? ((last.find((part) => part.type === "text") as { text?: string } | undefined)?.text ?? "")
        : typeof last === "string"
          ? last
          : ""
      const isContinuation = lastText.startsWith("[titah]")

      let chunks: LanguageModelV4StreamPart[]
      if (isContinuation) {
        segmentTwoCalls += 1
        chunks =
          segmentTwoCalls <= 8
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: `s2-${segmentTwoCalls}`,
                  toolName: "read",
                  input: JSON.stringify({ path: "a.txt" }),
                },
                { type: "finish", finishReason: "tool-calls", usage: USAGE },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "selesai" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: "stop", usage: USAGE },
              ]
      } else {
        // Segmen pertama: SELALU tool call selama tool-nya ditawarkan, biar
        // jatah langkahnya habis (stoppedAtLimit) dan giliran dilanjutkan.
        const hasTools = (options.tools ?? []).length > 0
        chunks = hasTools
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "s1", toolName: "read", input: JSON.stringify({ path: "a.txt" }) },
              { type: "finish", finishReason: "tool-calls", usage: USAGE },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "terpotong" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ]
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => mock)

  await prompt({ sessionID: session.id, text: "kerjakan fitur X", agent: "pendek" })
  await reflectionDone(session.id)

  assert.equal(reflections, 1, "refleksi persis satu kali, dari segmen lanjutan")
  assert.match(reflectionPrompt, /kerjakan fitur X/, "digest memuat permintaan ASLI")
  assert.doesNotMatch(
    reflectionPrompt,
    /\[titah\] Your previous turn/,
    "bukan teks CONTINUE_TEXT buatan Titah sendiri",
  )
})
