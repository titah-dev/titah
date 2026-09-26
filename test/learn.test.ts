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
const { buildDigest, countToolCalls, DIGEST_CAP, shouldReflect } = await import("../src/core/learn.ts")

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

function toolPart(tool: string, input: unknown, status: "completed" | "error" = "completed") {
  const state =
    status === "completed"
      ? { status, input, title: "", output: "ok", truncated: false, started: 0, ended: 1 }
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
