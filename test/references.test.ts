import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-refs-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "refs.db")
process.env.HOME = path.join(root, "home")

const {
  addReference,
  removeReference,
  listReferences,
  referenceBudgetBytes,
  referencePair,
  referenceCacheBytes,
  REFERENCE_OVERHEAD_BYTES,
} = await import("../src/core/references.ts")
const { prompt } = await import("../src/core/agent.ts")
const { planTool } = await import("../src/core/tool/plan.ts")
const { createSession, appendModelMessages, saveCompaction, savePlan, readPlan, listModelMessages } =
  await import("../src/core/storage/session.ts")

after(() => fs.rmSync(root, { recursive: true, force: true }))

let counter = 0
/** Satu proyek per test — referensi dan memori tidak boleh bocor antar test. */
function project(files: Record<string, string | Buffer>): { dir: string; sessionID: string } {
  const dir = path.join(root, `proyek-${++counter}`)
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  fs.mkdirSync(dir, { recursive: true })
  return { dir, sessionID: createSession(dir).id }
}

function pairText(sessionID: string, budget = 64 * 1024): string {
  const pair = referencePair(sessionID, budget)
  const first = pair[0]
  assert.ok(first && typeof first.content === "string")
  return first.content
}

test("referensi tersimpan per sesi, urut saat ditambahkan, dan bisa dilepas", () => {
  const { dir, sessionID } = project({ "a/x.css": "a{}", "b/y.css": "b{}" })
  addReference(sessionID, path.join(dir, "b"))
  addReference(sessionID, path.join(dir, "a"))
  // Menambahkan ulang tidak menggandakan dan tidak memindah urutan.
  addReference(sessionID, path.join(dir, "b"))
  assert.deepEqual(listReferences(sessionID), [path.join(dir, "b"), path.join(dir, "a")])

  assert.equal(removeReference(sessionID, path.join(dir, "b")), true)
  assert.equal(removeReference(sessionID, path.join(dir, "b")), false)
  assert.deepEqual(listReferences(sessionID), [path.join(dir, "a")])
})

test("tanpa referensi tidak ada pasangan sama sekali", () => {
  const { sessionID } = project({})
  assert.deepEqual(referencePair(sessionID, 64 * 1024), [])
})

test("pasangan referensi diawali tepat <references> dan dijawab assistant", () => {
  // Task 7 memasang tanda cache pada pesan user yang teksnya DIAWALI
  // `<references>` — awalan lain berarti tanda itu tidak pernah terpasang.
  const { dir, sessionID } = project({ "tpl/index.html": "<h1>hai</h1>" })
  addReference(sessionID, path.join(dir, "tpl"))
  const pair = referencePair(sessionID, 64 * 1024)
  assert.equal(pair.length, 2)
  assert.equal(pair[0]?.role, "user")
  assert.ok(String(pair[0]?.content).startsWith("<references>"))
  assert.match(String(pair[0]?.content), /<h1>hai<\/h1>/)
  assert.match(
    String(pair[0]?.content),
    /These are the reference files the user pinned\. Match them exactly — structure, class names, colours, spacing\. Files listed without content did not fit: read them before writing the matching UI\.$/,
  )
  assert.deepEqual(pair[1], { role: "assistant", content: "Understood. I will follow these references." })
})

test("referensi bertahan lintas pemadatan karena tidak tinggal di model_message", () => {
  const { dir, sessionID } = project({ "tpl/style.css": ".kartu{color:red}" })
  addReference(sessionID, path.join(dir, "tpl"))
  appendModelMessages(sessionID, [
    { role: "user", content: "satu" },
    { role: "assistant", content: "dua" },
  ])
  saveCompaction(sessionID, 1, "RINGKASAN")

  const text = JSON.stringify(listModelMessages(sessionID))
  assert.match(text, /<references>/)
  assert.match(text, /\.kartu\{color:red\}/)
  assert.match(text, /RINGKASAN/)
})

