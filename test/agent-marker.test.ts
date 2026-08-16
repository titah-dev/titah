import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import type { Message } from "../src/core/message.ts"
import { allLines, messageLines, runningFrame, toolSteps, turnAgent } from "../src/tui/layout.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-mark-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "mark.db")
process.env.HOME = path.join(root, "home")

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * Penanda agent, dan dua animasi.
 *
 * Semuanya diuji sebagai fungsi murni — tanpa merender Ink sama sekali, sesuai
 * pola `spinnerFrame` dan `subagent-panel`.
 */

const pesan = (extra: Partial<Message> = {}): Message => ({
  id: "m1",
  sessionID: "s1",
  role: "assistant",
  created: 0,
  parts: [{ type: "text", text: "jawaban" }],
  ...extra,
})

const teks = (lines: ReturnType<typeof messageLines>) => lines.map((line) => line.text).join("\n")

// ---------- penanda di kaki jawaban ----------

test("jawaban model diakhiri baris yang menyebut agent-nya", () => {
  const lines = messageLines(pesan({ agent: "build" }), false)
  const byline = lines.filter((line) => line.kind === "byline")

  assert.equal(byline.length, 1, "tepat satu, bukan satu per bagian")
  assert.match(byline[0]?.text ?? "", /build/)
})

test("penandanya di KAKI, bukan di kepala", () => {
  /*
   * Letaknya yang membuatnya berguna. Pertanyaan "ini tadi agent apa?" muncul
   * SESUDAH jawaban selesai dibaca, dan saat itu mata ada di bawah. Di kepala
   * ia dibaca sekali lalu tergulir pergi.
   */
  const lines = messageLines(pesan({ agent: "build" }), false).filter(
    (line) => line.kind !== "blank",
  )
  assert.equal(lines.at(-1)?.kind, "byline")
})

test("prompt user tidak dapat penanda — tidak ada agent yang mengerjakannya", () => {
  const lines = messageLines(
    pesan({ role: "user", agent: "build", parts: [{ type: "text", text: "halo" }] }),
    false,
  )
  assert.equal(
    lines.some((line) => line.kind === "byline"),
    false,
  )
})

test("pesan tanpa agent tidak menumbuhkan baris kosong", () => {
  // Riwayat lama tidak punya field ini, dan baris penanda yang isinya cuma
  // glyph akan terbaca sebagai kerusakan render.
  const lines = messageLines(pesan(), false)
  assert.equal(
    lines.some((line) => line.kind === "byline"),
    false,
  )
})

test("penanda ikut tiap jawaban, jadi gulungan panjang tetap terbaca", () => {
  /*
   * Kalau hanya jawaban terakhir yang diberi penanda, gulungan ke atas justru
   * kehilangan keterangannya persis di tempat pertanyaannya paling sering
   * muncul: jawaban lama yang sudah tidak diingat lagi dikerjakan siapa.
   */
  const lines = allLines(
    [
      pesan({ id: "a", agent: "build" }),
      pesan({ id: "b", agent: "build-auto" }),
      pesan({ id: "c", agent: "build" }),
    ],
    false,
  )
  assert.equal(lines.filter((line) => line.kind === "byline").length, 3)
})

// ---------- agent yang SEDANG berjalan ----------

test("turnAgent membaca jawaban terakhir, bukan pilihan di layar", () => {
  const hasil = turnAgent([
    pesan({ id: "a", agent: "build-auto" }),
    pesan({ id: "b", role: "user", parts: [{ type: "text", text: "lagi" }] }),
    pesan({ id: "c", agent: "build" }),
  ])
  assert.equal(hasil, "build")
})

test("prompt user di ekor tidak menutupi jawaban yang sedang berjalan", () => {
  /*
   * Urutan yang sebenarnya terjadi saat giliran dimulai: pesan user disimpan
   * lebih dulu, pesan assistant menyusul. Kalau pencariannya berhenti di pesan
   * terakhir apa pun, penandanya berkedip hilang tiap kali user mengirim.
   */
  const hasil = turnAgent([
    pesan({ id: "a", agent: "build" }),
    pesan({ id: "b", role: "user", parts: [{ type: "text", text: "lanjut" }] }),
  ])
  assert.equal(hasil, "build")
})

test("riwayat kosong tidak menghasilkan nama karangan", () => {
  assert.equal(turnAgent([]), undefined)
  assert.equal(turnAgent([pesan({ role: "user", parts: [{ type: "text", text: "hai" }] })]), undefined)
})

// ---------- animasi langkah berjalan ----------

const berjalan = (): Message =>
  pesan({
    parts: [
      {
        type: "tool",
        callID: "c1",
        tool: "bash",
        state: { status: "running", title: "bash: npm test", input: {} },
      },
    ],
  })

