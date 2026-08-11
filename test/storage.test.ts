import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before, after } from "node:test"

// Harus di-set SEBELUM modul storage dimuat: database() menyimpan koneksinya.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-store-"))
process.env.XDG_DATA_HOME = root
process.env.TITAH_DB = path.join(root, "test.db")

const { storeOutput, readOutput, INLINE_LIMIT } = await import("../src/core/storage/blob.ts")
const {
  appendModelMessages,
  createChildSession,
  createMessage,
  createSession,
  deleteSession,
  getSession,
  listChildSessions,
  listMessages,
  listModelMessages,
  listModelRows,
  listSessions,
  isEmptySession,
  discardIfEmpty,
  pruneEmptySessions,
  pruneSessions,
  replaceModelMessage,
  saveMessage,
  touchSession,
} = await import("../src/core/storage/session.ts")
const { database } = await import("../src/core/storage/db.ts")

before(() => {
  database()
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test("sesi bisa dibuat, dibaca, dan diurutkan dari yang terbaru", () => {
  const a = createSession("/proyek/a", "pertama")
  const b = createSession("/proyek/b", "kedua")
  createMessage(a.id, "user", [{ type: "text", text: "halo" }])
  createMessage(b.id, "user", [{ type: "text", text: "halo" }])

  assert.equal(getSession(a.id)?.directory, "/proyek/a")
  const ids = listSessions().map((session) => session.id)
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
})

test("sesi tanpa percakapan tidak pernah didaftar", () => {
  // TUI membuat sesi saat DIJALANKAN, bukan saat prompt pertama. Tanpa
  // penyaringan ini, tiap `titah` yang dibuka lalu ditutup menambah satu entri
  // "(untitled)" ke daftar `/session` yang tidak bisa dilanjutkan sama sekali.
  const kosong = createSession("/proyek/kosong", "belum dipakai")

  assert.equal(isEmptySession(kosong.id), true)
  assert.ok(!listSessions().some((session) => session.id === kosong.id))
  assert.ok(getSession(kosong.id), "masih bisa dibuka lewat id-nya")
})

test("discardIfEmpty menolak membuang sesi yang ada isinya", () => {
  // Pemanggilnya membuang sesi yang ia KIRA tidak terpakai. Satu salah hitung
  // tidak boleh berujung hilangnya percakapan sungguhan.
  const berisi = createSession("/proyek/berisi")
  createMessage(berisi.id, "user", [{ type: "text", text: "jangan hilang" }])

  assert.equal(discardIfEmpty(berisi.id), false)
  assert.ok(getSession(berisi.id))

  const kosong = createSession("/proyek/dibuang")
  assert.equal(discardIfEmpty(kosong.id), true)
  assert.equal(getSession(kosong.id), undefined)
})

test("sapuan sesi kosong menghormati ambang usia", () => {
  // Sesi kosong yang BARU dibuat kemungkinan besar sedang dibuka klien lain
  // yang belum mengetik. Menghapusnya membuat prompt pertamanya gagal.
  const baru = createSession("/proyek/baru")
  assert.equal(pruneEmptySessions(60 * 60 * 1000).sessions, 0)
  assert.ok(getSession(baru.id), "yang baru dibuat tidak disentuh")

  assert.ok(pruneEmptySessions(0).sessions >= 1)
  assert.equal(getSession(baru.id), undefined)
})

test("getSession mengembalikan undefined untuk id yang tidak ada", () => {
  assert.equal(getSession("ses_tidak-ada"), undefined)
})

test("pesan tersimpan dengan urutan yang stabil", () => {
  const session = createSession("/proyek/urut")
  createMessage(session.id, "user", [{ type: "text", text: "halo" }])
  createMessage(session.id, "assistant", [{ type: "text", text: "hai" }])
  createMessage(session.id, "user", [{ type: "text", text: "lagi" }])

  const messages = listMessages(session.id)
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user"],
  )
  assert.equal(messages[2]?.parts[0]?.type === "text" && messages[2].parts[0].text, "lagi")
})

test("saveMessage menimpa isi pesan yang sama, bukan menambah baris", () => {
  const session = createSession("/proyek/simpan")
  const message = createMessage(session.id, "assistant", [])
  message.parts.push({ type: "text", text: "hasil akhir" })
  message.usage = { input: 10, output: 20 }
  saveMessage(message)

  const messages = listMessages(session.id)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.usage?.output, 20)
})

test("riwayat format AI SDK disimpan terpisah dan urut", () => {
  const session = createSession("/proyek/model")
  appendModelMessages(session.id, [
    { role: "user", content: "satu" },
    { role: "assistant", content: "dua" },
  ])
  appendModelMessages(session.id, [{ role: "user", content: "tiga" }])

  const history = listModelMessages(session.id)
  assert.equal(history.length, 3)
  assert.equal(history[2]?.content, "tiga")
})

