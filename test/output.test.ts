import assert from "node:assert/strict"
import test from "node:test"
import {
  applySchema,
  checkSchema,
  isOutputFormat,
  OUTPUT_FORMATS,
  parseStructured,
  schemaInstruction,
  streamLine,
  turnResult,
} from "../src/core/output.ts"
import type { Message } from "../src/core/message.ts"

/**
 * Keluaran yang bisa dibaca mesin.
 *
 * `titah run` hanya pernah mengalirkan teks: cukup untuk dibaca orang, dan sama
 * sekali tidak cukup untuk pipeline, CI, atau alat yang memakai Titah sebagai
 * bagiannya. Semua yang dibutuhkan pemanggil — berhasil atau tidak, tool apa
 * yang jalan, berapa token, berhenti karena selesai atau kehabisan anggaran —
 * hanya ada sebagai teks berwarna di antara jawaban.
 */

const message = (extra: Partial<Message> = {}): Message => ({
  id: "m1",
  sessionID: "ses_1",
  role: "assistant",
  created: 0,
  parts: [{ type: "text", text: "jawabannya empat" }],
  ...extra,
})

// ---------- bentuknya ----------

test("tiga format, dan yang lain ditolak", () => {
  assert.deepEqual(OUTPUT_FORMATS, ["text", "json", "stream-json"])
  assert.equal(isOutputFormat("json"), true)
  assert.equal(isOutputFormat("yaml"), false)
})

test("hasil memuat yang dibutuhkan skrip, bukan yang enak dibaca mata", () => {
  const result = turnResult(
    "ses_1",
    message({ agent: "build", model: "9router/ant", usage: { input: 100, output: 20, context: 80 } }),
    [],
  )

  assert.equal(result.session, "ses_1")
  assert.equal(result.ok, true)
  assert.equal(result.agent, "build")
  assert.equal(result.model, "9router/ant")
  assert.equal(result.text, "jawabannya empat")
  assert.deepEqual(result.usage, { input: 100, output: 20, context: 80 })
})

test("penalaran TIDAK ikut ke `text`", () => {
  /*
   * `text` adalah jawaban, penalaran adalah jalan menuju jawaban. Skrip yang
   * memakai keduanya sebagai satu string akan memproses catatan kerja model
   * sebagai hasil.
   */
  const result = turnResult(
    "ses_1",
    message({
      parts: [
        { type: "reasoning", text: "hmm, mungkin empat" },
        { type: "text", text: "empat" },
      ],
    }),
    [],
  )
  assert.equal(result.text, "empat")
})

test("tool dilaporkan dengan status DAN outcome — keduanya menjawab hal berbeda", () => {
  /*
   * `task` yang seluruh tool sub-agentnya ditolak tetap `completed`: gilirannya
   * memang selesai tanpa melempar. Skrip yang membaca status saja akan
   * menyangkanya berhasil.
   */
  const result = turnResult(
    "ses_1",
    message({
      parts: [
        {
          type: "tool",
          callID: "c1",
          tool: "task",
          state: { status: "completed", title: "task explore", input: {}, output: "", outcome: "failed" },
        },
      ],
    }),
    [],
  )

  assert.equal(result.tools[0]?.status, "completed")
  assert.equal(result.tools[0]?.outcome, "failed")
})

test("notice ikut — di situlah `berhenti karena anggaran` sampai ke pemanggil", () => {
  /*
   * Tanpa ini, satu-satunya perbedaan antara giliran yang selesai dan giliran
   * yang dipotong adalah panjang teksnya, dan tidak ada skrip yang bisa
   * menilai itu.
   */
  const result = turnResult("ses_1", message(), ["Stopped at this turn's token budget — 400,000"])
  assert.equal(result.notices.length, 1)
  assert.match(result.notices[0] ?? "", /token budget/)
})

test("giliran yang gagal menandai dirinya, bukan cuma menaruh pesan", () => {
  const result = turnResult("ses_1", message({ error: "Cancelled by user." }), [])
  assert.equal(result.ok, false)
  assert.equal(result.error, "Cancelled by user.")
})

test("tanpa hasil sama sekali tetap menghasilkan objek yang sah", () => {
  // Pemanggil harus selalu bisa `JSON.parse` lalu membaca `ok` — termasuk saat
  // yang terjadi adalah kegagalan paling dalam.
  const result = turnResult("ses_1", undefined, [])
  assert.equal(result.ok, false)
  assert.equal(result.session, "ses_1")
  assert.ok(result.error)
})

test("stream-json adalah Event apa adanya, satu per baris", () => {
  /*
   * Sengaja BUKAN format baru. Format kedua berarti dua bentuk yang harus
   * dijaga tetap sama, dan yang kedua selalu tertinggal begitu event baru
   * ditambahkan.
   */
  const line = streamLine({ type: "session.idle", sessionID: "ses_1" })
  assert.equal(line.endsWith("\n"), true)
  assert.deepEqual(JSON.parse(line), { type: "session.idle", sessionID: "ses_1" })
  assert.equal(line.split("\n").length, 2, "tepat satu baris")
})

// ---------- --json-schema ----------

test("pagar kode dilucuti — model kerap membungkus JSON-nya", () => {
  /*
   * Menolak ```json … ``` sebagai "bukan JSON" akan benar secara harfiah dan
   * tidak berguna bagi siapa pun.
   */
  assert.deepEqual(parseStructured('```json\n{"a":1}\n```').value, { a: 1 })
  assert.deepEqual(parseStructured('```\n{"a":1}\n```').value, { a: 1 })
  assert.deepEqual(parseStructured('  {"a":1}  ').value, { a: 1 })
})

