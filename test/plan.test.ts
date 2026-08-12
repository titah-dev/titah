import type { ModelMessage } from "ai"
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { MAX_PLAN_BYTES, planBudgetBytes, planTool } from "../src/core/tool/plan.ts"
import { ToolError } from "../src/core/tool/types.ts"

/**
 * Issue #5. Yang diuji di sini bukan "ada daftar todo", melainkan satu-satunya
 * hal yang membuat tool ini ada: rencananya SELAMAT dari pemadatan.
 *
 * Karena itu test terpenting di berkas ini adalah yang memadatkan sungguhan
 * lalu memeriksa rencananya masih terkirim — bukan yang memanggil savePlan lalu
 * readPlan, yang cuma membuktikan SQLite bekerja.
 */

process.env["TITAH_DB"] = ":memory:"

let session: typeof import("../src/core/storage/session.ts")

before(async () => {
  session = await import("../src/core/storage/session.ts")
})

const newSession = (): string => session.createSession("/tmp/plan-test").id

const ctx = (sessionID: string, contextWindow?: number) =>
  ({
    cwd: "/tmp",
    sessionID,
    callID: "call_1",
    signal: new AbortController().signal,
    config: {} as never,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }) as never

test("rencana ditulis, dibaca kembali, dan diganti seluruhnya", async () => {
  const id = newSession()

  await planTool.execute({ text: "1. baca\n2. tulis" }, ctx(id))
  assert.equal(session.readPlan(id)?.text, "1. baca\n2. tulis")

  // Ganti seluruhnya, bukan tambah.
  await planTool.execute({ text: "1. selesai" }, ctx(id))
  assert.equal(session.readPlan(id)?.text, "1. selesai")
})

test("teks kosong menghapus rencananya, bukan menyimpan string kosong", async () => {
  const id = newSession()
  await planTool.execute({ text: "ada isinya" }, ctx(id))
  await planTool.execute({ text: "   " }, ctx(id))

  // Barisnya hilang, bukan jadi "". Tanpa ini, "tidak punya rencana" dan
  // "punya rencana kosong" jadi dua keadaan yang harus dibedakan tiap pembaca.
  assert.equal(session.readPlan(id), undefined)
  assert.deepEqual(session.planPair(id), [])
})

test("rencana masuk ke riwayat yang dilihat model, sebagai pasangan user+assistant", () => {
  const id = newSession()
  session.savePlan(id, "1. satu\n2. dua")

  const messages = session.listModelMessages(id)
  assert.equal(messages.length, 2, "pasangan, bukan satu pesan")
  assert.equal(messages[0]?.role, "user")
  assert.equal(messages[1]?.role, "assistant")
  assert.match(String(messages[0]?.content), /<plan>/)
  assert.match(String(messages[0]?.content), /1\. satu/)
})

test("pasangan itu perlu, supaya ekor tidak menghasilkan dua pesan user berturut-turut", () => {
  const id = newSession()
  session.savePlan(id, "rencana")
  session.appendModelMessages(id, [{ role: "user", content: "halo" }])

  const roles = session.listModelMessages(id).map((message) => message.role)
  assert.deepEqual(roles, ["user", "assistant", "user"])
})

test("RENCANA SELAMAT DARI PEMADATAN — inti issue #5", () => {
  const id = newSession()
  session.savePlan(id, "1. langkah yang tidak boleh hilang")
  session.appendModelMessages(id, [
    { role: "user", content: "kerjakan sesuatu yang panjang" },
    { role: "assistant", content: "baik" },
    { role: "user", content: "lanjut" },
  ])

  const rows = session.listModelRows(id)
  const last = rows[rows.length - 1]?.seq as number
  // Memadatkan SELURUH riwayat: setelah ini tidak ada satu pun pesan asli yang
  // tersisa di ekor.
  session.saveCompaction(id, last, "<context-summary>semuanya sudah diringkas</context-summary>")

  const messages = session.listModelMessages(id)
  const text = messages.map((message) => String(message.content)).join("\n")

  assert.match(text, /semuanya sudah diringkas/, "ringkasan harus ada")
  assert.match(text, /langkah yang tidak boleh hilang/, "rencana harus SELAMAT")
  // Urutannya: ringkasan dulu (latar), baru rencana (niat terhadap latar itu).
  assert.ok(
    text.indexOf("sudah diringkas") < text.indexOf("langkah yang tidak boleh hilang"),
    "rencana datang sesudah ringkasan",
  )
})

test("sesi anak tidak mewarisi rencana induknya", () => {
  const induk = newSession()
  const anak = newSession()
  session.savePlan(induk, "rencana induk")

  assert.equal(session.readPlan(anak), undefined)
  assert.deepEqual(session.planPair(anak), [])
  // Dan menulis rencana anak tidak menyentuh milik induk.
  session.savePlan(anak, "rencana anak")
  assert.equal(session.readPlan(induk)?.text, "rencana induk")
})