test("menghapus sesi ikut menghapus pesannya (foreign key ON DELETE CASCADE)", () => {
  const session = createSession("/proyek/hapus")
  createMessage(session.id, "user", [{ type: "text", text: "halo" }])
  appendModelMessages(session.id, [{ role: "user", content: "halo" }])

  assert.equal(deleteSession(session.id), true)
  assert.deepEqual(listMessages(session.id), [])
  assert.deepEqual(listModelMessages(session.id), [])
})

test("prune hanya menghapus sesi yang lebih tua dari batas", () => {
  const lama = createSession("/proyek/lama")
  const baru = createSession("/proyek/baru")

  // Mundurkan `updated` sesi lama 40 hari.
  database()
    .prepare("UPDATE session SET updated = ? WHERE id = ?")
    .run(Date.now() - 40 * 86_400_000, lama.id)

  const result = pruneSessions(30 * 86_400_000)
  assert.ok(result.sessions >= 1)
  assert.equal(getSession(lama.id), undefined)
  assert.ok(getSession(baru.id), "sesi baru tidak boleh ikut terhapus")
})

test("touchSession memperbarui waktu dan judul", () => {
  const session = createSession("/proyek/judul")
  const updated = touchSession(session.id, { title: "judul baru" })
  assert.equal(updated?.title, "judul baru")
  assert.ok((updated?.updated ?? 0) >= session.updated)
})

test("output kecil tetap inline, tanpa file tambahan", () => {
  const stored = storeOutput("kecil", "halo dunia")
  assert.equal(stored.output, "halo dunia")
  assert.equal(stored.truncated, false)
  assert.equal(stored.outputRef, undefined)
})

test("output besar dipotong dan isi penuhnya masuk filesystem, bukan DB", () => {
  const besar = "x".repeat(INLINE_LIMIT + 5000)
  const stored = storeOutput("besar", besar)

  assert.equal(stored.truncated, true)
  assert.ok(stored.output.length < besar.length, "yang masuk konteks harus lebih pendek")
  assert.match(stored.output, /truncated/)
  assert.ok(stored.outputRef)
  assert.equal(readOutput(stored.outputRef as string), besar, "isi penuh harus utuh di disk")
})

test("readOutput mengembalikan undefined untuk ref yang hilang", () => {
  assert.equal(readOutput(path.join(root, "tidak-ada.txt")), undefined)
})

test("sesi disaring per folder, bukan dicampur seluruh mesin", () => {
  const a = createSession("/proyek/alfa")
  const b = createSession("/proyek/beta")
  createMessage(a.id, "user", [{ type: "text", text: "halo alfa" }])
  createMessage(b.id, "user", [{ type: "text", text: "halo beta" }])

  const alfa = listSessions(50, "/proyek/alfa").map((session) => session.id)
  assert.ok(alfa.includes(a.id))
  assert.ok(!alfa.includes(b.id), "proyek lain tidak boleh ikut")

  // Tanpa argumen tetap seluruh mesin: retensi HARUS melihat semuanya, kalau
  // tidak, snapshot proyek lain akan tersapu karena dikira sudah tak bersesi.
  const semua = listSessions(50).map((session) => session.id)
  assert.ok(semua.includes(a.id) && semua.includes(b.id))
})

test("path dibakukan, jadi garis miring di ujung bukan proyek yang berbeda", () => {
  // Kalau tidak, user kehilangan seluruh riwayatnya hanya karena mengetik "/".
  const session = createSession("/proyek/gamma")
  createMessage(session.id, "user", [{ type: "text", text: "halo" }])

  for (const varian of ["/proyek/gamma", "/proyek/gamma/", "/proyek/gamma/."]) {
    assert.ok(
      listSessions(50, varian).some((entry) => entry.id === session.id),
      `varian ${varian} harus menemukan sesi yang sama`,
    )
  }
})

test("path relatif dibakukan terhadap direktori kerja", () => {
  const session = createSession(process.cwd())
  createMessage(session.id, "user", [{ type: "text", text: "halo" }])

  assert.equal(session.directory, process.cwd(), "disimpan sudah mutlak")
  assert.ok(listSessions(50, ".").some((entry) => entry.id === session.id))
})

test("sesi anak tertaut ke induknya dan TIDAK muncul di daftar", () => {
  // Daftar /session adalah "percakapan yang bisa kamu lanjutkan". Sesi anak
  // bukan salah satunya — ia milik satu giliran, dan menampilkannya membuat
  // daftar itu penuh entri yang tidak berarti apa-apa bagi user.
  const parent = createSession("/proyek/x", "induk")
  createMessage(parent.id, "user", [{ type: "text", text: "halo" }])

  const child = createChildSession(parent.id, "/proyek/x", "explore")
  createMessage(child.id, "user", [{ type: "text", text: "telusuri" }])

  const listed = listSessions(50, "/proyek/x").map((s) => s.id)
  assert.ok(listed.includes(parent.id))
  assert.ok(!listed.includes(child.id), "anak tidak pernah didaftar")

  // Branch TANPA directory dipakai `titah sessions list --all` — kalau
  // filternya cuma dicopy ke satu cabang, anak muncul lagi di sini.
  const listedSemua = listSessions(50).map((s) => s.id)
  assert.ok(!listedSemua.includes(child.id), "anak juga tidak boleh muncul tanpa filter direktori")

  assert.deepEqual(
    listChildSessions(parent.id).map((s) => s.id),
    [child.id],
  )
})

