import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * HOME diisolasi SEBELUM impor apa pun dari src/: modul ini menulis ke
 * configDir(), dan tanpa isolasi test-nya menaruh skill di mesin siapa pun
 * yang menjalankannya.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-learn-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.TITAH_DB = path.join(root, "learn.db")
process.env.HOME = path.join(root, "home")

const { Config } = await import("../src/core/schema.ts")
const { learnedSkillsDir, learnLogFile } = await import("../src/core/paths.ts")
const { buildDigest, countToolCalls, DIGEST_CAP, shouldReflect, LEARN_SOURCE, listLearned, parseDecision, validateLearned, writeLearned } = await import("../src/core/learn.ts")
const { bus } = await import("../src/core/event.ts")
const { cancelReflection, LEARN_SYSTEM, reflectionDone, startReflection } = await import("../src/core/learn.ts")

beforeEach(() => {
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

// ---------- config ----------

test("belajar skill MATI secara bawaan, dengan ambang 8 tool dan plafon 30", () => {
  assert.deepEqual(Config.parse({}).skills.learn, { enabled: false, minTools: 8, max: 30 })
})

test("skill yang dipelajari tinggal di folder config, bukan di repo", () => {
  assert.equal(learnedSkillsDir(), path.join(root, "config", "titah", "skills", "learned"))
  assert.equal(learnLogFile(), path.join(root, "config", "titah", "learn.log"))
})

// ---------- saringan ----------

const PASSING = {
  enabled: true,
  isChild: false,
  aborted: false,
  failed: false,
  stoppedAtLimit: false,
  willContinue: false,
  toolCalls: 8,
  minTools: 8,
}

test("giliran yang lolos semua syarat memicu refleksi", () => {
  assert.equal(shouldReflect(PASSING), true)
})

test("setiap syarat yang gagal, sendirian, mencegah refleksi", () => {
  const failing: Partial<typeof PASSING>[] = [
    { enabled: false },
    { isChild: true },
    { aborted: true },
    { failed: true },
    { stoppedAtLimit: true },
    { willContinue: true },
    { toolCalls: 7 },
  ]
  for (const change of failing) {
    assert.equal(shouldReflect({ ...PASSING, ...change }), false, JSON.stringify(change))
  }
})

function toolPart(
  tool: string,
  input: unknown,
  status: "completed" | "error" = "completed",
  outcome?: "failed" | "stopped"
) {
  const state =
    status === "completed"
      ? { status, input, title: "", output: "ok", truncated: false, started: 0, ended: 1, ...(outcome ? { outcome } : {}) }
      : { status, input, error: "boom", started: 0, ended: 1 }
  return { type: "tool" as const, callID: `c-${tool}`, tool, state }
}

test("hanya part tool yang dihitung sebagai tool call", () => {
  const parts = [{ type: "text" as const, text: "x" }, toolPart("bash", {}), toolPart("read", {})]
  assert.equal(countToolCalls(parts as never), 2)
})

// ---------- digest ----------

test("digest memuat permintaan, urutan tool, jawaban akhir, dan skill yang ada", () => {
  const digest = buildDigest({
    request: "deploy ke staging",
    parts: [
      toolPart("bash", { command: "npm run build" }),
      toolPart("bash", { command: "rsync dist/ staging:" }, "error"),
      { type: "text", text: "Sudah terdeploy." },
    ] as never,
    learned: [{ name: "deploy-prod", description: "Use when deploying to prod" }],
  })
  assert.match(digest, /deploy ke staging/)
  assert.match(digest, /1\. bash \{"command":"npm run build"\} → ok/)
  assert.match(digest, /2\. bash \{"command":"rsync dist\/ staging:"\} → error/)
  assert.match(digest, /Sudah terdeploy\./)
  assert.match(digest, /deploy-prod: Use when deploying to prod/)
})

test("task yang completed dengan outcome failed tampil sebagai → failed, bukan → ok", () => {
  const digest = buildDigest({
    request: "deploy",
    parts: [toolPart("task", { name: "subtask" }, "completed", "failed")] as never,
    learned: [],
  })
  assert.match(digest, /1\. task \{.*name.*\} → failed/)
})

test("digest dibatasi, dan yang dibuang adalah tool di TENGAH", () => {
  const parts = Array.from({ length: 400 }, (_, i) => toolPart("bash", { command: `step-${i} ${"x".repeat(150)}` }))
  const digest = buildDigest({ request: "r", parts: parts as never, learned: [] })
  assert.ok(digest.length <= DIGEST_CAP, `${digest.length}`)
  assert.match(digest, /step-0 /)
  assert.match(digest, /step-399 /)
  assert.match(digest, /tool calls omitted/)
})

test("permintaan dan jawaban panjang dipotong di 2.000 karakter", () => {
  const digest = buildDigest({
    request: "a".repeat(5000),
    parts: [{ type: "text", text: "b".repeat(5000) }] as never,
    learned: [],
  })
  assert.ok(!digest.includes("a".repeat(2001)))
  assert.ok(!digest.includes("b".repeat(2001)))
})

// ---------- keputusan ----------

test("JSON berpagar diurai; sampah dibaca sebagai none", () => {
  const fenced = '```json\n{"action":"create","name":"a-b","description":"d","body":"b"}\n```'
  assert.deepEqual(parseDecision(fenced), { action: "create", name: "a-b", description: "d", body: "b" })
  assert.deepEqual(parseDecision("bukan json"), { action: "none" })
  assert.deepEqual(parseDecision('{"action":"delete"}'), { action: "none" })
  assert.deepEqual(parseDecision('{"action":"create","name":1}'), { action: "none" })
})

// ---------- validasi ----------

const GOOD = { action: "create" as const, name: "deploy-sims", description: "Use when deploying SIMS", body: "1. build\n2. ship" }

test("keputusan yang baik lolos validasi", () => {
  assert.equal(validateLearned(GOOD, [], 30), undefined)
})

test("nama, deskripsi, dan body yang berbahaya ditolak", () => {
  const bad: Partial<typeof GOOD>[] = [
    { name: "../evil" },
    { name: "a/b" },
    { name: "Deploy" },
    { name: "a.b" },
    { name: "a" },
    { name: "x".repeat(50) },
    { description: "" },
    { description: "x".repeat(161) },
    { description: "dua\nbaris" },
    { body: "" },
    { body: "x".repeat(8193) },
  ]
  for (const change of bad) {
    assert.equal(typeof validateLearned({ ...GOOD, ...change }, [], 30), "string", JSON.stringify(change))
  }
})

test("bentuk rahasia yang umum ditolak", () => {
  const secrets = [
    "export KEY=sk-ant-api03-abcdefghijklmnopqrstuv",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "password=hunter2",
    "token: 9f8e7d6c5b4a",
  ]
  for (const secret of secrets) {
    assert.match(validateLearned({ ...GOOD, body: `langkah\n${secret}` }, [], 30) ?? "", /secret/, secret)
  }
})

test("plafon menolak create, tapi update tetap boleh", () => {
  const existing = [{ name: "deploy-sims", description: "d", file: "/x", source: LEARN_SOURCE }]
  assert.match(validateLearned({ ...GOOD, name: "lain" }, existing, 1) ?? "", /cap/)
  assert.equal(validateLearned({ ...GOOD, action: "update" }, existing, 1), undefined)
})

test("update hanya untuk skill milik Titah yang sudah ada", () => {
  const userWritten = [{ name: "deploy-sims", description: "d", file: "/x" }]
  assert.match(validateLearned({ ...GOOD, action: "update" }, userWritten, 30) ?? "", /not written by Titah/)
  assert.match(validateLearned({ ...GOOD, action: "update" }, [], 30) ?? "", /does not exist/)
  const mine = [{ name: "deploy-sims", description: "d", file: "/x", source: LEARN_SOURCE }]
  assert.match(validateLearned(GOOD, mine, 30) ?? "", /already exists/)
})

// ---------- menulis ----------

test("tulis atomik dengan frontmatter lengkap, lalu terbaca lagi", () => {
  const file = writeLearned(GOOD, "ses_1", undefined, new Date("2026-09-27T10:00:00Z"))
  assert.equal(file, path.join(learnedSkillsDir(), "deploy-sims", "SKILL.md"))
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /^---\nname: deploy-sims\ndescription: Use when deploying SIMS\nsource: titah-learn\n/)
  assert.match(text, /created: 2026-09-27T10:00:00.000Z\nupdated: 2026-09-27T10:00:00.000Z\nsession: ses_1\n---\n/)
  assert.match(text, /1\. build\n2\. ship\n$/)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["SKILL.md"], "tidak ada berkas .tmp tertinggal")
  assert.deepEqual(listLearned().map((s) => [s.name, s.source]), [["deploy-sims", LEARN_SOURCE]])
})

