import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Isolasi HOME/XDG dulu, SEBELUM modul apa pun diimpor — sama seperti
// test/subagent-run.test.ts. Task ini yang paling mudah melanggar aturan itu:
// delegasi ke CLI eksternal adalah persis yang harus di-stub, dan
// `createSession`/`createChildSession` menulis DB lewat path yang jatuh balik
// ke `os.homedir()` kalau XDG_DATA_HOME/TITAH_DB tidak diisi.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-subagent-delegate-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "subagent-delegate.db")
process.env.HOME = path.join(root, "home")

const { runSubagent } = await import("../src/core/subagent.ts")
const { createSession } = await import("../src/core/storage/session.ts")
const { Config } = await import("../src/core/schema.ts")

const FIXTURE = path.join(import.meta.dirname, "fixtures", "stub-agent.js")
const project = fs.realpathSync(fs.mkdtempSync(path.join(root, "proyek-")))

test("sub-agent ber-delegate menjalankan CLI eksternal, bukan loop Titah", async () => {
  process.env.TITAH_STUB_MODE = "claude"
  const parent = createSession(project)
  const config = Config.parse({
    agent: { reviewer: { mode: "subagent", delegate: "stub" } },
    externalAgent: {
      stub: {
        command: process.execPath,
        args: [FIXTURE, "{prompt}", "--session-id", "{session}"],
        resumeArgs: [FIXTURE, "{prompt}", "--resume", "{session}"],
        sessionMode: "generate",
        format: "stream-json",
        timeout: 10_000,
      },
    },
  })

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "reviewer",
    instruction: "tinjau ini",
    cwd: project,
    config,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "done")
  assert.notEqual(result.answer, "")
})

test("delegate yang menunjuk agent eksternal tak dikenal gagal dengan jelas", async () => {
  const parent = createSession(project)
  const config = Config.parse({ agent: { x: { mode: "subagent", delegate: "hantu" } } })

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "x",
    instruction: "apa saja",
    cwd: project,
    config,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "failed")
  assert.match(result.answer, /hantu/)
})

test("adapter yang reject (timeout CLI) menjadi status failed, bukan exception yang lolos", async () => {
  // `subprocess.ts` reject dengan DelegationError untuk timeout, abort, dan
  // CLI yang tidak terpasang — bukan mengembalikan `isError`. Kontrak
  // `runSubagent` melarang exception lolos ke giliran koordinator, jadi
  // rejection itu harus tertangkap dan berubah jadi hasil "failed" di sini.
  process.env.TITAH_STUB_MODE = "slow"
  const parent = createSession(project)
  const config = Config.parse({
    agent: { slow: { mode: "subagent", delegate: "stub" } },
    externalAgent: {
      stub: {
        command: process.execPath,
        args: [FIXTURE, "{prompt}"],
        sessionMode: "generate",
        format: "stream-json",
        timeout: 50,
      },
    },
  })

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "slow",
    instruction: "kerja lama",
    cwd: project,
    config,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "failed")
  assert.match(result.answer, /timeout/i)
})