test("anak tetap bisa dibuka lewat getSession selagi induknya masih hidup", () => {
  // Panel sub-agent dan `task` membuka anak lewat id-nya secara langsung —
  // kalau getSession ikut menyaring parent_id IS NULL, anak jadi TAK
  // TERJANGKAU bahkan selagi masih berjalan, bukan cuma "tidak terdaftar".
  const parent = createSession("/proyek/reachable")
  const child = createChildSession(parent.id, "/proyek/reachable", "explore")

  const found = getSession(child.id)
  assert.ok(found, "anak harus tetap terjangkau lewat id-nya")
  assert.equal(found?.id, child.id)
  assert.equal(found?.parentID, parent.id)

  // Bukan cuma parentID yang benar — objeknya juga tidak boleh membawa
  // kolom mentah `parent_id`. Kalau mapper diam-diam kembali ke spread,
  // itu bocor ke luar lewat GET /session/:id yang men-JSON.stringify apa
  // adanya tanpa allow-list field.
  assert.ok(!Object.hasOwn(found as object, "parent_id"), "tidak boleh ada kolom mentah di objek")
  assert.deepEqual(
    Object.keys(found as object).sort(),
    ["created", "directory", "id", "parentID", "title", "updated"],
  )
})

test("anak mewarisi direktori kerja induknya", () => {
  const parent = createSession("/proyek/y")
  const child = createChildSession(parent.id, "/proyek/y", "qc")
  assert.equal(child.directory, parent.directory)
})

test("menghapus induk ikut menghapus anaknya", () => {
  // ON DELETE CASCADE: sesi anak tanpa induk tidak punya arti apa pun, dan
  // membiarkannya berarti prune tidak pernah membersihkannya.
  const parent = createSession("/proyek/z")
  createMessage(parent.id, "user", [{ type: "text", text: "a" }])
  const child = createChildSession(parent.id, "/proyek/z", "explore")

  deleteSession(parent.id)
  assert.equal(getSession(child.id), undefined)
})

test("replaceModelMessage menimpa satu baris tanpa menyentuh urutannya", () => {
  const session = createSession("/proyek/ganti")
  appendModelMessages(session.id, [
    { role: "user", content: "satu" },
    { role: "assistant", content: "dua" },
  ])

  // Sesi lain, dibuat dengan urutan yang sama persis (seq mulai dari 0 lagi —
  // nextSeq dihitung PER sesi). Kalau WHERE clause lupa menyaring session_id,
  // UPDATE ini akan menimpa baris sesi ini juga karena seq-nya kebetulan cocok,
  // dan korupsi lintas-sesi seperti itu tidak akan terlihat sama sekali —
  // pruner akan memanggil ini berulang kali di dalam loop.
  const other = createSession("/proyek/ganti-lain")
  appendModelMessages(other.id, [
    { role: "user", content: "punya sesi lain" },
    { role: "assistant", content: "jangan disentuh" },
  ])

  const rows = listModelRows(session.id)
  const target = rows[1]
  assert.ok(target)

  replaceModelMessage(session.id, target.seq, { role: "assistant", content: "diganti" })

  const after = listModelRows(session.id)
  assert.equal(after.length, 2)
  assert.deepEqual(
    after.map((row) => row.seq),
    rows.map((row) => row.seq),
  )
  assert.equal(after[1]?.message.content, "diganti")
  assert.equal(after[0]?.message.content, "satu")

  const otherAfter = listModelRows(other.id)
  assert.deepEqual(
    otherAfter.map((row) => row.message.content),
    ["punya sesi lain", "jangan disentuh"],
  )
})

test("subfolder BUKAN proyek yang sama — aturannya cocok persis", () => {
  // Disengaja: aturan "persis" mudah diprediksi. Kalau nanti terasa mengganggu,
  // yang benar adalah mencocokkan akar repo, bukan mencocokkan awalan path —
  // awalan membuat /proyek/alfa2 ikut terbawa oleh /proyek/alfa.
  const induk = createSession("/proyek/delta")
  const anak = createSession("/proyek/delta/src")
  createMessage(induk.id, "user", [{ type: "text", text: "a" }])
  createMessage(anak.id, "user", [{ type: "text", text: "b" }])

  const hasil = listSessions(50, "/proyek/delta").map((entry) => entry.id)
  assert.ok(hasil.includes(induk.id))
  assert.ok(!hasil.includes(anak.id))
})