test("referensi ada di permintaan sebelum ringkasan dan rencana", () => {
  // Urutan stabil→volatil: rencana ditulis ulang beberapa kali per giliran, jadi
  // referensi yang diletakkan sesudahnya ikut kehilangan cache setiap kali.
  const { dir, sessionID } = project({ "tpl/style.css": ".kartu{}" })
  addReference(sessionID, path.join(dir, "tpl"))
  appendModelMessages(sessionID, [{ role: "user", content: "satu" }])
  saveCompaction(sessionID, 1, "<context-summary>RINGKASAN</context-summary>")
  savePlan(sessionID, "- [ ] langkah")

  const text = JSON.stringify(listModelMessages(sessionID))
  const references = text.indexOf("<references>")
  const summary = text.indexOf("<context-summary>")
  const plan = text.indexOf("<plan>")
  assert.ok(references >= 0 && summary >= 0 && plan >= 0, text)
  assert.ok(references < summary, "referensi sebelum ringkasan")
  assert.ok(summary < plan, "ringkasan sebelum rencana")
})

test("berkas yang tidak muat hanya muncul di manifest", () => {
  const { dir, sessionID } = project({
    "tpl/kecil.css": ".kecil{}",
    "tpl/besar.css": `/* besar */${"b".repeat(10 * 1024)}`,
  })
  addReference(sessionID, path.join(dir, "tpl"))
  const text = pairText(sessionID, 2 * 1024)

  assert.match(text, /besar\.css/, "path tetap terdaftar di manifest")
  assert.doesNotMatch(text, /bbbbbbbbbb/, "isinya tidak ikut")
  assert.doesNotMatch(text, /<file path="[^"]*besar\.css">/)
  // Yang muat tetap dikirim: satu berkas besar tidak boleh menggugurkan sisanya.
  assert.match(text, /\.kecil\{\}/)
})

test("berkas biner dan node_modules dilewati", () => {
  const { dir, sessionID } = project({
    "tpl/style.css": ".ok{}",
    "tpl/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    "tpl/node_modules/lib/index.css": ".vendor{}",
    "tpl/.git/HEAD": "ref: refs/heads/main",
    "tpl/dist/out.css": ".built{}",
    "tpl/raksasa.css": "r".repeat(256 * 1024 + 1),
  })
  addReference(sessionID, path.join(dir, "tpl"))
  const text = pairText(sessionID, 2 * 1024 * 1024)

  assert.match(text, /\.ok\{\}/)
  assert.doesNotMatch(text, /logo\.png/)
  assert.doesNotMatch(text, /node_modules|\.vendor/)
  assert.doesNotMatch(text, /HEAD|refs\/heads/)
  assert.doesNotMatch(text, /out\.css|\.built/)
  assert.doesNotMatch(text, /raksasa\.css/)
})

test("berkas yang dirujuk index.html didahulukan", () => {
  // Anggaran hanya cukup untuk index.html dan SATU berkas lain. `a-lain.css`
  // menang kalau pengisian mengikuti abjad; `z-dipakai.css` yang dirujuk
  // index.html harus menang.
  const filler = "c".repeat(600)
  const { dir, sessionID } = project({
    "tpl/index.html": '<link rel="stylesheet" href="./z-dipakai.css?v=2"><img src="https://x.test/a.png">',
    "tpl/a-lain.css": `.lain{}${filler}`,
    "tpl/z-dipakai.css": `.dipakai{}${filler}`,
  })
  addReference(sessionID, path.join(dir, "tpl"))
  const text = pairText(sessionID, 1000)

  assert.match(text, /<file path="[^"]*index\.html">/)
  assert.match(text, /\.dipakai\{\}/)
  assert.doesNotMatch(text, /\.lain\{\}/)
  assert.match(text, /a-lain\.css/, "yang kalah tetap ada di manifest")
})

