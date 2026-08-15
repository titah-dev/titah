import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { claudeParser, opencodeParser, textParser, finalize } from "../src/core/delegate/parse.ts"
import { createSubprocessAdapter } from "../src/core/delegate/subprocess.ts"
import { listAgents, parseMention } from "../src/core/delegate/index.ts"
import { DelegationError } from "../src/core/delegate/types.ts"
import { Config, EXAMPLE_EXTERNAL_AGENTS, ExternalAgent } from "../src/core/schema.ts"

const STUB = path.join(import.meta.dirname, "fixtures", "stub-agent.js")
const cwd = fs.realpathSync(os.tmpdir())

function stubAgent(mode: string, overrides: Record<string, unknown> = {}) {
  process.env.TITAH_STUB_MODE = mode
  return ExternalAgent.parse({
    command: process.execPath,
    args: [STUB, "{prompt}", "--session-id", "{session}"],
    resumeArgs: [STUB, "{prompt}", "--resume", "{session}"],
    sessionMode: "generate",
    format: "stream-json",
    timeout: 10_000,
    ...overrides,
  })
}

const run = (agent: ReturnType<typeof stubAgent>, id = "claude", extra = {}) =>
  createSubprocessAdapter(id, agent).prompt({
    prompt: "halo",
    cwd,
    signal: new AbortController().signal,
    ...extra,
  })

// ---------- parseMention ----------

test("parseMention mengenali @agent dan memisahkan promptnya", () => {
  assert.deepEqual(parseMention("@claude tolong review file ini"), {
    agentID: "claude",
    prompt: "tolong review file ini",
  })
  assert.deepEqual(parseMention("  @open-code  baca src  "), {
    agentID: "open-code",
    prompt: "baca src",
  })
})

test("parseMention mengabaikan teks yang bukan delegasi", () => {
  assert.equal(parseMention("email saya akil@gmail.com"), undefined)
  assert.equal(parseMention("@claude"), undefined, "tanpa prompt bukan delegasi")
  assert.equal(parseMention("tolong @claude review"), undefined, "harus di awal")
  assert.equal(parseMention("@1agent halo"), undefined, "harus diawali huruf")
})

test("parseMention mempertahankan prompt multi-baris", () => {
  const mention = parseMention("@claude baris satu\nbaris dua")
  assert.equal(mention?.prompt, "baris satu\nbaris dua")
})

// ---------- parser ----------

test("parser claude mengambil jawaban, sesi, token, dan biaya dari event result", () => {
  const parser = claudeParser()
  parser.line('{"type":"system","subtype":"init","session_id":"abc"}')
  parser.line('{"type":"assistant","session_id":"abc","message":{"content":[{"type":"text","text":"draf"}]}}')
  parser.line(
    '{"type":"result","subtype":"success","is_error":false,"session_id":"abc","result":"jawaban final","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":3}}',
  )

  const result = finalize(parser, "raw", 100)
  assert.equal(result.answer, "jawaban final")
  assert.equal(result.externalSessionID, "abc")
  assert.deepEqual(result.usage, { input: 10, output: 3, cost: 0.5 })
  assert.equal(result.isError, false)
})

test("parser claude menandai hasil yang bukan success sebagai error", () => {
  const parser = claudeParser()
  parser.line('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"x"}')
  const result = finalize(parser, "raw", 1)
  assert.equal(result.isError, true)
})

test("parser claude melewati baris rusak tanpa menggagalkan delegasi", () => {
  const parser = claudeParser()
  parser.line("bukan json")
  parser.line("{ rusak")
  parser.line('{"type":"result","subtype":"success","result":"tetap dapat","session_id":"s"}')

  const result = finalize(parser, "raw", 1)
  assert.equal(result.answer, "tetap dapat")
  assert.equal(result.isError, false)
})

test("parser opencode merakit jawaban dari beberapa part text", () => {
  const parser = opencodeParser()
  parser.line('{"type":"step_start","sessionID":"ses_1","part":{}}')
  parser.line('{"type":"text","sessionID":"ses_1","part":{"text":"Halo "}}')
  parser.line('{"type":"text","sessionID":"ses_1","part":{"text":"dunia"}}')
  parser.line(
    '{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":50,"output":2},"cost":0.01}}',
  )

  const result = finalize(parser, "raw", 5)
  assert.equal(result.answer, "Halo dunia")
  assert.equal(result.externalSessionID, "ses_1")
  assert.deepEqual(result.usage, { input: 50, output: 2, cost: 0.01 })
})

test("parser mengeluarkan update sesi tepat sekali", () => {
  const parser = opencodeParser()
  const first = parser.line('{"type":"step_start","sessionID":"ses_1","part":{}}')
  const second = parser.line('{"type":"text","sessionID":"ses_1","part":{"text":"x"}}')

  assert.deepEqual(first, [{ kind: "session", sessionID: "ses_1" }])
  assert.ok(!second.some((update) => update.kind === "session"), "sesi sama tidak diulang")
})

test("parser teks memakai seluruh stdout sebagai jawaban", () => {
  const parser = textParser()
  parser.line("baris satu")
  parser.line("baris dua")
  assert.equal(finalize(parser, "raw", 1).answer, "baris satu\nbaris dua")
})

// ---------- adapter subprocess ----------

test("adapter menjalankan CLI dan mengembalikan jawaban beserta metadata", async () => {
  const result = await run(stubAgent("claude"))
  assert.match(result.answer, /^awal: halo$/)
  assert.deepEqual(result.usage, { input: 200, output: 11, cost: 0.0345 })
  assert.equal(result.isError, false)
  assert.ok(result.transcript.includes('"type":"result"'), "transkrip mentah harus disimpan")
})

