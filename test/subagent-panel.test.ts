import assert from "node:assert/strict"
import test from "node:test"
import { panelLines } from "../dist/tui/subagent-panel.js"

/**
 * Rendering murni, tanpa Ink — sama seperti spinnerFrame di components.tsx.
 */

test("baris antre menjelaskan KENAPA ia belum jalan", () => {
  // Tanpa baris ini, penulis yang mengantre terlihat persis seperti macet.
  const lines = panelLines(
    [
      { sessionID: "a", agent: "explore", status: "running", startedAt: Date.now() - 12_000, note: "reading files" },
      { sessionID: "b", agent: "qc-developer", status: "queued", startedAt: Date.now(), note: "waiting for a turn" },
    ],
    Date.now(),
  )

  assert.match(lines[0] ?? "", /◐ explore\s+12s\s+reading files/)
  assert.match(lines[1] ?? "", /∅ qc-developer\s+waiting for a turn/)
})

test("sub-agent selesai tetap terlihat, dengan durasinya", () => {
  const lines = panelLines(
    [{ sessionID: "a", agent: "analyst", status: "done", startedAt: Date.now() - 31_000, note: "done" }],
    Date.now(),
  )
  assert.match(lines[0] ?? "", /✓ analyst\s+31s/)
})

test("glyph gagal dan dihentikan tercetak benar — belum ada test untuk keduanya", () => {
  // Regresi review: hanya running/queued/done pernah diuji. ✗ dan ⊘ baru
  // ketahuan salah lewat pembacaan kode, bukan lewat suite yang "hijau".
  const now = Date.now()
  const lines = panelLines(
    [
      { sessionID: "a", agent: "builder", status: "failed", startedAt: now - 5_000, note: "build error" },
      { sessionID: "b", agent: "reviewer", status: "stopped", startedAt: now - 3_000, note: "cancelled by user" },
    ],
    now,
  )

  assert.match(lines[0] ?? "", /✗ builder\s+5s\s+build error/)
  assert.match(lines[1] ?? "", /⊘ reviewer\s+3s\s+cancelled by user/)
})