test("isi yang berubah di disk terbaca pada permintaan berikutnya", () => {
  const { dir, sessionID } = project({ "tpl/style.css": ".lama{}" })
  addReference(sessionID, path.join(dir, "tpl"))
  assert.match(pairText(sessionID), /\.lama\{\}/)

  // Ukuran sengaja berbeda DAN mtime dimajukan: cache dikunci pada keduanya,
  // dan sistem berkas dengan resolusi mtime kasar tidak boleh membuat test ini
  // bergantung pada salah satunya saja.
  const file = path.join(dir, "tpl/style.css")
  fs.writeFileSync(file, ".baru-dan-lebih-panjang{}")
  const later = new Date(Date.now() + 10_000)
  fs.utimesSync(file, later, later)

  const text = pairText(sessionID)
  assert.match(text, /\.baru-dan-lebih-panjang\{\}/)
  assert.doesNotMatch(text, /\.lama\{\}/)
})

test("anggaran referensi adalah seperempat ambang pemadatan dalam token", () => {
  assert.equal(referenceBudgetBytes(131072), 32768 * 4)
  assert.equal(referenceBudgetBytes(undefined), 64 * 1024)
})

test("folder referensi yang raksasa tidak meluapkan permintaan: manifest ikut anggaran", () => {
  // Pasangan ini tinggal di awalan terlindung yang tidak bisa dipadatkan. Dulu
  // hanya ISI yang ditagihkan ke anggaran; 600 berkas kecil menghasilkan
  // manifest yang tumbuh tanpa batas di setiap permintaan.
  const files: Record<string, string> = {}
  for (let i = 0; i < 600; i++) files[`tpl/bagian-${String(i).padStart(4, "0")}.css`] = `.b${i}{}${"k".repeat(80)}`
  const { dir, sessionID } = project(files)
  addReference(sessionID, path.join(dir, "tpl"))

  const before = referenceCacheBytes()
  const budget = 2 * 1024
  const text = pairText(sessionID, budget)

  assert.ok(
    Buffer.byteLength(text, "utf8") <= budget + REFERENCE_OVERHEAD_BYTES,
    `${Buffer.byteLength(text, "utf8")} > ${budget} + ${REFERENCE_OVERHEAD_BYTES}`,
  )
  assert.match(text, /… and \d+ more files not listed/)
  // Positif: anggaran tetap dipakai, bukan dihindari dengan mengirim kosong.
  assert.match(text, /bagian-0000\.css/)
  // Berkas yang tidak dikirim tidak dibaca: cache hanya tumbuh sebesar yang muat.
  assert.ok(referenceCacheBytes() - before <= budget, "isi berkas yang tidak dikirim tidak boleh dibaca")
})

test("dua permintaan atas folder yang tidak berubah menghasilkan pasangan yang identik", () => {
  // Cache provider dikunci pada awalan yang identik byte demi byte. Penelusuran
  // yang tidak diurutkan (urutan readdir bergantung sistem berkas) atau isi yang
  // bergantung waktu membuat awalan ini tidak pernah kena cache.
  const { dir, sessionID } = project({
    "tpl/index.html": '<link href="b.css">',
    "tpl/b.css": ".b{}",
    "tpl/a.css": ".a{}",
    "tpl/sub/c.html": "<p>c</p>",
  })
  addReference(sessionID, path.join(dir, "tpl"))
  assert.deepEqual(referencePair(sessionID, 64 * 1024), referencePair(sessionID, 64 * 1024))
})

async function reply(sessionID: string, text: string): Promise<{ text: string; error: string | undefined }> {
  const assistant = await prompt({ sessionID, text })
  const part = assistant.parts.find((p) => p.type === "text")
  return { text: part?.type === "text" ? part.text : "", error: assistant.error }
}

