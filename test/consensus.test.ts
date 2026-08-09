import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildComparison, runConsensus, type AgentAnswer } from "../src/core/consensus.ts"
import { Config } from "../src/core/schema.ts"

const STUB = path.join(import.meta.dirname, "fixtures", "stub-agent.js")
const cwd = fs.realpathSync(os.tmpdir())

function configWith(agents: Record<string, unknown>) {
  return Config.parse({ externalAgent: agents })
}

const stub = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [STUB, "{prompt}", "--session-id", "{session}"],
  sessionMode: "generate",
  format: "stream-json",
  timeout: 10_000,
  ...extra,
})

test("konsensus menyebar ke semua agent yang tersedia secara paralel", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const config = configWith({ satu: stub(), dua: stub() })

  const result = await runConsensus({
    config,
    question: "apa ibu kota Indonesia?",
    cwd,
    signal: new AbortController().signal,
    synthesize: async (_system, prompt) => `sintesis atas:\n${prompt}`,
  })

  assert.deepEqual(result.answers.map((a) => a.agentID).sort(), ["dua", "satu"])
  assert.deepEqual(result.failed, [])
  assert.match(result.synthesis, /Answer from @satu/)
  assert.match(result.synthesis, /Answer from @dua/)
})

test("agent yang tidak terpasang dilewati tanpa menggagalkan konsensus", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const config = configWith({
    ada: stub(),
    hilang: { command: "titah-agent-yang-tidak-ada" },
  })

  const result = await runConsensus({
    config,
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    synthesize: async () => "ok",
  })

  assert.deepEqual(result.answers.map((a) => a.agentID), ["ada"])
})

test("agent yang gagal tetap dilaporkan, tidak menghilang diam-diam", async () => {
  const config = configWith({ baik: stub(), rusak: stub() })

  // Stub memakai satu env untuk semua, jadi mode crash membuat KEDUANYA gagal —
  // yang diuji di sini adalah pelaporannya.
  process.env.TITAH_STUB_MODE = "crash"
  const result = await runConsensus({
    config,
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    synthesize: async () => "tidak seharusnya dipanggil",
  })

  assert.deepEqual(result.failed.sort(), ["baik", "rusak"])
  assert.match(result.synthesis, /No agent managed to answer/)
  assert.equal(result.answers.length, 2, "yang gagal tetap muncul di daftar jawaban")
})

test("satu agent saja tidak bisa disebut konsensus, dan dikatakan apa adanya", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const config = configWith({ sendiri: stub() })

  let dipanggil = false
  const result = await runConsensus({
    config,
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    synthesize: async () => {
      dipanggil = true
      return "x"
    },
  })

  assert.match(result.synthesis, /Only @sendiri/)
  assert.equal(dipanggil, false, "sintesis tidak perlu dijalankan untuk satu jawaban")
})

test("tanpa agent eksternal sama sekali, konsensus memberi instruksi", async () => {
  const result = await runConsensus({
    config: configWith({}),
    question: "halo",
    cwd,
    signal: new AbortController().signal,
  })

  assert.deepEqual(result.answers, [])
  assert.match(result.synthesis, /titah doctor/)
})

test("tanpa model Titah, jawaban mentah tetap dikembalikan", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const config = configWith({ satu: stub(), dua: stub() })

  const result = await runConsensus({
    config,
    question: "halo",
    cwd,
    signal: new AbortController().signal,
  })

  assert.equal(result.answers.length, 2)
  assert.match(result.synthesis, /synthesis skipped/)
})

test("perbandingan hanya memuat jawaban yang berhasil, diberi label agent-nya", () => {
  const answers: AgentAnswer[] = [
    { agentID: "a", answer: "jawaban A", durationMs: 1, usage: {} },
    { agentID: "b", answer: "", durationMs: 1, usage: {}, error: "meledak" },
    { agentID: "c", answer: "jawaban C", durationMs: 1, usage: {} },
  ]
  const comparison = buildComparison(answers, "pertanyaannya")

  assert.match(comparison, /Question:\npertanyaannya/)
  assert.match(comparison, /### Answer from @a/)
  assert.match(comparison, /### Answer from @c/)
  assert.doesNotMatch(comparison, /@b/, "agent yang gagal tidak boleh masuk perbandingan")
})

test("prompt sintesis meminta ketidaksepakatan ditandai eksplisit", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  let system = ""
  await runConsensus({
    config: configWith({ satu: stub(), dua: stub() }),
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    synthesize: async (sys) => {
      system = sys
      return "ok"
    },
  })

  assert.match(system, /DISAGREE/)
  assert.match(system, /Do not invent agreement/)
})

test("onAnswer dipanggil per agent, tidak menunggu yang paling lambat", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const urutan: string[] = []

  await runConsensus({
    config: configWith({ satu: stub(), dua: stub() }),
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    onAnswer: (answer) => urutan.push(answer.agentID),
    synthesize: async () => {
      // Saat sintesis dijalankan, SEMUA agent sudah dilaporkan lewat onAnswer.
      assert.equal(urutan.length, 2, "onAnswer harus mendahului sintesis")
      return "ok"
    },
  })

  assert.deepEqual(urutan.sort(), ["dua", "satu"])
})

test("onAnswer juga dipanggil untuk agent yang gagal", async () => {
  process.env.TITAH_STUB_MODE = "crash"
  const gagal: string[] = []

  await runConsensus({
    config: configWith({ satu: stub() }),
    question: "halo",
    cwd,
    signal: new AbortController().signal,
    onAnswer: (answer) => {
      if (answer.error !== undefined) gagal.push(answer.agentID)
    },
  })

  assert.deepEqual(gagal, ["satu"])
})
