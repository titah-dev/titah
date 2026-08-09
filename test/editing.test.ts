import assert from "node:assert/strict"
import test from "node:test"
import {
  browseHistory,
  DRAFT,
  moveCursorLine,
  onFirstLine,
  onLastLine,
  pushHistory,
} from "../src/tui/editing.ts"
import { promptHistory, reduce, type TuiState } from "../src/tui/state.ts"
import type { Message } from "../src/core/message.ts"

const HISTORY = ["satu", "dua", "tiga"]

// ---------- telusur histori ----------

test("panah atas dari draft masuk ke prompt TERBARU, lalu mundur", () => {
  const first = browseHistory(HISTORY, DRAFT, -1)
  assert.equal(HISTORY[first], "tiga")
  assert.equal(HISTORY[browseHistory(HISTORY, first, -1)], "dua")
})

test("panah atas berhenti di prompt terlama, tidak berputar", () => {
  // Berputar ke yang terbaru membuat user mengira daftarnya tidak habis-habis.
  assert.equal(browseHistory(HISTORY, 0, -1), 0)
})

test("panah bawah melewati entri terbaru mengembalikan draft yang tadi diketik", () => {
  assert.equal(browseHistory(HISTORY, 2, 1), DRAFT)
  assert.equal(browseHistory(HISTORY, DRAFT, 1), DRAFT, "sudah di draft, diam saja")
})

test("histori kosong tidak memindahkan apa pun", () => {
  assert.equal(browseHistory([], DRAFT, -1), DRAFT)
})

test("prompt yang sama berturut-turut disimpan sekali", () => {
  assert.deepEqual(pushHistory(["a"], "a"), ["a"])
  assert.deepEqual(pushHistory(["a"], "b"), ["a", "b"])
  assert.deepEqual(pushHistory(["a", "b"], "a"), ["a", "b", "a"], "berulang tapi tidak beruntun")
  assert.deepEqual(pushHistory([], ""), [])
})

// ---------- kursor antar baris ----------

test("kursor pindah baris sambil mempertahankan kolom", () => {
  const text = "abcdef\nghijkl"
  assert.equal(moveCursorLine(text, 9, -1), 2, "kolom 2 di baris kedua → kolom 2 di baris pertama")
  assert.equal(moveCursorLine(text, 2, 1), 9)
})

test("baris tujuan yang lebih pendek menaruh kursor di ujungnya", () => {
  // Tanpa penjepitan ini, kursor meluber ke baris berikutnya dan terlihat
  // melompat dua baris sekaligus.
  assert.equal(moveCursorLine("ab\nlebih panjang", 12, -1), 2)
})

test("kursor tidak bergerak di luar baris pertama dan terakhir", () => {
  const text = "satu\ndua"
  assert.equal(moveCursorLine(text, 1, -1), 1)
  assert.equal(moveCursorLine(text, 6, 1), 6)
})

test("tepi baris menentukan kapan panah jadi histori, bukan gerak kursor", () => {
  const text = "atas\nbawah"
  assert.equal(onFirstLine(text, 2), true)
  assert.equal(onFirstLine(text, 7), false)
  assert.equal(onLastLine(text, 7), true)
  assert.equal(onLastLine(text, 2), false)
  assert.equal(onFirstLine("satu baris", 3), true, "draft satu baris selalu di kedua tepi")
  assert.equal(onLastLine("satu baris", 3), true)
})

// ---------- semai dari pesan tersimpan ----------

const user = (text: string): Message => ({
  id: `m${text}`,
  sessionID: "s",
  role: "user",
  created: 1,
  parts: [{ type: "text", text }],
})

test("histori disemai dari prompt user pada sesi yang dilanjutkan", () => {
  const messages: Message[] = [
    user("prompt pertama"),
    { ...user("x"), role: "assistant", parts: [{ type: "text", text: "jawaban" }] },
    user("prompt kedua"),
  ]
  assert.deepEqual(promptHistory(messages), ["prompt pertama", "prompt kedua"])
})

test("pesan user tanpa teks tidak jadi entri histori kosong", () => {
  const kosong: Message = { ...user(""), parts: [{ type: "text", text: "   " }] }
  assert.deepEqual(promptHistory([kosong]), [])
})

// ---------- error dibersihkan saat perintah berikutnya ----------

test("notice.clear membuang error tanpa menyentuh sisa state", () => {
  const state: TuiState = {
    messages: [user("halo")],
    status: "idle",
    error: "provider mati",
    permissionQueue: [],
  }
  const next = reduce(state, { type: "notice.clear" })

  assert.equal(next.error, undefined)
  assert.deepEqual(next.messages, state.messages, "riwayat tidak boleh ikut hilang")
})