test("update mempertahankan created dan menaikkan updated", () => {
  writeLearned(GOOD, "ses_1", undefined, new Date("2026-09-27T10:00:00Z"))
  const file = writeLearned({ ...GOOD, action: "update", body: "baru" }, "ses_2", undefined, new Date("2026-09-28T10:00:00Z"))
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /created: 2026-09-27T10:00:00.000Z/)
  assert.match(text, /updated: 2026-09-28T10:00:00.000Z/)
  assert.match(text, /session: ses_2/)
  assert.match(text, /baru\n$/)
})

test("user-written file dengan nama frontmatter berbeda ditolak untuk nama folder", () => {
  // Simulasi berkas milik pengguna di folder "my-notes" tapi dengan nama frontmatter "my-notes-v2"
  const userDir = path.join(learnedSkillsDir(), "my-notes")
  fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(
    path.join(userDir, "SKILL.md"),
    "---\nname: my-notes-v2\ndescription: User notes\n---\n\nSome content"
  )
  const existing = listLearned()
  // Folder "my-notes" sekarang ada, jadi create dengan nama "my-notes" harus ditolak
  const decision = { action: "create" as const, name: "my-notes", description: "d", body: "b" }
  assert.match(validateLearned(decision, existing, 30) ?? "", /already exists/)
})

