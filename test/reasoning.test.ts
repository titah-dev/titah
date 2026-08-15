import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * Penalaran model: ditangkap, ditampilkan, dan — ternyata — ikut dikirim balik.
 *
 * Yang terakhir itu kebalikan dari yang diperkirakan saat merancang perubahan
 * ini, dan test di bawahlah yang membetulkannya. Perkiraannya: penalaran hidup
 * di `message.parts` sementara permintaan dibangun dari tabel `model_message`
 * yang terpisah, jadi ia tidak mungkin menyentuh permintaan. Kenyataannya
 * `model_message` diisi dari `step.response.messages` milik AI SDK, dan SDK
 * memang menaruh penalaran di sana — dengan sengaja, karena Anthropic menuntut
 * blok thinking dikembalikan utuh.
 *
 * Ditulis di sini karena sifat semacam ini tidak terbaca dari satu berkas mana
 * pun: ia hasil dari tiga lapis yang masing-masing masuk akal sendiri-sendiri.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-rz-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "rz.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listMessages, listModelMessages } = await import(
  "../src/core/storage/session.ts"
)

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] } }),
  )
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

/** Satu giliran: model berpikir dulu, lalu menjawab. */
function thinkThenAnswer(thinking: string[], answer: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r0" },
    ...thinking.map((delta) => ({ type: "reasoning-delta" as const, id: "r0", delta })),
    { type: "reasoning-end", id: "r0" },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: answer },
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

function mock(steps: LanguageModelV4StreamPart[][]): void {
  let index = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = steps[Math.min(index, steps.length - 1)] as LanguageModelV4StreamPart[]
      index += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)
}

test("penalaran ditangkap sebagai part tersendiri, bukan disambung ke jawaban", async () => {
  /*
   * Digabung ke `text`, riwayat berhenti bisa menjawab "apa yang sebenarnya ia
   * katakan" — dan itu satu-satunya pertanyaan yang riwayat memang ada untuk
   * menjawabnya.
   */
  mock([thinkThenAnswer(["Saya perlu ", "membaca berkasnya dulu."], "Sudah selesai.")])
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "kerjakan" })

  const reasoning = assistant.parts.find((part) => part.type === "reasoning")
  const text = assistant.parts.find((part) => part.type === "text")

  assert.equal(reasoning?.type === "reasoning" && reasoning.text, "Saya perlu membaca berkasnya dulu.")
  assert.equal(text?.type === "text" && text.text, "Sudah selesai.")
})

test("penalaran IKUT dikirim balik — dan itu memang harus", async () => {
  /*
   * Rencana awal perubahan ini menebak sebaliknya: bahwa penalaran hidup di
   * `message.parts` dan tidak bisa menyentuh permintaan, karena permintaan
   * dibangun dari tabel `model_message` yang terpisah. Test ini ditulis untuk
   * memaku tebakan itu, dan langsung menjatuhkannya — `model_message` diisi
   * dari `step.response.messages` milik AI SDK, dan SDK memang menaruh
   * penalaran di sana.
   *
   * Ternyata itu benar, bukan bocor. Provider Anthropic mengirim blok thinking
   * kembali beserta `signature`-nya (`sendReasoning` di @ai-sdk/anthropic), dan
   * Anthropic MENOLAK giliran berikutnya kalau blok itu hilang pada percakapan
   * yang memakai extended thinking bersama tool. Membuangnya demi menghemat
   * token akan menukar biaya dengan giliran yang gagal.
   *
   * Konsekuensinya jujur: penalaran satu giliran ikut dibayar lagi sebagai
   * token masukan di giliran berikutnya. Itu berlaku sama untuk setiap agent
   * yang memakai model dengan thinking, dan bukan sesuatu yang bisa
   * dihilangkan sepihak dari sisi klien.
   */
  mock([thinkThenAnswer(["PENALARAN yang panjang sekali"], "Jawaban.")])
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan" })

  const dikirim = JSON.stringify(listModelMessages(session.id))
  assert.match(dikirim, /PENALARAN yang panjang sekali/, "blok thinking harus utuh")
  assert.match(dikirim, /Jawaban\./)
})

test("yang ditampilkan dan yang dikirim adalah dua salinan yang terpisah", async () => {
  /*
   * Keduanya kebetulan berisi teks yang sama sekarang, tapi jalurnya berbeda:
   * yang tampil datang dari `reasoning-delta` yang ditangkap Titah, yang
   * dikirim datang dari `step.response.messages` milik SDK. Menyandarkan
   * tampilan pada tabel model berarti tampilan ikut berubah setiap kali SDK
   * mengubah bentuk pesannya.
   */
  mock([thinkThenAnswer(["dipikirkan"], "dijawab")])
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "kerjakan" })

  const tampil = assistant.parts.find((part) => part.type === "reasoning")
  assert.equal(tampil?.type === "reasoning" && tampil.text, "dipikirkan")
  assert.match(JSON.stringify(listModelMessages(session.id)), /dipikirkan/)
})

test("penalaran tersimpan, jadi riwayat sama sebelum dan sesudah dimuat ulang", async () => {
  // Riwayat yang berbeda setelah restart lebih membingungkan daripada DB yang
  // sedikit lebih besar.
  mock([thinkThenAnswer(["dipikirkan"], "dijawab")])
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan" })

  const dimuat = listMessages(session.id).at(-1)
  const reasoning = dimuat?.parts.find((part) => part.type === "reasoning")
  assert.equal(reasoning?.type === "reasoning" && reasoning.text, "dipikirkan")
})

test("model TANPA penalaran berperilaku persis seperti sebelumnya", async () => {
  /*
   * Sebagian besar model tidak mengirim reasoning sama sekali. Fitur ini tidak
   * boleh menambahkan apa pun — bukan part kosong, bukan baris kosong — pada
   * mereka.
   */
  mock([
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "cuma jawaban" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ],
  ])
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "halo" })

  assert.equal(
    assistant.parts.some((part) => part.type === "reasoning"),
    false,
  )
  assert.equal(assistant.parts.length, 1)
})

test("penalaran kosong tidak membuat part", async () => {
  // Sebagian provider mengirim delta kosong sebagai denyut. Membuat part
  // untuknya berarti blok "thinking (0 lines)" yang tidak menyampaikan apa pun.
  mock([thinkThenAnswer(["", ""], "jawaban")])
  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "halo" })

  assert.equal(
    assistant.parts.some((part) => part.type === "reasoning"),
    false,
  )
})