test("bulatan langkah berjalan berputar mengikuti detak", () => {
  const frames = new Set<string>()
  for (let i = 0; i < 16; i += 1) frames.add(runningFrame(i))

  assert.equal(frames.size, 4)
  assert.equal(runningFrame(0), runningFrame(4), "berulang setelah satu putaran")
})

test("detak negatif tetap menghasilkan bingkai yang sah", () => {
  // `%` di JavaScript mengembalikan sisa BERTANDA, jadi indeks negatif akan
  // mengambil `undefined` dari array dan glyph-nya hilang.
  assert.equal(typeof runningFrame(-1), "string")
  assert.equal(runningFrame(-4), runningFrame(0))
})

test("glyph berjalan ikut berubah di baris yang dirender", () => {
  const awal = teks(messageLines(berjalan(), false, 0, 0))
  const nanti = teks(messageLines(berjalan(), false, 0, 1))
  assert.notEqual(awal, nanti, "tanpa ini animasinya diam walau detaknya jalan")
  assert.match(awal, /npm test/)
})

test("SEMUA bingkai selebar satu kolom, jadi judulnya tidak bergeser", () => {
  /*
   * Bulatan berjalan berganti jadi `✓` saat selesai. Kalau lebarnya berbeda,
   * judul di sebelahnya melompat satu kolom di tengah gulungan — dan lompatan
   * itu lebih mengganggu daripada tidak ada animasi sama sekali.
   */
  for (let i = 0; i < 4; i += 1) {
    assert.equal([...(runningFrame(i) as string)].length, 1, `bingkai ${i}`)
  }
})

test("langkah yang SUDAH selesai tidak ikut beranimasi", () => {
  // Kalau ia ikut, seluruh riwayat berdenyut setiap detak — dan gerakan yang
  // ada di mana-mana berhenti menunjukkan apa pun.
  const selesai = pesan({
    parts: [
      {
        type: "tool",
        callID: "c1",
        tool: "bash",
        state: { status: "completed", title: "bash: npm test", input: {}, output: "ok" },
      },
    ],
  })
  assert.equal(teks(messageLines(selesai, false, 0, 0)), teks(messageLines(selesai, false, 0, 7)))
})

// ---------- yang MENGISI penandanya ----------

test("giliran sungguhan merekam agent-nya ke pesan", async () => {
  /*
   * Tanpa ini seluruh yang di atas menguji tampilan dari field yang tidak
   * pernah terisi. Dan letaknya penting: `agent` dipasang SEBELUM publish
   * pertama, jadi penandanya sudah benar sejak giliran muncul di layar — bukan
   * menyusul setelah kata pertama jawaban mengalir.
   */
  const { prompt, setModelResolver } = await import("../src/core/agent.ts")
  const { createSession, listMessages } = await import("../src/core/storage/session.ts")

  const project = path.join(root, "proyek")
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] } }),
  )

  const usage = {
    inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  }
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "selesai" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage },
  ]
  const restore = setModelResolver(
    () =>
      new MockLanguageModelV4({
        doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
      }),
  )

  try {
    const session = createSession(project)
    await prompt({ sessionID: session.id, text: "halo", agent: "build" })

    const jawaban = listMessages(session.id).filter((message) => message.role === "assistant")
    assert.equal(jawaban.at(-1)?.agent, "build")
    // Dan ia bertahan di penyimpanan, jadi gulungan ke atas setelah Titah
    // dibuka ulang tetap menyebut agent yang benar.
    assert.equal(turnAgent(listMessages(session.id)), "build")
  } finally {
    restore()
  }
})

// ---------- penghitung langkah ----------

test("toolSteps menghitung SELURUH sesi, bukan giliran terakhir", () => {
  /*
   * Kalau per giliran, setiap giliran dimulai dari kata yang sama dan "kata
   * berganti tiap tool" berhenti berarti pada rentetan giliran pendek.
   */
  const dengan = (n: number, id: string): Message =>
    pesan({
      id,
      parts: Array.from({ length: n }, (_, at) => ({
        type: "tool" as const,
        callID: `${id}-${at}`,
        tool: "bash",
        state: { status: "completed" as const, title: "bash", input: {}, output: "" },
      })),
    })

  assert.equal(toolSteps([dengan(2, "a"), dengan(3, "b")]), 5)
  assert.equal(toolSteps([]), 0)
})

test("toolSteps hanya naik, tidak pernah turun", () => {
  // Angka yang bisa turun akan memutar kata mundur, dan itu terbaca seperti
  // pekerjaan yang diulang.
  const satu = pesan({
    id: "a",
    parts: [
      { type: "tool", callID: "c1", tool: "bash", state: { status: "running", title: "x", input: {} } },
    ],
  })
  const dua = pesan({
    id: "a",
    parts: [
      { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", title: "x", input: {}, output: "" } },
      { type: "tool", callID: "c2", tool: "read", state: { status: "running", title: "y", input: {} } },
    ],
  })
  assert.ok(toolSteps([dua]) > toolSteps([satu]), "tool selesai tetap dihitung")
})