test("sesi yang dilanjutkan memakai resumeArgs, bukan args awal", async () => {
  const result = await run(stubAgent("claude"), "claude", {
    resumeSessionID: "11111111-1111-1111-1111-111111111111",
  })
  assert.match(result.answer, /^lanjutan: halo$/)
  assert.equal(result.externalSessionID, "11111111-1111-1111-1111-111111111111")
})

test("sessionMode generate memberikan UUID ke CLI pada panggilan pertama", async () => {
  const result = await run(stubAgent("claude"))
  assert.match(
    result.externalSessionID ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
})

test("sessionMode discover membaca id sesi dari output", async () => {
  const agent = stubAgent("opencode", {
    args: [STUB, "run", "{prompt}"],
    resumeArgs: [STUB, "run", "{prompt}", "--session", "{session}"],
    sessionMode: "discover",
    format: "json",
  })
  const result = await run(agent, "opencode")
  assert.equal(result.externalSessionID, "ses_stub_baru")
  assert.match(result.answer, /opencode menjawab/)
})

test("CLI yang keluar dengan error dilaporkan, bukan dianggap jawaban kosong", async () => {
  const result = await run(stubAgent("crash"))
  assert.equal(result.isError, true)
  assert.match(result.errorMessage ?? "", /exited with code 1/)
  assert.match(result.errorMessage ?? "", /exploded/, "stderr harus ikut dilaporkan")
})

test("output sampah menjadi error yang jelas, bukan jawaban kosong yang senyap", async () => {
  const result = await run(stubAgent("garbage"))
  assert.equal(result.isError, true)
  assert.match(result.errorMessage ?? "", /without a readable answer/)
  assert.ok(result.transcript.includes("<html>"), "transkrip mentah tetap disimpan untuk diagnosis")
})

test("CLI yang selesai tanpa output sama sekali juga dilaporkan sebagai error", async () => {
  const result = await run(stubAgent("empty"))
  assert.equal(result.isError, true)
})

test("timeout menghentikan CLI dan menyebut batas waktunya", async () => {
  const result = run(stubAgent("slow", { timeout: 300 }))
  await assert.rejects(() => result, (error: unknown) => {
    assert.ok(error instanceof DelegationError)
    assert.match(error.message, /timeout 0 detik|timeout/)
    return true
  })
})

test("abort menghentikan CLI yang sedang berjalan", async () => {
  process.env.TITAH_STUB_MODE = "slow"
  const controller = new AbortController()
  const adapter = createSubprocessAdapter("claude", stubAgent("slow"))
  const running = adapter.prompt({ prompt: "halo", cwd, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(() => running, /Cancelled/)
})

test("CLI yang tidak terpasang ditolak dengan pesan yang menyebut perintahnya", async () => {
  const agent = ExternalAgent.parse({ command: "titah-agent-yang-tidak-ada" })
  const adapter = createSubprocessAdapter("hantu", agent)

  assert.equal(adapter.available, false)
  assert.equal(adapter.executable, undefined)
  await assert.rejects(
    () => adapter.prompt({ prompt: "x", cwd, signal: new AbortController().signal }),
    /titah-agent-yang-tidak-ada/,
  )
})

test("update di-stream ke pemanggil selama CLI berjalan", async () => {
  const updates: string[] = []
  await createSubprocessAdapter("claude", stubAgent("claude")).prompt({
    prompt: "halo",
    cwd,
    signal: new AbortController().signal,
    onUpdate: (update) => updates.push(update.kind),
  })
  assert.ok(updates.includes("session"))
  assert.ok(updates.includes("tool"), "aktivitas tool agent eksternal harus terlihat")
})

// ---------- registry ----------

test("agent yang tidak terpasang tetap terdaftar, tidak disembunyikan", () => {
  const config = Config.parse({
    externalAgent: {
      ada: { command: process.execPath },
      hilang: { command: "titah-agent-yang-tidak-ada" },
    },
  })
  const agents = listAgents(config)

  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.available]).sort(),
    [
      ["ada", true],
      ["hilang", false],
    ],
  )
})

test("contoh claude dan opencode memakai argumen yang terverifikasi", () => {
  /*
   * Keduanya TIDAK lagi disuntik ke config siapa pun — mereka contoh siap
   * salin. Tetap diuji karena argumen di dalamnya diverifikasi langsung
   * terhadap biner, bukan disalin dari dokumentasi, dan `titah doctor`
   * menawarkannya apa adanya.
   */
  const claude = ExternalAgent.parse(EXAMPLE_EXTERNAL_AGENTS["claude"])
  const opencode = ExternalAgent.parse(EXAMPLE_EXTERNAL_AGENTS["opencode"])

  assert.ok(claude.specialist.length > 0, "contoh harus memuat specialist yang wajib itu")
  assert.ok(opencode.specialist.length > 0)

  assert.ok(claude.args.includes("--verbose"), "Claude menolak stream-json tanpa --verbose")
  assert.ok(claude.resumeArgs.includes("--resume"), "resume bukan --session-id lagi")
  assert.equal(claude.sessionMode, "generate")
  assert.equal(claude.timeout, 600_000, "default 10 menit (Q24)")

  assert.equal(opencode.sessionMode, "discover")
  assert.ok(!opencode.args.includes("--session"), "panggilan pertama opencode tanpa id sesi")
  assert.ok(opencode.resumeArgs.includes("--session"))
})
