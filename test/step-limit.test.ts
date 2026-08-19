import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * Giliran yang berhenti karena kehabisan langkah harus MENGATAKANNYA.
 *
 * Diukur dari 68 giliran nyata di database sesi: sebarannya meluruh mulus dari
 * 1 sampai 16 langkah, lalu menumpuk sembilan giliran di 19–20. Itu tembok,
 * bukan sebaran alami — 13% giliran berhenti bukan karena selesai.
 *
 * Dan tidak ada satu pun tanda. Empat di antaranya berakhir seperti ini:
 *
 *   …**Step 12: Run tests**Missing import. Fix:
 *   …Set secret key dulu:
 *
 * Terpotong di tengah kalimat, tepat sebelum tool berikutnya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-step-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "step.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession } = await import("../src/core/storage/session.ts")
const { bus } = await import("../src/core/event.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi\n")
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow", delete: "allow" },
      agent: { pendek: { mode: "primary", steps: 3 } },
    }),
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

/**
 * Model yang TIDAK PERNAH berhenti memanggil tool.
 *
 * Satu-satunya cara menguji batasnya: model yang berhenti sendiri tidak pernah
 * menyentuhnya, dan itulah yang dilakukan 59 dari 68 giliran nyata.
 *
 * Instruksi tiap langkah direkam supaya bisa diperiksa APA yang diterima model
 * pada langkah terakhir — bukan hanya bahwa toolnya hilang.
 */
function neverStops(): { instructions: (string | undefined)[]; calls: number } {
  const seen: { instructions: (string | undefined)[]; calls: number } = {
    instructions: [],
    calls: 0,
  }

  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      seen.calls += 1
      const system = options.prompt.find((message) => message.role === "system")
      seen.instructions.push(
        typeof system?.content === "string" ? system.content : undefined,
      )

      const hasTools = (options.tools ?? []).length > 0
      const chunks: LanguageModelV4StreamPart[] = hasTools
        ? [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `c${seen.calls}`,
              toolName: "read",
              input: JSON.stringify({ path: "a.txt" }),
            },
            { type: "finish", finishReason: "tool-calls", usage: USAGE },
          ]
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "berhenti di batas" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ]

      return { stream: simulateReadableStream({ chunks }) }
    },
  })

  restore?.()
  restore = setModelResolver(() => model)
  return seen
}

/**
 * `await`-nya WAJIB.
 *
 * `bus.subscribe` mengembalikan async generator, dan generator tidak mulai
 * mendengarkan sampai iterasinya benar-benar berjalan. Tanpa satu putaran event
 * loop di sini, `prompt()` sudah menerbitkan noticenya sebelum ada yang
 * mendengar — dan testnya gagal dengan cara yang menuduh kode, padahal yang
 * salah adalah testnya sendiri.
 */
async function collectNotices(
  sessionID: string,
): Promise<{ messages: string[]; stop: () => void }> {
  const controller = new AbortController()
  const messages: string[] = []
  const stream = bus.subscribe({ sessionID, signal: controller.signal })
  void (async () => {
    for await (const event of stream) {
      if (event.type === "session.notice") messages.push(event.message)
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { messages, stop: () => controller.abort() }
}

test("model diberi tahu bahwa ini langkah terakhir", async () => {
  /*
   * Mencabut tool saja sudah memaksanya menjawab teks — itu perilaku lama, dan
   * niatnya benar. Yang salah: model tidak tahu KENAPA toolnya hilang, jadi ia
   * menulis apa pun yang ada di ujung kalimatnya.
   */
  const seen = neverStops()
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(seen.calls, 3, "agent ini dibatasi 3 langkah")

  const terakhir = seen.instructions.at(-1) ?? ""
  assert.match(terakhir, /last step/)
  assert.match(terakhir, /what you actually completed/)
  assert.match(terakhir, /the exact next step/)
})

test("langkah SEBELUM yang terakhir tidak menerima kabar itu", () => {
  // Kalau ia muncul di setiap langkah, model bekerja sepanjang giliran seolah
  // waktunya habis — dan itu menghasilkan pekerjaan tergesa dari langkah satu.
  const seen = neverStops()
  const session = createSession(project)

  return prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" }).then(() => {
    assert.doesNotMatch(seen.instructions[0] ?? "", /last step/)
    assert.doesNotMatch(seen.instructions[1] ?? "", /last step/)
  })
})

test("kabarnya menyuruh JUJUR, bukan menyuruh cepat selesai", () => {
  /*
   * "Selesaikan sekarang" mustahil dipenuhi dan hanya menghasilkan klaim palsu
   * — bentuk kegagalan yang paling mahal, karena tidak bisa dibedakan dari
   * keberhasilan.
   */
  const seen = neverStops()
  const session = createSession(project)

  return prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" }).then(() => {
    const terakhir = seen.instructions.at(-1) ?? ""
    assert.match(terakhir, /Do not pretend the work is finished/)
  })
})

