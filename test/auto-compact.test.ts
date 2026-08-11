import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import type { ModelMessage } from "ai"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-autocompact-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "autocompact.db")
process.env.HOME = path.join(root, "home")

const { autoCompact } = await import("../src/core/auto-compact.ts")
const { createSession, appendModelMessages, listModelRows, latestCompaction, listModelMessages } =
  await import("../src/core/storage/session.ts")

after(() => fs.rmSync(root, { recursive: true, force: true }))

const CONFIG = { auto: true, reserved: 100, tailTurns: 1, prune: true }

const bigResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "text", value: "x".repeat(20_000) },
    },
  ],
})
const call = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})

function seed(): string {
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "giliran satu" },
    call("a"),
    bigResult("a"),
    { role: "assistant", content: "selesai satu" },
    { role: "user", content: "giliran dua" },
    { role: "assistant", content: "selesai dua" },
  ])
  return session.id
}

test("di bawah ambang, tidak melakukan apa pun", async () => {
  const sessionID = seed()
  const before = listModelRows(sessionID)

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 32768,
    lastStepTokens: 10,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })

  assert.equal(result.ran, false)
  assert.deepEqual(listModelRows(sessionID), before)
})

test("contextWindow yang tidak dideklarasikan tidak pernah menjalankan apa pun", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: undefined,
    lastStepTokens: 999_999,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })
  assert.equal(result.ran, false)
})

test("prune jalan lebih dulu, dan tersimpan ke baris", async () => {
  const sessionID = seed()

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 950,
    summarise: async () => "RINGKASAN",
  })

  assert.equal(result.ran, true)
  assert.ok(result.prunedBytes > 10_000)

  // Positif dulu: barisnya memang masih ada dan strukturnya utuh.
  const rows = listModelRows(sessionID)
  assert.equal(rows.length, 6)
  assert.equal(rows[2]?.message.role, "tool")
  // Baru negatif: isinya sudah tidak ada.
  assert.doesNotMatch(JSON.stringify(rows[2]?.message), /xxxxx/)
})

test("prune yang tidak cukup naik ke peringkasan", async () => {
  const sessionID = seed()
  let called = 0

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999, // jauh di atas apa pun yang bisa dibebaskan prune
    summarise: async (system, prompt) => {
      called += 1
      assert.match(system, /compress a coding session/)
      assert.match(prompt, /giliran satu/)
      return "RINGKASAN"
    },
  })

  assert.equal(called, 1)
  assert.equal(result.summarised, true)
  assert.equal(latestCompaction(sessionID)?.summary.includes("RINGKASAN"), true)

  // Giliran terakhir tetap utuh — itu arti tailTurns.
  const visible = listModelMessages(sessionID)
  assert.match(JSON.stringify(visible), /giliran dua/)
})

test("focus diteruskan ke prompt peringkas", async () => {
  const sessionID = seed()
  let seen = ""
  await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    focus: "modul autentikasi",
    summarise: async (_system, prompt) => {
      seen = prompt
      return "RINGKASAN"
    },
  })
  assert.match(seen, /modul autentikasi/)
})

test("prune: false melewatkan prune dan langsung meringkas", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: { ...CONFIG, prune: false },
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => "RINGKASAN",
  })
  assert.equal(result.prunedBytes, 0)
  assert.equal(result.summarised, true)
})
