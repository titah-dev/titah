import assert from "node:assert/strict"
import test, { before } from "node:test"
import type { ModelMessage } from "ai"

process.env["TITAH_DB"] = ":memory:"

const {
  appendModelMessages,
  createSession,
  latestCompaction,
  listModelMessages,
  listModelRows,
  saveCompaction,
} = await import("../src/core/storage/session.ts")
const { planCompaction, wrapSummary } = await import("../src/core/compact.ts")

const user = (text: string): ModelMessage => ({ role: "user", content: text })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text })

let sessionID = ""

before(() => {
  sessionID = createSession(process.cwd(), "uji pemadatan").id
})

test("tanpa pemadatan, riwayat dikirim apa adanya", () => {
  appendModelMessages(sessionID, [user("satu"), assistant("jawab satu")])
  assert.equal(listModelMessages(sessionID).length, 2)
  assert.equal(latestCompaction(sessionID), undefined)
})

test("pemadatan mengganti pesan lama dengan ringkasan, ekor tetap utuh", () => {
  appendModelMessages(sessionID, [
    user("dua"),
    assistant("jawab dua"),
    user("tiga"),
    assistant("jawab tiga"),
  ])

  const plan = planCompaction(listModelRows(sessionID), 2)
  saveCompaction(sessionID, plan.watermark, wrapSummary("Goal: menguji pemadatan"))

  const view = listModelMessages(sessionID)

  // Ringkasan datang berpasangan user+assistant supaya peran tetap berselang-
  // seling; ekor selalu diawali pesan user, dan dua user berturut-turut ditolak
  // sebagian provider.
  assert.equal(view[0]?.role, "user")
  assert.match(String(view[0]?.content), /context-summary/)
  assert.equal(view[1]?.role, "assistant")

  assert.equal(view.length, 2 + plan.kept)
  assert.equal(String(view.at(-1)?.content), "jawab tiga", "pertukaran terakhir apa adanya")
  assert.ok(!view.some((m) => String(m.content) === "satu"), "pesan awal tidak dikirim lagi")
})

test("giliran baru setelah pemadatan menumpuk di atas ringkasan, bukan menghidupkan yang lama", () => {
  appendModelMessages(sessionID, [user("empat"), assistant("jawab empat")])
  const view = listModelMessages(sessionID)

  assert.match(String(view[0]?.content), /context-summary/)
  assert.equal(String(view.at(-1)?.content), "jawab empat")
  assert.ok(!view.some((m) => String(m.content) === "satu"))
})

test("pemadatan kedua hanya meringkas yang BELUM diringkas", () => {
  const previous = latestCompaction(sessionID)
  assert.ok(previous)

  const belum = listModelRows(sessionID).filter((row) => row.seq > previous.seq)
  const plan = planCompaction(belum, 2)

  // Yang sudah di bawah batas air tidak boleh ikut terbawa lagi; kalau ikut,
  // ringkasan tumbuh tiap kali dipadatkan — persis masalah yang mau dipecahkan.
  assert.ok(!plan.dropped.some((m) => String(m.content) === "satu"))
  assert.ok(plan.watermark > previous.seq || plan.dropped.length === 0)
})

test("baris asli TIDAK dihapus — pemadatan bisa diperiksa setelahnya", () => {
  const raw = listModelRows(sessionID).map((row) => String(row.message.content))
  assert.ok(raw.includes("satu"), "transkrip mentah tetap ada di disk")
})