test("bukan JSON dilaporkan sebagai kegagalan yang menyebut sebabnya", () => {
  const hasil = parseStructured("maaf, saya tidak bisa")
  assert.equal(hasil.value, undefined)
  assert.match(hasil.error ?? "", /not valid JSON/)
})

test("jawaban kosong bukan JSON kosong", () => {
  assert.match(parseStructured("   ").error ?? "", /empty answer/)
})

test("instruksi bentuk memuat skemanya, dan melarang prosa", () => {
  const text = schemaInstruction({ type: "object" })
  assert.match(text, /Answer with JSON only/)
  assert.match(text, /"type": "object"/)
})

// ---------- pemeriksa skema ----------

const SCHEMA = {
  type: "object",
  required: ["name", "count"],
  properties: {
    name: { type: "string" },
    count: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    level: { enum: ["low", "high"] },
  },
}

test("bentuk yang cocok lolos", () => {
  assert.equal(checkSchema({ name: "a", count: 2, tags: ["x"], level: "low" }, SCHEMA), undefined)
})

test("properti wajib yang hilang disebut NAMANYA", () => {
  // Pesan "tidak cocok" tanpa menyebut apa yang tidak cocok memaksa pemanggil
  // membandingkan sendiri, dan itu pekerjaan yang seharusnya sudah dilakukan.
  assert.match(checkSchema({ name: "a" }, SCHEMA) ?? "", /missing required property "count"/)
})

test("tipe yang salah menyebut jalurnya", () => {
  assert.match(checkSchema({ name: 1, count: 2 }, SCHEMA) ?? "", /\$\.name: expected string/)
})

test("integer bukan sekadar number", () => {
  assert.match(checkSchema({ name: "a", count: 1.5 }, SCHEMA) ?? "", /expected integer/)
  assert.equal(checkSchema({ name: "a", count: 3 }, SCHEMA), undefined)
})

test("array diperiksa per elemen, dengan indeksnya", () => {
  const failure = checkSchema({ name: "a", count: 1, tags: ["x", 2] }, SCHEMA)
  assert.match(failure ?? "", /\$\.tags\[1\]: expected string/)
})

test("enum menolak nilai di luar daftarnya", () => {
  assert.match(checkSchema({ name: "a", count: 1, level: "mid" }, SCHEMA) ?? "", /expected one of/)
})

test("null dibedakan dari object", () => {
  // `typeof null === "object"` di JavaScript, dan pemeriksa yang lupa itu
  // meluluskan null untuk setiap skema bertipe object.
  assert.match(checkSchema(null, { type: "object" }) ?? "", /expected object, got null/)
  assert.equal(checkSchema(null, { type: "null" }), undefined)
})

test("array dibedakan dari object", () => {
  assert.match(checkSchema([], { type: "object" }) ?? "", /expected object, got array/)
})

test("kata kunci yang TIDAK didukung dilewati, bukan dianggap gagal", () => {
  /*
   * Ini subset JSON Schema, dan batasnya dinyatakan alih-alih disamarkan.
   * Validator yang menolak apa pun yang tidak ia pahami akan menolak skema yang
   * sah — kegagalan yang lebih membingungkan daripada tidak memeriksa.
   */
  const exotic = { type: "object", patternProperties: { "^x": { type: "string" } }, minProperties: 5 }
  assert.equal(checkSchema({ a: 1 }, exotic), undefined)
})

// ---------- kode keluar ----------

const ok = (text: string) => turnResult("ses_1", message({ parts: [{ type: "text", text }] }), [])

test("0 = selesai; 1 = gilirannya gagal; 2 = bentuknya tidak cocok", () => {
  /*
   * Dua dan satu dipisah karena penanganannya berbeda: 1 biasanya berarti coba
   * lagi, 2 berarti prompt atau skemanya yang perlu diperbaiki — dan
   * mengulanginya apa adanya akan gagal dengan cara yang sama.
   */
  assert.equal(applySchema(ok('{"a":1}'), undefined).exit, 0)
  assert.equal(applySchema(ok('{"a":1}'), { type: "object" }).exit, 0)

  const gagal = turnResult("ses_1", message({ error: "boom" }), [])
  assert.equal(applySchema(gagal, undefined).exit, 1)

  assert.equal(applySchema(ok("bukan json"), { type: "object" }).exit, 2)
})

test("bentuk yang tidak cocok MENURUNKAN ok, bukan cuma menaikkan kode keluar", () => {
  // Pemanggil yang membaca `ok` dari JSON-nya dan pemanggil yang membaca kode
  // keluar harus sampai pada kesimpulan yang sama.
  const { result } = applySchema(ok('{"a":1}'), { type: "object", required: ["b"] })
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /missing required property "b"/)
})

test("giliran yang GAGAL tidak diperiksa skemanya", () => {
  /*
   * Jawabannya kosong atau setengah jadi; melaporkan "bentuknya salah" di atas
   * giliran yang memang gagal akan menyembunyikan sebab yang sesungguhnya.
   */
  const gagal = turnResult("ses_1", message({ error: "Cancelled by user." }), [])
  const { result, exit } = applySchema(gagal, { type: "object", required: ["b"] })
  assert.equal(exit, 1)
  assert.equal(result.error, "Cancelled by user.")
})

test("hasil terurai masuk ke `output`, dan `text` tetap ada", () => {
  // Skrip mengambil `output`; manusia yang men-debug membaca `text` yang
  // membuatnya. Menimpanya berarti membuang bukti saat bentuknya salah.
  const { result } = applySchema(ok('{"a":1}'), { type: "object" })
  assert.deepEqual(result.output, { a: 1 })
  assert.equal(result.text, '{"a":1}')
})
