import assert from "node:assert/strict"
import test from "node:test"
import {
  browseHistory,
  DRAFT,
  lineEnd,
  lineStart,
  moveCursorVisualLine,
  onFirstVisualLine,
  onLastVisualLine,
  pushHistory,
  visualRows,
  wordLeft,
  wordRight,
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

/** Lebar yang jauh lebih besar dari teksnya: tidak ada yang terbungkus. */
const LEBAR = 100

test("kursor pindah baris sambil mempertahankan kolom", () => {
  const text = "abcdef\nghijkl"
  assert.equal(
    moveCursorVisualLine(text, 9, -1, LEBAR),
    2,
    "kolom 2 di baris kedua → kolom 2 di baris pertama",
  )
  assert.equal(moveCursorVisualLine(text, 2, 1, LEBAR), 9)
})

test("baris tujuan yang lebih pendek menaruh kursor di ujungnya", () => {
  // Tanpa penjepitan ini, kursor meluber ke baris berikutnya dan terlihat
  // melompat dua baris sekaligus.
  assert.equal(moveCursorVisualLine("ab\nlebih panjang", 12, -1, LEBAR), 2)
})

test("kursor tidak bergerak di luar baris pertama dan terakhir", () => {
  const text = "satu\ndua"
  assert.equal(moveCursorVisualLine(text, 1, -1, LEBAR), 1)
  assert.equal(moveCursorVisualLine(text, 6, 1, LEBAR), 6)
})

test("tepi baris menentukan kapan panah jadi histori, bukan gerak kursor", () => {
  const text = "atas\nbawah"
  assert.equal(onFirstVisualLine(text, 2, LEBAR), true)
  assert.equal(onFirstVisualLine(text, 7, LEBAR), false)
  assert.equal(onLastVisualLine(text, 7, LEBAR), true)
  assert.equal(onLastVisualLine(text, 2, LEBAR), false)
  assert.equal(
    onFirstVisualLine("satu baris", 3, LEBAR),
    true,
    "draft satu baris selalu di kedua tepi",
  )
  assert.equal(onLastVisualLine("satu baris", 3, LEBAR), true)
})

// ---------- baris visual ----------

test("baris yang dibungkus terminal dihitung sebagai baris tersendiri", () => {
  // Inti perbaikannya: tanpa titik bungkus, satu kalimat panjang adalah SATU
  // baris, dan panah atas melompatinya sekaligus lalu mengganti draft dengan
  // entri histori — persis yang membuat panah terasa rusak pada prompt panjang.
  assert.deepEqual(visualRows("abcdefghij", 4), [0, 4, 8])
  assert.deepEqual(visualRows("abc\ndef", 100), [0, 4], "`\\n` tetap memulai baris")
  assert.deepEqual(visualRows("", 10), [0], "draft kosong tetap satu baris")
})

test("lebar yang tidak masuk akal tidak membungkus apa pun", () => {
  // Nol kolom pernah mungkin terjadi saat terminal dilaporkan berukuran 0 di
  // tengah resize. Membungkus setiap karakter di situ berarti daftar barisnya
  // sepanjang teksnya, dan kursor berhenti bisa digerakkan.
  assert.deepEqual(visualRows("abcdef", 0), [0])
  assert.deepEqual(visualRows("abcdef", -5), [0])
})

test("panah menelusuri baris terbungkus, bukan melompatinya", () => {
  const text = "abcdefghij"
  assert.equal(moveCursorVisualLine(text, 9, -1, 4), 5, "kolom 1 di baris ketiga → baris kedua")
  assert.equal(onFirstVisualLine(text, 5, 4), false, "baris kedua bukan tepi atas")
  assert.equal(onLastVisualLine(text, 9, 4), true)
})

test("kolom dihitung dengan lebar tampilan, bukan jumlah karakter", () => {
  // `漢` dan `字` masing-masing dua kolom, jadi keduanya sudah memenuhi lebar 4
  // dan `abc` turun ke baris berikutnya. Menghitung `text.length` akan menaruh
  // titik bungkusnya dua karakter terlalu jauh.
  const text = "漢字abc"
  assert.deepEqual(visualRows(text, 4), [0, 2])
  assert.equal(moveCursorVisualLine(text, 4, -1, 4), 1, "kolom 2 mendarat sesudah `漢`")
})

// ---------- lompat per kata ----------

test("lompat per kata berhenti di tanda baca, bukan hanya di spasi", () => {
  // Jalur dan pemanggilan fungsi adalah yang paling sering disunting di prompt
  // ini; satu perhentian per spasi berarti `src/tui/app.tsx` hanya punya satu.
  const text = "buka src/tui/app.tsx lalu"
  assert.equal(wordRight(text, 0), 4, "dari awal `buka` ke akhirnya")
  assert.equal(wordRight(text, 4), 8, "melewati spasi, berhenti di akhir `src`")
  assert.equal(wordLeft(text, 20), 17, "dari akhir `tsx` ke awalnya")
})

test("lompat per kata berhenti di ujung teks, tidak melewatinya", () => {
  assert.equal(wordLeft("satu dua", 0), 0)
  assert.equal(wordRight("satu dua", 8), 8)
  assert.equal(wordLeft("   ", 3), 0, "teks tanpa kata sama sekali")
})

// ---------- awal dan akhir baris ----------

test("ctrl+a dan ctrl+e berhenti di baris LOGIS, bukan di ujung teks", () => {
  // Sebelumnya keduanya melompat ke awal/akhir seluruh draft, yang membuat
  // namanya berbohong begitu draft punya lebih dari satu baris.
  const text = "satu\ndua tiga\nempat"
  assert.equal(lineStart(text, 8), 5)
  assert.equal(lineEnd(text, 8), 13)
  assert.equal(lineStart(text, 0), 0)
  assert.equal(lineEnd(text, 16), text.length, "baris terakhir berakhir di ujung teks")
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
