import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-ret-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.TITAH_DB = path.join(root, "ret.db")

const { prune, sweepSnapshots, sweepToolOutput, referencedOutputs, formatBytes } = await import(
  "../src/core/retention.ts"
)
const { storeOutput, INLINE_LIMIT } = await import("../src/core/storage/blob.ts")
const { createMessage, createSession, saveMessage } = await import(
  "../src/core/storage/session.ts"
)
const { database } = await import("../src/core/storage/db.ts")
const { toolOutputDir, snapshotDir } = await import("../src/core/paths.ts")
const { shadowDirName } = await import("../src/core/snapshot.ts")

const project = path.join(root, "proyek")

/** Membuat pesan dengan blob tool-output besar, seperti tool sungguhan. */
function messageWithBlob(sessionID: string, callID: string): string {
  const stored = storeOutput(callID, "x".repeat(INLINE_LIMIT + 100))
  const message = createMessage(sessionID, "assistant", [])
  message.parts.push({
    type: "tool",
    callID,
    tool: "read",
    state: {
      status: "completed",
      input: {},
      title: "read besar",
      output: stored.output,
      ...(stored.outputRef ? { outputRef: stored.outputRef } : {}),
      truncated: stored.truncated,
      started: 1,
      ended: 2,
    },
  })
  saveMessage(message)
  return stored.outputRef as string
}

beforeEach(() => {
  database().exec("DELETE FROM session")
  fs.rmSync(toolOutputDir(), { recursive: true, force: true })
  fs.rmSync(snapshotDir(), { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test("blob yang masih disebut pesan tidak ikut disapu", () => {
  const session = createSession(project)
  const ref = messageWithBlob(session.id, "call_hidup")

  assert.ok(referencedOutputs().has(path.resolve(ref)))
  const swept = sweepToolOutput()

  assert.equal(swept.files, 0)
  assert.equal(fs.existsSync(ref), true)
})

test("blob yatim disapu beserta ukurannya dilaporkan", () => {
  const session = createSession(project)
  const ref = messageWithBlob(session.id, "call_yatim")

  // Sesi dihapus → referensinya hilang → blobnya jadi yatim.
  database().exec("DELETE FROM session")
  const swept = sweepToolOutput()

  assert.equal(swept.files, 1)
  assert.ok(swept.bytes > INLINE_LIMIT)
  assert.equal(fs.existsSync(ref), false)
})

test("snapshot proyek yang masih punya sesi dipertahankan", () => {
  const session = createSession(project)
  // Wajib punya pesan: sesi kosong tidak dianggap hidup, dan memang tidak
  // mungkin menghasilkan snapshot karena snapshot lahir dari panggilan tool.
  createMessage(session.id, "user", [{ type: "text", text: "kerjakan sesuatu" }])
  const dir = path.join(snapshotDir(), shadowDirName(project))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n")

  const swept = sweepSnapshots()

  assert.equal(swept.snapshots, 0, `sesi ${session.id} masih hidup`)
  assert.equal(fs.existsSync(dir), true)
})

test("snapshot proyek tanpa sesi disapu", () => {
  const dir = path.join(snapshotDir(), shadowDirName("/proyek/yang/sudah/hilang"))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "HEAD"), "isi\n")

  const swept = sweepSnapshots()

  assert.equal(swept.snapshots, 1)
  assert.equal(fs.existsSync(dir), false)
  assert.ok(swept.bytes > 0)
})

test("prune menyapu DB, blob, dan snapshot dalam satu perintah", () => {
  const lama = createSession(project)
  messageWithBlob(lama.id, "call_lama")

  const dir = path.join(snapshotDir(), shadowDirName("/proyek/lain"))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "HEAD"), "isi\n")

  database()
    .prepare("UPDATE session SET updated = ? WHERE id = ?")
    .run(Date.now() - 40 * 86_400_000, lama.id)

  const result = prune(30 * 86_400_000)

  assert.equal(result.sessions, 1)
  assert.equal(result.files, 1, "blob milik sesi yang dihapus harus ikut disapu")
  assert.equal(result.snapshots, 1)
  assert.ok(result.bytes > INLINE_LIMIT)
})

test("prune pada penyimpanan bersih tidak melakukan apa-apa dan tidak error", () => {
  const result = prune(30 * 86_400_000)
  assert.deepEqual(result, { sessions: 0, files: 0, bytes: 0, snapshots: 0 })
})

test("sesi yang belum tua tidak ikut terhapus beserta blobnya", () => {
  const baru = createSession(project)
  const ref = messageWithBlob(baru.id, "call_baru")

  const result = prune(30 * 86_400_000)

  assert.equal(result.sessions, 0)
  assert.equal(result.files, 0)
  assert.equal(fs.existsSync(ref), true)
})

test("formatBytes membaca enak di tiap ordo", () => {
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2.0 KB")
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB")
})
