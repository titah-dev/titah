import assert from "node:assert/strict"
import test from "node:test"
import { createMouseFilter, MOUSE_OFF, MOUSE_ON } from "../src/tui/mouse.ts"
import { describeInput, messageLines } from "../src/tui/layout.ts"
import type { Message } from "../src/core/message.ts"

const ESC = "\u001b"
const sgr = (code: number, x: number, y: number, final = "M") => `${ESC}[<${code};${x};${y}${final}`

// ---------- penyaringan ----------

test("klik kiri diurai jadi koordinat, dan byte-nya TIDAK diteruskan ke Ink", () => {
  // Kalau byte-nya lolos, Ink membacanya sebagai Escape — yang di Titah berarti
  // membatalkan giliran. Satu klik akan menghentikan pekerjaan yang berjalan.
  const filter = createMouseFilter()
  const { events, text } = filter(sgr(0, 12, 7))

  assert.deepEqual(events, [{ kind: "press", x: 12, y: 7 }])
  assert.equal(text, "")
})

test("lepas tombol dibedakan dari tekan", () => {
  const filter = createMouseFilter()
  assert.equal(filter(sgr(0, 1, 1, "m")).events[0]?.kind, "release")
})

test("roda mouse jadi gulir atas dan bawah", () => {
  const filter = createMouseFilter()
  assert.equal(filter(sgr(64, 5, 5)).events[0]?.kind, "wheel-up")
  assert.equal(filter(sgr(65, 5, 5)).events[0]?.kind, "wheel-down")
})

test("laporan gerakan dibuang, bukan dianggap klik", () => {
  const filter = createMouseFilter()
  assert.deepEqual(filter(sgr(32, 5, 5)).events, [])
})

test("tombol biasa mengalir utuh, termasuk yang mengapit urutan mouse", () => {
  const filter = createMouseFilter()
  const { events, text } = filter(`ha${sgr(0, 2, 3)}lo`)

  assert.equal(text, "halo")
  assert.equal(events.length, 1)
})

test("Escape telanjang TIDAK ditahan — kalau ditahan, pembatalan giliran mati", () => {
  const filter = createMouseFilter()
  assert.equal(filter(ESC).text, ESC)
  assert.equal(filter(`${ESC}[A`).text, `${ESC}[A`, "panah atas juga harus lolos utuh")
})

test("urutan mouse yang terbelah antar chunk disatukan kembali", () => {
  const filter = createMouseFilter()
  const first = filter(`${ESC}[<0;10`)

  assert.deepEqual(first.events, [])
  assert.equal(first.text, "", "potongan setengah jadi tidak boleh bocor ke Ink")

  const second = filter(";4M")
  assert.deepEqual(second.events, [{ kind: "press", x: 10, y: 4 }])
})

test("menyalakan mouse selalu dipasangkan dengan mematikannya", () => {
  // Terminal yang ditinggalkan dalam mode pelacakan mouse akan memuntahkan
  // sampah tiap kali user menggerakkan kursor, sampai ia menjalankan `reset`.
  for (const mode of ["1000", "1006"]) {
    assert.ok(MOUSE_ON.includes(`[?${mode}h`))
    assert.ok(MOUSE_OFF.includes(`[?${mode}l`))
  }
})

// ---------- baris yang bisa diklik ----------

const running = (callID: string): Message => ({
  id: `m-${callID}`,
  sessionID: "s",
  role: "assistant",
  created: 1,
  parts: [
    {
      type: "tool",
      callID,
      tool: "bash",
      state: { status: "running", input: { command: "npm test" }, title: "bash npm test", started: 1 },
    },
  ],
})

test("baris tool membawa callID-nya, supaya klik tahu mana yang dibuka", () => {
  const [head] = messageLines(running("c1"), false)
  assert.equal(head?.toolID, "c1")
})

test("teks user dan asisten tidak bisa diklik", () => {
  const message: Message = {
    id: "m",
    sessionID: "s",
    role: "assistant",
    created: 1,
    parts: [{ type: "text", text: "halo" }],
  }
  assert.equal(messageLines(message, false)[0]?.toolID, undefined)
})

test("himpunan callID hanya membuka tool yang disebut", () => {
  const dibuka = messageLines(running("c1"), new Set(["c1"]))
  const tertutup = messageLines(running("c2"), new Set(["c1"]))

  // Judul selalu memuat perintahnya, jadi yang diperiksa baris RINCIAN-nya.
  assert.ok(dibuka.some((line) => line.kind === "detail"))
  assert.ok(!tertutup.some((line) => line.kind === "detail"))
})

// ---------- rincian saat masih berjalan ----------

test("tool yang SEDANG berjalan memperlihatkan argumennya saat dibuka", () => {
  // Justru di sinilah user paling ingin tahu apa yang sedang dijalankan atas
  // namanya — menunggu selesai dulu membuat rincian itu tidak ada gunanya.
  const tertutup = messageLines(running("c1"), false)
  assert.equal(tertutup.filter((line) => line.kind !== "blank").length, 1)
  assert.match(tertutup[0]?.text ?? "", /⋯$/, "ada penanda bahwa isinya bisa dibuka")

  const terbuka = messageLines(running("c1"), true).filter((line) => line.kind !== "blank")
  assert.equal(terbuka.length, 2)
  assert.match(terbuka[1]?.text ?? "", /command: npm test/)
})

test("argumen tanpa isi tidak memunculkan penanda buka yang menipu", () => {
  const kosong: Message = {
    ...running("c1"),
    parts: [
      {
        type: "tool",
        callID: "c1",
        tool: "todo",
        state: { status: "running", input: {}, title: "todo", started: 1 },
      },
    ],
  }
  assert.doesNotMatch(messageLines(kosong, false)[0]?.text ?? "", /⋯/)
})

test("argumen diringkas: baris baru diratakan, nilai panjang dipotong", () => {
  assert.deepEqual(describeInput({ a: "satu\ndua" }), ["a: satu ⏎ dua"])
  assert.deepEqual(describeInput({ n: 42, ok: true }), ["n: 42", "ok: true"])
  assert.equal(describeInput({ x: "y".repeat(300) }, 20)[0]?.length, 24, "x: + 20 + elipsis")
  assert.deepEqual(describeInput(undefined), [])
})
