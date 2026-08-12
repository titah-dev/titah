import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before } from "node:test"
import { bus } from "../src/core/event.ts"
import {
  answerQuestion,
  askUser,
  cancelQuestion,
  listPendingQuestions,
  NoOneToAsk,
} from "../src/core/question.ts"
import { Config } from "../src/core/schema.ts"
import { memoryTool } from "../src/core/tool/memory.ts"
import { questionTool, setQuestionAsker } from "../src/core/tool/question.ts"
import { ToolError } from "../src/core/tool/types.ts"

process.env["TITAH_DB"] = ":memory:"

let session: typeof import("../src/core/storage/session.ts")
before(async () => {
  session = await import("../src/core/storage/session.ts")
})

const project = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "titah-mag-"))

const ctx = (cwd: string, sessionID = "ses_mag") =>
  ({
    cwd,
    sessionID,
    callID: "call_1",
    signal: new AbortController().signal,
    config: Config.parse({}),
  }) as never

// ================= MAG =================

test("memori dikunci PROYEK, bukan sesi — itu seluruh bedanya dari plan", () => {
  const a = project()
  const b = project()
  session.rememberFact(a, "suite ini butuh Node 22")

  assert.equal(session.listMemories(a).length, 1)
  assert.equal(session.listMemories(b).length, 0, "proyek lain tidak ikut kebagian")
})

test("memori bertahan meski sesinya sudah lain", () => {
  // Inti MAG: `plan` mati bersama sesinya, ini tidak. Dua sesi berbeda di
  // direktori yang sama harus melihat fakta yang sama.
  const dir = project()
  const satu = session.createSession(dir)
  const dua = session.createSession(dir)
  session.rememberFact(dir, "router codex-nya kedaluwarsa")

  const dilihatSatu = session.listModelMessages(satu.id).map((m) => String(m.content)).join()
  const dilihatDua = session.listModelMessages(dua.id).map((m) => String(m.content)).join()
  assert.match(dilihatSatu, /router codex-nya kedaluwarsa/)
  assert.match(dilihatDua, /router codex-nya kedaluwarsa/)
})

test("recall OTOMATIS — tidak ada tool untuk membacanya kembali", async () => {
  // Store yang harus diingat untuk dibaca adalah store yang menjawab pertanyaan
  // yang salah: lupa membacanya persis kegagalan yang mau dihindari.
  const dir = project()
  const ses = session.createSession(dir)
  await memoryTool.execute({ action: "remember", text: "pakai pnpm, bukan npm" }, ctx(dir, ses.id))

  const seen = session.listModelMessages(ses.id).map((m) => String(m.content)).join("\n")
  assert.match(seen, /<project-memory>/)
  assert.match(seen, /pakai pnpm, bukan npm/)
})

test("memori datang SEBELUM ringkasan dan rencana — urutan cache, bukan selera", () => {
  // Diurutkan dari yang paling jarang berubah ke yang paling sering. Menukar
  // memori dan rencana membuat setiap penulisan rencana ikut membatalkan cache
  // memori, dan tidak ada yang menyadarinya selain tagihan.
  const dir = project()
  const ses = session.createSession(dir)
  session.rememberFact(dir, "FAKTA")
  session.savePlan(ses.id, "RENCANA")
  session.appendModelMessages(ses.id, [{ role: "user", content: "EKOR" }])
  const rows = session.listModelRows(ses.id)
  session.saveCompaction(ses.id, rows[rows.length - 1]?.seq as number, "RINGKASAN")

  const text = session.listModelMessages(ses.id).map((m) => String(m.content)).join("\n")
  assert.ok(text.indexOf("FAKTA") < text.indexOf("RINGKASAN"), "memori sebelum ringkasan")
  assert.ok(text.indexOf("RINGKASAN") < text.indexOf("RENCANA"), "ringkasan sebelum rencana")
})

test("blok terlindungi dan ekor terbelah tepat di batas stabil/volatil", () => {
  const dir = project()
  const ses = session.createSession(dir)
  session.rememberFact(dir, "FAKTA")
  session.appendModelMessages(ses.id, [{ role: "user", content: "EKOR" }])

  const split = session.splitModelRequest(ses.id)
  assert.equal(split.protectedBlock.length, 2, "memori sebagai pasangan")
  assert.deepEqual(split.tail.map((m) => String(m.content)), ["EKOR"])
  // Gabungannya HARUS identik dengan yang dikirim — kalau tidak, yang diukur
  // bukan yang dikirim.
  assert.deepEqual([...split.protectedBlock, ...split.tail], session.listModelMessages(ses.id))
})

test("batas memori DITOLAK, bukan menggeser yang paling lama", async () => {
  // Memori yang diam-diam menggeser isinya sendiri tidak bisa dipercaya, dan
  // yang hilang justru fakta paling awal — biasanya yang paling mendasar.
  const dir = project()
  for (let i = 0; i < session.MAX_MEMORIES; i += 1) session.rememberFact(dir, `fakta ${i}`)

  await assert.rejects(
    () => memoryTool.execute({ action: "remember", text: "satu lagi" }, ctx(dir)),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /maximum/)
      assert.match(error.message, /Forget one/)
      return true
    },
  )
  assert.equal(session.listMemories(dir).length, session.MAX_MEMORIES)
  assert.equal(session.listMemories(dir)[0]?.text, "fakta 0", "yang pertama harus tetap ada")
})