test("writeLearned dengan action create pada folder yang ada melempar error dan tidak mengubah file", () => {
  const file = writeLearned(GOOD, "ses_1", undefined, new Date("2026-09-27T10:00:00Z"))
  const originalContent = fs.readFileSync(file, "utf8")
  // Coba create dengan nama yang sama, harus melempar
  assert.throws(() => {
    writeLearned({ ...GOOD, action: "create" }, "ses_2", undefined, new Date("2026-09-27T11:00:00Z"))
  })
  // File tidak berubah
  const finalContent = fs.readFileSync(file, "utf8")
  assert.equal(finalContent, originalContent)
})

// ---------- refleksi ----------

const USAGE = {
  inputTokens: { total: 1200, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 80, text: undefined, reasoning: undefined },
}

function answering(text: string): { model: MockLanguageModelV4; systems: string[] } {
  const systems: string[] = []
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt.find((m) => m.role === "system")
      if (system && typeof system.content === "string") systems.push(system.content)
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ],
        }),
      }
    },
  })
  return { model, systems }
}

/**
 * `bus.subscribe` mengembalikan AsyncIterable. Event didorong sinkron ke
 * buffer, tapi loop `for await` baru membacanya di mikrotugas berikutnya —
 * jadi `stop()` memberi satu putaran event loop sebelum berhenti.
 */
