import assert from "node:assert/strict"
import test from "node:test"
import { panelLines, panelWindowStart, SUBAGENT_PANEL_ROWS } from "../dist/tui/subagent-panel.js"
import { childHeader, EMPTY_NOTE } from "../dist/tui/child-page.js"

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


// ---------- jendela panel ----------

test("jendela panel berpusat pada baris terpilih, dan berhenti di kedua ujung", () => {
  /*
   * Diuji terpisah karena DUA pihak membacanya: komponen yang menggambar, dan
   * peta klik di app.tsx. Selama daftarnya lebih pendek dari jendela, keduanya
   * setuju apa pun rumusnya — kesalahannya baru muncul pada sepuluh sub-agent,
   * yaitu tepat ketika panel ini paling berguna.
   */
  assert.equal(panelWindowStart(3, 0, SUBAGENT_PANEL_ROWS), 0, "muat semua, tidak bergulir")
  assert.equal(panelWindowStart(20, 0, 8), 0, "tidak pernah bergulir ke atas melewati nol")
  assert.equal(panelWindowStart(20, 10, 8), 6, "terpilih di tengah jendela")
  assert.equal(panelWindowStart(20, 19, 8), 12, "berhenti supaya baris terakhir tetap terisi")
})

// ---------- judul halaman transkrip ----------

test("judul halaman menyebut jumlah pesan hanya kalau sudah selesai", () => {
  // Selagi berjalan, angkanya berubah tiap detik dan tidak menjawab pertanyaan
  // yang sedang dipunyai pembacanya — ia cuma ingin tahu ini belum selesai.
  assert.equal(childHeader("explore", true, 3), "sub-agent · explore · working")
  assert.equal(childHeader("explore", false, 3), "sub-agent · explore · 3 messages")
  assert.equal(childHeader("explore", false, 1), "sub-agent · explore · 1 message")
  assert.equal(childHeader("explore", false, 0), "sub-agent · explore · 0 messages")
})

test("halaman kosong menyebut kedua sebabnya, bukan menuduh satu", () => {
  // Sesi anak yang kosong punya dua sebab yang sama masuk akal, dan menyebut
  // satu saja akan salah setengah waktu.
  assert.match(EMPTY_NOTE, /external CLI/)
  assert.match(EMPTY_NOTE, /cancelled before it started/)
})