test("user DIBERI TAHU bahwa gilirannya berhenti di batas", async () => {
  neverStops()
  const session = createSession(project)
  const seen = await collectNotices(session.id)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })
  // Satu putaran event loop lagi sebelum berhenti mendengar: `publish` menaruh
  // eventnya di antrean, dan `abort()` yang menyusul terlalu cepat memutus
  // generatornya sebelum antrean itu sempat dikuras.
  await new Promise((resolve) => setTimeout(resolve, 20))
  seen.stop()

  const batas = seen.messages.filter((message) => message.includes("step limit"))
  assert.equal(batas.length, 1)
  assert.match(batas[0] ?? "", /may not be/, "menyebut bahwa pekerjaannya bisa jadi belum selesai")
  assert.match(batas[0] ?? "", /agent\.pendek\.steps/, "dan menyebut cara menaikkannya")
})

test("giliran yang selesai WAJAR tidak diberi kabar apa pun", async () => {
  /*
   * 59 dari 68 giliran nyata berhenti sendiri jauh sebelum batas. Kabar yang
   * ikut muncul di sana akan membuat kabar ini berhenti berarti.
   */
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "selesai" },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
  restore?.()
  restore = setModelResolver(
    () =>
      new MockLanguageModelV4({
        doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
      }),
  )

  const session = createSession(project)
  const seen = await collectNotices(session.id)
  await prompt({ sessionID: session.id, text: "halo", agent: "pendek" })
  seen.stop()

  assert.deepEqual(seen.messages.filter((message) => message.includes("step limit")), [])
})

// ---------- anggaran token ----------

/**
 * Config dengan anggaran token, TANPA `steps` per-agent.
 *
 * Keduanya sengaja tidak dipasang bersamaan di sini: yang diuji justru bahwa
 * anggaran token sendirian sudah cukup menghentikan giliran, dan bahwa plafon
 * langkah minggir begitu ada batas yang benar.
 */
function withBudget(turnTokens: number): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow", delete: "allow" },
      limits: { turnTokens },
    }),
  )
}

test("anggaran token menghentikan giliran, bukan hitungan langkah", async () => {
  /*
   * Tiap langkah palsu memakai 10 token (5 in + 5 out). Anggaran 25 berarti
   * giliran berhenti sekitar langkah ketiga — jauh sebelum plafon langkah mana
   * pun, yang memang intinya.
   */
  withBudget(25)
  const seen = neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })

  assert.ok(seen.calls >= 3 && seen.calls <= 5, `berhenti di ${seen.calls} langkah`)
  assert.ok(seen.calls < 20, "dan jauh sebelum MAX_STEPS")
})

test("model tetap diberi tahu saat yang habis anggarannya", async () => {
  /*
   * `stopWhen` baru menilai SESUDAH sebuah langkah selesai. Kalau anggaran
   * ditunggu sampai benar-benar terlampaui, `prepareStep` tidak pernah dipanggil
   * lagi dan gilirannya berakhir terpotong — persis kegagalan yang blok A
   * perbaiki untuk jalur langkah.
   */
  withBudget(25)
  const seen = neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })
  assert.match(seen.instructions.at(-1) ?? "", /last step/)
})

test("kabarnya menyebut tombol yang BENAR", async () => {
  /*
   * Batas langkah dan anggaran bisa tercapai di langkah yang sama, dan yang
   * perlu diperbaiki user berbeda. Menyuruh menaikkan `steps` padahal yang habis
   * tokennya adalah kabar yang memutar tombol salah — lebih buruk daripada
   * tidak ada kabar.
   */
  withBudget(25)
  neverStops()
  const session = createSession(project)
  const seen = await collectNotices(session.id)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  seen.stop()

  const kabar = seen.messages.find((message) => message.includes("token budget")) ?? ""
  assert.match(kabar, /limits\.turnTokens/)
  assert.doesNotMatch(kabar, /step limit/, "tidak menyuruh menaikkan steps")
  assert.match(kabar, /of 25 spent/, "menyebut berapa yang terpakai dari berapa")
})

test("tanpa anggaran, perilakunya persis seperti sebelumnya", async () => {
  /*
   * `limits.turnTokens` tidak punya nilai bawaan, dan ini yang menjaganya:
   * angka bawaan apa pun akan menghentikan pekerjaan seseorang di tengah jalan
   * karena tebakan kita tentang harga model dan kantongnya.
   */
  const seen = neverStops()
  const session = createSession(project)
  const kabar = await collectNotices(session.id)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  kabar.stop()

  assert.equal(seen.calls, 3, "batas langkah agent yang berlaku")
  assert.deepEqual(kabar.messages.filter((m) => m.includes("token budget")), [])
})