test("forget menghapus, dan id yang tidak dikenal memberi pesan", async () => {
  const dir = project()
  const fact = session.rememberFact(dir, "sementara")
  await memoryTool.execute({ action: "forget", id: fact.id }, ctx(dir))
  assert.equal(session.listMemories(dir).length, 0)

  await assert.rejects(() => memoryTool.execute({ action: "forget", id: "mem_x" }, ctx(dir)), ToolError)
})

test("memory tidak meminta izin — ia tidak membelanjakan apa pun milik user", () => {
  assert.equal(memoryTool.permission, undefined)
})

// ================= question =================

test("askUser menerbitkan event lalu MENUNGGU jawaban", async () => {
  // `bus.subscribe` mengembalikan async-iterable, bukan pendaftaran callback.
  // Versi pertama test ini memakai bentuk callback yang tidak ada — dan karena
  // iterable yang tidak pernah di-iterate memang tidak melakukan apa-apa, ia
  // gagal dengan daftar kosong alih-alih dengan error yang menunjuk kesalahannya.
  const stop = new AbortController()
  const stream = bus.subscribe({ sessionID: "ses_q1", signal: stop.signal })
  const received: string[] = []
  const reader = (async () => {
    for await (const event of stream) {
      if (event.type === "question.request") received.push(event.request.question)
    }
  })()

  const pending = askUser({
    sessionID: "ses_q1",
    question: "berkas mana?",
    options: ["a.ts", "b.ts"],
    listeners: 1,
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(received, ["berkas mana?"])
  const [outstanding] = listPendingQuestions("ses_q1")
  assert.ok(outstanding)
  assert.deepEqual(outstanding.options, ["a.ts", "b.ts"])

  assert.equal(answerQuestion(outstanding.id, "b.ts"), true)
  assert.equal(await pending, "b.ts")
  assert.deepEqual(listPendingQuestions("ses_q1"), [], "tidak boleh meninggalkan yang menggantung")

  stop.abort()
  await reader
})

test("tanpa klien, askUser MELEMPAR — tidak menggantung selamanya", () => {
  // Aturan yang sama dengan izin, dan alasannya sama: menggantung di CI lebih
  // buruk daripada gagal cepat.
  assert.throws(
    () => askUser({ sessionID: "ses_q2", question: "x", options: [], listeners: 0 }),
    NoOneToAsk,
  )
})

test("tool menerjemahkan 'tidak ada yang bisa ditanya' jadi LANJUTKAN, bukan gagal", async () => {
  // Kalau ini diperlakukan sebagai error, mode headless mati total begitu model
  // memutuskan untuk bertanya.
  setQuestionAsker(async () => undefined)
  const result = await questionTool.execute({ question: "x", options: [] }, ctx("/tmp"))

  assert.match(result.output, /best assumption/)
  assert.match(result.output, /say plainly/, "harus menuntut asumsinya disebutkan")
  assert.equal((result.metadata as { answered: boolean }).answered, false)
})

test("jawaban kosong diperlakukan sama dengan tidak menjawab", async () => {
  setQuestionAsker(async () => "   ")
  const result = await questionTool.execute({ question: "x", options: [] }, ctx("/tmp"))
  assert.equal((result.metadata as { answered: boolean }).answered, false)
})

test("jawaban sungguhan sampai ke model apa adanya", async () => {
  setQuestionAsker(async () => "pakai yang kedua")
  const result = await questionTool.execute({ question: "x", options: [] }, ctx("/tmp"))
  assert.match(result.output, /pakai yang kedua/)
  assert.equal((result.metadata as { answered: boolean }).answered, true)
})

test("dibatalkan mengembalikan undefined, bukan melempar", async () => {
  const controller = new AbortController()
  const pending = askUser({
    sessionID: "ses_q3",
    question: "x",
    options: [],
    listeners: 1,
    signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  assert.equal(await pending, undefined)
})

test("cancelQuestion melepaskan yang menggantung", async () => {
  const pending = askUser({ sessionID: "ses_q4", question: "x", options: [], listeners: 1 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const [outstanding] = listPendingQuestions("ses_q4")
  assert.equal(cancelQuestion(outstanding!.id), true)
  assert.equal(await pending, undefined)
  assert.equal(cancelQuestion(outstanding!.id), false, "yang kedua kali tidak menemukan apa-apa")
})

test("question tidak memakai sumbu izin apa pun", () => {
  // Ongkosnya perhatian user, bukan berkas atau jaringan — dan itu dijaga oleh
  // deskripsi tool plus fakta bahwa jawabannya harus ditunggu.
  assert.equal(questionTool.permission, undefined)
})