test("/pin menyimpan path dan /pin tanpa argumen menampilkan daftarnya", async () => {
  const { dir, sessionID } = project({ "tpl/index.html": "<h1>hai</h1>", "satu.css": "a{}" })

  const empty = await reply(sessionID, "/pin")
  assert.equal(empty.error, undefined)
  assert.match(empty.text, /No pinned references/)

  // Relatif terhadap direktori sesi, disimpan ABSOLUT.
  const pinned = await reply(sessionID, "/pin tpl")
  assert.equal(pinned.error, undefined)
  await reply(sessionID, "/pin satu.css")
  assert.deepEqual(listReferences(sessionID), [path.join(dir, "tpl"), path.join(dir, "satu.css")])

  const listed = await reply(sessionID, "/pin")
  assert.match(listed.text, new RegExp(path.join(dir, "tpl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(listed.text, /satu\.css/)
})

test("/unpin menghapus path", async () => {
  const { dir, sessionID } = project({ "tpl/index.html": "x" })
  addReference(sessionID, path.join(dir, "tpl"))

  const done = await reply(sessionID, "/unpin tpl")
  assert.equal(done.error, undefined)
  assert.deepEqual(listReferences(sessionID), [])

  // Yang tidak pernah disematkan dilaporkan, bukan diam-diam dianggap berhasil.
  const again = await reply(sessionID, "/unpin tpl")
  assert.ok(again.error)
  assert.match(again.text, /not pinned/)
})

test("/pin path yang tidak ada ditolak dengan pesan yang menyebut path-nya", async () => {
  const { sessionID } = project({})
  const result = await reply(sessionID, "/pin tidak-ada/folder")
  assert.ok(result.error)
  assert.match(result.text, /tidak-ada\/folder/)
  assert.deepEqual(listReferences(sessionID), [])
})

test("/pin di luar proyek ditolak dan menyebut external_directory", async () => {
  const { sessionID } = project({})
  const luar = path.join(root, "luar")
  fs.mkdirSync(luar, { recursive: true })
  const result = await reply(sessionID, `/pin ${luar}`)
  assert.ok(result.error)
  assert.match(result.text, /external_directory/)
  assert.deepEqual(listReferences(sessionID), [])
})

test("/unpin tanpa argumen memberi petunjuk penggunaan", async () => {
  const { sessionID } = project({})
  const result = await reply(sessionID, "/unpin")
  assert.match(result.error ?? "", /Usage/)
})

const planCtx = (dir: string, sessionID: string) =>
  ({
    cwd: dir,
    sessionID,
    callID: "call_1",
    signal: new AbortController().signal,
    config: {} as never,
  }) as never

test("plan dengan references menyimpan referensi tanpa mengganti rencana menjadi kosong", async () => {
  const { dir, sessionID } = project({ "tpl/index.html": "x" })
  savePlan(sessionID, "- [ ] bangun halaman")

  // `text` opsional: hanya references berarti rencananya tidak disentuh.
  await planTool.execute({ references: ["tpl"] }, planCtx(dir, sessionID))

  assert.deepEqual(listReferences(sessionID), [path.join(dir, "tpl")])
  assert.equal(readPlan(sessionID)?.text, "- [ ] bangun halaman")
})

test("plan dengan text dan references mengganti rencana dan menyematkan keduanya", async () => {
  const { dir, sessionID } = project({ "a.css": "a{}" })
  await planTool.execute({ text: "- [ ] satu", references: ["a.css"] }, planCtx(dir, sessionID))
  assert.equal(readPlan(sessionID)?.text, "- [ ] satu")
  assert.deepEqual(listReferences(sessionID), [path.join(dir, "a.css")])
})

test("plan menolak references di luar proyek dan tidak menyematkan satu pun", async () => {
  const { dir, sessionID } = project({ "ok.css": "a{}" })
  await assert.rejects(
    planTool.execute({ references: ["ok.css", "../../etc"] }, planCtx(dir, sessionID)),
    /external_directory/,
  )
  // Semua atau tidak sama sekali: sebagian tersemat membuat model mengira semuanya tersemat.
  assert.deepEqual(listReferences(sessionID), [])
})

test("plan tanpa text maupun references ditolak, bukan dianggap menghapus rencana", async () => {
  const { dir, sessionID } = project({})
  savePlan(sessionID, "- [ ] jangan hilang")
  await assert.rejects(planTool.execute({}, planCtx(dir, sessionID)), /text|references/)
  assert.equal(readPlan(sessionID)?.text, "- [ ] jangan hilang")
})
