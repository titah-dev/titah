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
const { abort } = await import("../src/core/agent.ts")
const { createSession, listChildSessions } = await import("../src/core/storage/session.ts")
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

test("tombol x membatalkan sub-agent ber-delegate: CLI-nya mati dan statusnya stopped", async () => {
  /*
   * Temuan Penting review akhir: `abort(childSessionID)` — persis yang dikirim
   * tombol `x` di panel — hanya melihat peta `running` milik `prompt()`. Jalur
   * delegasi tidak pernah lewat sana, jadi id anak tidak pernah terdaftar:
   * `abort` mengembalikan false, CLI eksternal terus jalan sampai timeout-nya
   * sendiri (default 600 detik), dan barisnya tetap "running" sementara kuota
   * habis. Satu-satunya jalan keluar user adalah membatalkan seluruh giliran
   * koordinator — persis yang panel ini ada untuk dihindari.
   *
   * Timeout stub sengaja jauh lebih panjang dari test ini: kalau pembatalan
   * TIDAK sampai ke subprocess, test ini menggantung berdetik-detik lalu gagal
   * dengan "failed"/timeout, bukan lolos diam-diam.
   */
  process.env.TITAH_STUB_MODE = "slow"
  const parent = createSession(project)
  const config = Config.parse({
    agent: { reviewer: { mode: "subagent", delegate: "stub" } },
    externalAgent: {
      stub: {
        command: process.execPath,
        args: [FIXTURE, "{prompt}"],
        sessionMode: "generate",
        format: "stream-json",
        timeout: 30_000,
      },
    },
  })

  const running = runSubagent({
    parentSessionID: parent.id,
    agentID: "reviewer",
    instruction: "kerja yang menggantung",
    cwd: project,
    config,
    // Sinyal induk TIDAK PERNAH dibatalkan di sini: giliran koordinator harus
    // tetap hidup, hanya anaknya yang dihentikan.
    signal: new AbortController().signal,
  })

  const child = listChildSessions(parent.id).at(-1)
  assert.ok(child, "sesi anak harus sudah ada begitu runSubagent dipanggil")

  // Beri subprocess-nya waktu benar-benar hidup, supaya yang diuji adalah
  // pembunuhan proses yang sedang berjalan, bukan jendela antrean sebelum
  // adapter sempat dipanggil.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(abort(child.id), true, "sesi anak ber-delegate harus punya handle pembatalan")

  const result = await running
  assert.equal(result.status, "stopped")
  assert.match(result.answer, /STOPPED BY USER/)
  assert.doesNotMatch(result.answer, /FAILED/)
})