test("`steps` per-agent MENANG atas plafon yang dinaikkan anggaran", async () => {
  /*
   * Kalau tidak, menyetel anggaran token diam-diam membuang batas langkah yang
   * sengaja dipasang seseorang untuk satu agent.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      limits: { turnTokens: 1_000_000 },
      agent: { pendek: { mode: "primary", steps: 3 } },
    }),
  )
  const seen = neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })
  assert.equal(seen.calls, 3, "anggaran besar tidak boleh membatalkan steps: 3")
})

// ---------- anggaran bawaan, diturunkan dari jendela ----------

test("anggaran BAWAAN diturunkan dari contextWindow, bukan ditebak", async () => {
  /*
   * Sumbu ini lahir tanpa bawaan karena Titah tidak tahu harga model dan
   * kantong user — dan itu masih benar untuk angka rupiah. Tapi ia TAHU
   * jendelanya: user sendiri yang mendeklarasikannya. Jadi ia boleh memilih
   * angka yang DITURUNKAN darinya.
   *
   * Jendela 200 token × 5 = anggaran 1.000. Tiap langkah palsu 10 token, jadi
   * gilirannya berhenti sekitar langkah ke-100 — bukan di 40, dan bukan tanpa
   * batas.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      model: "mock/kecil",
      provider: { mock: { models: { kecil: { contextWindow: 200 } } } },
    }),
  )
  const seen = neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })

  assert.ok(seen.calls > 40, `berhenti di ${seen.calls} — plafon 40 seharusnya sudah dilewati`)
  assert.ok(seen.calls <= 100, `berhenti di ${seen.calls} — anggaran turunan 1.000 token`)
})

test("anggaran yang DITULIS user mengalahkan yang diturunkan", async () => {
  // Kalau tidak, mendeklarasikan jendela diam-diam membuang anggaran yang
  // sengaja dipasang seseorang.
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      model: "mock/besar",
      provider: { mock: { models: { besar: { contextWindow: 1_000_000 } } } },
      limits: { turnTokens: 25 },
    }),
  )
  const seen = neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })
  assert.ok(seen.calls <= 5, `anggaran 25 token yang berlaku, bukan 5 juta (${seen.calls} langkah)`)
})

test("kabarnya MENYEBUT bahwa anggarannya turunan", async () => {
  /*
   * Angka yang tidak pernah ditulis user, muncul tanpa penjelasan, terbaca
   * sebagai batas misterius alih-alih sesuatu yang bisa ia ubah.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      model: "mock/kecil",
      provider: { mock: { models: { kecil: { contextWindow: 200 } } } },
    }),
  )
  neverStops()
  const session = createSession(project)
  const seen = await collectNotices(session.id)

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "build-auto" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  seen.stop()

  const kabar = seen.messages.find((message) => message.includes("token budget")) ?? ""
  assert.match(kabar, /That is the default: 5× the model's context window/)
})

// ---------- anggaran SESI ----------

test("giliran ditolak kalau sesinya sudah melewati anggaran", async () => {
  /*
   * `turnTokens` menjaga satu giliran tidak berlari; ini menjaga sesi tidak
   * merayap. Bedanya nyata sejak ada lanjutan otomatis: enam giliran
   * berturut-turut, masing-masing patuh pada anggarannya sendiri, tetap bisa
   * menghabiskan berkali-kali lipat tanpa satu pun batas terlampaui.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      limits: { sessionTokens: 15 },
      agent: { pendek: { mode: "primary", steps: 2 } },
    }),
  )
  neverStops()
  const session = createSession(project)

  // Giliran pertama lolos — sesinya masih kosong saat diperiksa.
  await prompt({ sessionID: session.id, text: "pertama", agent: "pendek" })

  await assert.rejects(
    () => prompt({ sessionID: session.id, text: "kedua", agent: "pendek" }),
    /token budget/,
    "giliran kedua ditolak, dengan pesan yang menyebut anggarannya",
  )
})

test("ditolak SEBELUM apa pun tersentuh, bukan di tengah jalan", async () => {
  /*
   * Giliran yang dihentikan separuh jalan meninggalkan pekerjaan setengah jadi —
   * berkas tersunting, test belum dijalankan. Menolak sebelum ada yang tersentuh
   * jauh lebih mudah dipulihkan.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow", write: "allow" },
      limits: { sessionTokens: 15 },
      agent: { pendek: { mode: "primary", steps: 2 } },
    }),
  )
  const seen = neverStops()
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "pertama", agent: "pendek" })

  const before = seen.calls
  await prompt({ sessionID: session.id, text: "kedua", agent: "pendek" }).catch(() => undefined)
  assert.equal(seen.calls, before, "model tidak pernah dipanggil untuk giliran yang ditolak")
})

test("tanpa sessionTokens, tidak ada batas sesi sama sekali", async () => {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow" },
      agent: { pendek: { mode: "primary", steps: 2 } },
    }),
  )
  neverStops()
  const session = createSession(project)

  await prompt({ sessionID: session.id, text: "satu", agent: "pendek" })
  await prompt({ sessionID: session.id, text: "dua", agent: "pendek" })
  await prompt({ sessionID: session.id, text: "tiga", agent: "pendek" })
  assert.ok(true, "tiga giliran berturut-turut tanpa penolakan")
})