test("rencana yang melewati batas DITOLAK, bukan dipotong diam-diam", async () => {
  const id = newSession()
  const tooBig = "x".repeat(MAX_PLAN_BYTES + 1)

  await assert.rejects(
    () => planTool.execute({ text: tooBig }, ctx(id)),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /over the \d+-byte limit/)
      return true
    },
  )
  // Yang penting: tidak ada apa pun yang tersimpan setengah jadi.
  assert.equal(session.readPlan(id), undefined)
})

test("batasnya mengecil mengikuti jendela model kecil", () => {
  // Tanpa jendela yang dideklarasikan, hanya batas mutlak yang berlaku.
  assert.equal(planBudgetBytes(undefined), MAX_PLAN_BYTES)

  // Jendela besar: batas mutlak tetap yang menggigit.
  assert.equal(planBudgetBytes(1_000_000), MAX_PLAN_BYTES)

  // Jendela 8k adalah setelan ollama yang umum, dan di situlah 4 KB terlalu
  // besar — sama persis dengan tabrakan yang sudah dialami `reserved`.
  const small = planBudgetBytes(8192)
  assert.ok(small < MAX_PLAN_BYTES, `batas jendela 8k harus di bawah ${MAX_PLAN_BYTES}, dapat ${small}`)
  assert.equal(small, 2048)
})

test("penolakan pada model kecil menyebut jendelanya, supaya user tahu kenapa", async () => {
  const id = newSession()
  const overSmall = "y".repeat(3000) // di bawah batas mutlak, di atas batas jendela 8k

  await assert.rejects(
    () => planTool.execute({ text: overSmall }, ctx(id, 8192)),
    (error: unknown) => {
      assert.match((error as Error).message, /8192-token window/)
      return true
    },
  )

  // Teks yang sama diterima pada model berjendela besar — batasnya memang
  // relatif, bukan angka yang berlaku di mana-mana.
  await planTool.execute({ text: overSmall }, ctx(id, 1_000_000))
  assert.equal(session.readPlan(id)?.text.length, 3000)
})

test("rencana bertahan lintas giliran sampai model sendiri mengubahnya", async () => {
  const id = newSession()
  await planTool.execute({ text: "1. a\n2. b" }, ctx(id))

  session.appendModelMessages(id, [{ role: "user", content: "giliran berikutnya" }])
  assert.match(String(session.listModelMessages(id)[0]?.content), /1\. a/)

  await planTool.execute({ text: "" }, ctx(id))
  assert.equal(session.readPlan(id), undefined)
})

test("plan tidak meminta izin dan tidak menandai dirinya mutates", () => {
  // Menulis rencana tidak menyentuh filesystem maupun shell. Sumbu izin yang
  // belum ada semuanya tentang membelanjakan sesuatu milik user; yang ini
  // tidak membelanjakan apa pun — dan karena bukan berkas, `/undo` juga tidak
  // perlu snapshot untuknya.
  assert.equal(planTool.permission, undefined)
  assert.notEqual(planTool.mutates, true)
})

test("bentuk permintaan punya SATU definisi, dipakai yang mengirim dan yang mengukur", () => {
  // Regresi yang muncul saat #5 digabung di atas #10, dan test sebelumnya di
  // berkas ini TIDAK menangkapnya: `measure` di auto-compact merakit ulang
  // permintaan sendiri, jadi rencana masuk ke yang dikirim dan luput dari yang
  // diukur. Persis kelas cacat yang measure() ada untuk menutupnya.
  //
  // Diperbaiki dengan menghapus salinannya, bukan dengan menambah test yang
  // mengejarnya: `requestShape` sekarang satu-satunya tempat bentuk ini ditulis,
  // dan auto-compact.ts memanggilnya. Jadi yang perlu dipaku tinggal bentuknya.
  const plan: ModelMessage[] = [
    { role: "user", content: "RENCANA" },
    { role: "assistant", content: "ok" },
  ]
  const tail: ModelMessage[] = [{ role: "user", content: "EKOR" }]

  const withSummary = session.requestShape("RINGKASAN", plan, tail).map((m) => String(m.content))
  assert.deepEqual(withSummary, ["RINGKASAN", "Understood. I will continue from that summary.", "RENCANA", "ok", "EKOR"])

  // Tanpa ringkasan, rencana tetap berangkat — ia berdiri sendiri.
  const withoutSummary = session.requestShape(undefined, plan, tail).map((m) => String(m.content))
  assert.deepEqual(withoutSummary, ["RENCANA", "ok", "EKOR"])

  // Dan inilah yang mengikat keduanya: apa yang dikirim listModelMessages untuk
  // sesi bersungguhan harus identik dengan requestShape atas bahan yang sama.
  const id = newSession()
  session.savePlan(id, "satu langkah")
  session.appendModelMessages(id, [{ role: "user", content: "halo" }])
  assert.deepEqual(
    session.listModelMessages(id),
    session.requestShape(undefined, session.planPair(id), [{ role: "user", content: "halo" }]),
  )
})