function notices(sessionID: string): { messages: string[]; stop: () => Promise<void> } {
  const messages: string[] = []
  const controller = new AbortController()
  void (async () => {
    for await (const event of bus.subscribe({ sessionID, signal: controller.signal, client: false })) {
      if (event.type === "session.notice") messages.push(event.message)
    }
  })()
  return {
    messages,
    stop: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort()
    },
  }
}

const PARTS = [toolPart("bash", { command: "make deploy" }), { type: "text", text: "done" }] as never

test("create menulis skill, memberi satu notice, dan mencatat token di log", async () => {
  const { model, systems } = answering(JSON.stringify(GOOD))
  const seen = notices("ses_r1")
  startReflection({ sessionID: "ses_r1", streamSessionID: "ses_r1", request: "deploy", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r1")
  await seen.stop()

  assert.equal(systems[0], LEARN_SYSTEM)
  assert.ok(fs.existsSync(path.join(learnedSkillsDir(), "deploy-sims", "SKILL.md")))
  assert.equal(seen.messages.length, 1)
  assert.match(seen.messages[0] ?? "", /^Learned a skill: learned:deploy-sims → /)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r1 created deploy-sims .*in=1200 out=80/)
})

test("none tidak menulis apa pun dan tidak memberi notice", async () => {
  const { model } = answering('{"action":"none"}')
  const seen = notices("ses_r2")
  startReflection({ sessionID: "ses_r2", streamSessionID: "ses_r2", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r2")
  await seen.stop()

  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.deepEqual(seen.messages, [])
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r2 none/)
})

test("keputusan yang ditolak validasi dicatat, tidak ditulis", async () => {
  const { model } = answering(JSON.stringify({ ...GOOD, body: "password=hunter2" }))
  startReflection({ sessionID: "ses_r3", streamSessionID: "ses_r3", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r3")
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r3 rejected .*secret/)
})

test("model yang melempar tidak bocor keluar — hanya dicatat", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("provider down")
    },
  })
  startReflection({ sessionID: "ses_r4", streamSessionID: "ses_r4", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r4")
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r4 error .*provider down/)
})

test("refleksi kedua untuk sesi yang sama dilewati selama yang pertama berjalan", async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1
      await gate
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
    },
  })
  startReflection({ sessionID: "ses_r5", streamSessionID: "ses_r5", request: "r", parts: PARTS, model, max: 30 })
  startReflection({ sessionID: "ses_r5", streamSessionID: "ses_r5", request: "r", parts: PARTS, model, max: 30 })
  release()
  await reflectionDone("ses_r5")
  assert.equal(calls, 1)
})

test("nama keputusan yang berisi baris baru dan 5000 karakter jadi SATU baris log, ≤ 400 karakter", async () => {
  // decision.name, alasan validasi, dan pesan error provider dikendalikan
  // model/provider, bukan Titah — baris baru atau panjang tak terbatas di
  // sana tidak boleh memecah "satu baris per refleksi" di learn.log.
  const nastyName = `bad\nname${"x".repeat(5000)}`
  const decision = JSON.stringify({ action: "create", name: nastyName, description: "d", body: "b" })
  const { model } = answering(decision)
  startReflection({ sessionID: "ses_r7", streamSessionID: "ses_r7", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r7")

  const log = fs.readFileSync(learnLogFile(), "utf8")
  const lines = log.trim().split("\n")
  assert.equal(lines.length, 1)
  assert.ok((lines[0] ?? "").length <= 400, `${(lines[0] ?? "").length}`)
  assert.doesNotMatch(lines[0] ?? "", /\n/)
})

test("cancelReflection menghentikan refleksi yang sedang berjalan tanpa menulis", async () => {
  const model = new MockLanguageModelV4({
    doStream: async (options) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")))
      }),
  })
  startReflection({ sessionID: "ses_r6", streamSessionID: "ses_r6", request: "r", parts: PARTS, model, max: 30 })
  cancelReflection("ses_r6")
  await reflectionDone("ses_r6")
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r6 cancelled/)
})
