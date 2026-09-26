import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

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
