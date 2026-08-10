import assert from "node:assert/strict"
import test from "node:test"
import { dispatchableAgents, isReader, withWriteLock } from "../src/core/subagent.ts"
import { Config } from "../src/core/schema.ts"

const agent = (permission: Record<string, string>) =>
  Config.parse({ agent: { a: { mode: "subagent", permission } } }).agent["a"]!

test("pembaca adalah agent yang edit, write, DAN bash-nya deny", () => {
  assert.equal(isReader(agent({ edit: "deny", write: "deny", bash: "deny" })), true)
})

test("bash ikut dihitung — shell bisa menulis berkas juga", () => {
  // `bash` yang diizinkan bisa menjalankan `sed -i`. Menghitungnya sebagai
  // pembaca berarti dua agent bisa menulis bersamaan lewat pintu belakang,
  // tepat yang dicegah oleh serialisasi penulis.
  assert.equal(isReader(agent({ edit: "deny", write: "deny", bash: "ask" })), false)
})

test("izin yang tidak disebut BUKAN deny", () => {
  // Tanpa permission apa pun, agent mewarisi kebijakan global — yang defaultnya
  // "ask", bukan "deny". Menganggapnya pembaca akan melepaskan penulis ke jalur
  // paralel tanpa satu pun deklarasi.
  assert.equal(isReader(agent({})), false)
})

test("penulis diserialkan: yang kedua tidak mulai sebelum yang pertama selesai", async () => {
  const order: string[] = []
  const gate = Promise.withResolvers<void>()

  const first = withWriteLock("/proyek", async () => {
    order.push("mulai-1")
    await gate.promise
    order.push("selesai-1")
  })
  const second = withWriteLock("/proyek", async () => {
    order.push("mulai-2")
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ["mulai-1"], "yang kedua BELUM boleh mulai")

  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ["mulai-1", "selesai-1", "mulai-2"])
})

test("penulis yang gagal tidak mengunci antrean selamanya", async () => {
  // Kalau kegagalan menahan kunci, satu sub-agent yang error membuat setiap
  // penulis berikutnya menggantung tanpa penjelasan sampai sesi ditutup.
  const failed = withWriteLock("/proyek", async () => {
    throw new Error("meledak")
  })
  await assert.rejects(failed, /meledak/)

  const after = await withWriteLock("/proyek", async () => "lolos")
  assert.equal(after, "lolos")
})

test("direktori berbeda tidak saling mengunci", async () => {
  // Kuncinya per direktori kerja karena repo bayangan snapshot memang dikunci
  // di situ — bukan batas yang dikarang.
  const order: string[] = []
  const gate = Promise.withResolvers<void>()

  const a = withWriteLock("/proyek/a", async () => {
    order.push("a")
    await gate.promise
  })
  await withWriteLock("/proyek/b", async () => {
    order.push("b")
  })

  assert.deepEqual(order, ["a", "b"], "b tidak menunggu a")
  gate.resolve()
  await a
})

test("hanya agent ber-mode subagent atau all yang bisa didispatch", () => {
  const config = Config.parse({
    agent: {
      explore: { mode: "subagent" },
      build: { mode: "primary" },
      hybrid: { mode: "all" },
    },
  })
  assert.deepEqual(dispatchableAgents(config).sort(), ["explore", "hybrid"])
})
