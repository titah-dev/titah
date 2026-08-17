import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { hasOpenWork, planProgress } from "../src/core/plan-progress.ts"

/**
 * "Jalan sampai semua task selesai" — sebagai LOOP DARI GILIRAN, bukan satu
 * giliran tanpa batas.
 *
 * Giliran seribu langkah dipadatkan berkali-kali; di langkah ke-400 model
 * bekerja dari ringkasan atas ringkasan dan pelan-pelan lupa. Giliran baru mulai
 * dengan transkrip bersih dan membaca ulang rencana utuh dari tabel `plan`,
 * satu-satunya tabel yang tidak disentuh pemadatan.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-cont-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "cont.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, savePlan, listMessages } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi\n")
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------- membaca kemajuan dari rencana ----------

test("butir yang dicentang dan yang belum, dihitung terpisah", () => {
  const plan = "- [x] baca kode\n- [ ] tulis test\n- [ ] jalankan"
  assert.deepEqual(planProgress(plan), { open: 2, done: 1, checkable: true })
})

test("`[-]` dihitung selesai — butir yang sengaja dilewati bukan sisa pekerjaan", () => {
  // Bukan standar GitHub, tapi beberapa model memakainya untuk "dilewati".
  assert.equal(planProgress("- [-] lewati ini\n- [x] selesai").open, 0)
})

test("penomoran juga dikenali, bukan cuma tanda hubung", () => {
  assert.deepEqual(planProgress("1. [ ] satu\n2) [x] dua"), {
    open: 1,
    done: 1,
    checkable: true,
  })
})

test('rencana TANPA kotak centang berarti "tidak bisa dinilai", bukan "tidak ada sisa"', () => {
  /*
   * Bedanya menentukan. Nol butir tersisa berarti pekerjaan selesai; tidak ada
   * yang bisa dinilai berarti kita tidak tahu. Menyamakan keduanya membuat loop
   * berhenti pada rencana yang justru baru saja ditulis.
   */
  const paragraf = planProgress("Rencananya: baca semuanya lalu rapikan.")
  assert.equal(paragraf.checkable, false)
  assert.equal(paragraf.open, 0)

  assert.equal(hasOpenWork("Rencananya: baca semuanya lalu rapikan."), false)
  assert.equal(hasOpenWork("- [ ] satu"), true)
  assert.equal(hasOpenWork("- [x] satu"), false)
  assert.equal(hasOpenWork(undefined), false)
})

test("daftar berpoin biasa tidak disangka kotak centang", () => {
  assert.equal(planProgress("- baca kode\n- tulis test").checkable, false)
})

// ---------- loopnya ----------

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

function configWith(extra: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow" },
      agent: { pendek: { mode: "primary", steps: 2 } },
      ...extra,
    }),
  )
}

/** Model yang tidak pernah berhenti; merekam teks user tiap giliran. */
function neverStops(): { prompts: string[]; calls: number } {
  const seen: { prompts: string[]; calls: number } = { prompts: [], calls: 0 }

  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      seen.calls += 1
      const users = options.prompt.filter((message) => message.role === "user")
      const last = users.at(-1)?.content
      if (Array.isArray(last)) {
        const text = last.find((part) => part.type === "text")
        if (text && "text" in text) seen.prompts.push(text.text)
      }

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
            { type: "text-delta", id: "t", delta: "mentok" },
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

function turns(sessionID: string): number {
  return listMessages(sessionID).filter((message) => message.role === "user").length
}

test("giliran yang mentok DILANJUTKAN selama rencananya masih punya sisa", async () => {
  configWith({ limits: { continueTurns: 2 } })
  const seen = neverStops()

  const session = createSession(project)
  savePlan(session.id, "- [ ] satu\n- [ ] dua")
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 3, "giliran asli + dua lanjutan")
  assert.equal(seen.calls, 6, "dua langkah per giliran")
})

test("prompt lanjutan menunjuk ke RENCANA, bukan mengulang permintaan asli", async () => {
  /*
   * Mengulang teks aslinya membuat model memulai dari nol — membaca ulang
   * berkas yang sudah dibaca, merencanakan ulang yang sudah direncanakan.
   */
  configWith({ limits: { continueTurns: 1 } })
  const seen = neverStops()

  const session = createSession(project)
  savePlan(session.id, "- [ ] satu")
  await prompt({ sessionID: session.id, text: "bangun fitur X", agent: "pendek" })

  const lanjutan = seen.prompts.filter((text) => text !== "bangun fitur X")
  assert.ok(lanjutan.length > 0)
  assert.match(lanjutan[0] ?? "", /Continue the unfinished items in your plan/)
  assert.match(lanjutan[0] ?? "", /Do not restart work that is already checked off/)
})

test("rencana yang SUDAH habis menghentikan loopnya", async () => {
  configWith({ limits: { continueTurns: 5 } })
  neverStops()

  const session = createSession(project)
  savePlan(session.id, "- [x] satu\n- [x] dua")
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 1, "tidak ada lanjutan sama sekali")
})

test("tanpa rencana sama sekali, tidak pernah melanjutkan", async () => {
  // Satu-satunya definisi "belum selesai" yang bisa dinilai mesin adalah butir
  // yang belum dicentang. Tanpa itu, melanjutkan cuma tebakan yang dibayar user.
  configWith({ limits: { continueTurns: 5 } })
  neverStops()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 1)
})

test("bawaannya MATI — tidak ada yang melanjutkan tanpa diminta", async () => {
  /*
   * Ia membelanjakan uang tanpa bertanya. Syaratnya memang ketat, tapi "ketat"
   * bukan "gratis": user yang tidak pernah memintanya tidak boleh menemukan itu
   * sudah terjadi.
   */
  configWith({})
  neverStops()

  const session = createSession(project)
  savePlan(session.id, "- [ ] masih banyak")
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 1)
})

test("jatah lanjutan adalah batas KERAS", async () => {
  // "Sampai selesai" tetap harus punya ujung, kalau tidak rencana yang tidak
  // pernah dicentang akan berputar sampai kuota provider habis.
  configWith({ limits: { continueTurns: 3 } })
  neverStops()

  const session = createSession(project)
  savePlan(session.id, "- [ ] tidak pernah dicentang")
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 4, "asli + tiga lanjutan, lalu berhenti")
})

test("giliran yang selesai WAJAR tidak dilanjutkan, walau rencananya punya sisa", async () => {
  /*
   * Model berhenti sendiri berarti ia menganggap gilirannya selesai — mungkin
   * ia sedang menunggu jawaban, mungkin rencananya usang. Melanjutkannya berarti
   * memaksa bekerja atas keputusan yang bukan miliknya.
   */
  configWith({ limits: { continueTurns: 5 } })
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
  savePlan(session.id, "- [ ] masih ada")
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 1)
})

test("sub-agent tidak melanjutkan dirinya sendiri", async () => {
  /*
   * Anak tidak mengatur nasibnya sendiri; induknya yang mengatur. Kalau ikut
   * melanjutkan, satu `task` bisa diam-diam jadi beberapa giliran penuh yang
   * tidak pernah diminta koordinatornya — dan jatahnya dihitung per sesi, jadi
   * tiap anak membawa jatahnya sendiri.
   */
  configWith({
    limits: { continueTurns: 3 },
    agent: {
      pendek: { mode: "primary", steps: 2 },
      anak: { mode: "all", description: "Pekerja", steps: 2 },
    },
  })

  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      calls += 1
      const tools = options.tools ?? []
      const hasTask = tools.some((t) => t.name === "task")
      const chunks: LanguageModelV4StreamPart[] =
        hasTask && calls === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "t1",
                toolName: "task",
                input: JSON.stringify({ agent: "anak", instruction: "kerjakan" }),
              },
              { type: "finish", finishReason: "tool-calls", usage: USAGE },
            ]
          : tools.length > 0
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: `r${calls}`,
                  toolName: "read",
                  input: JSON.stringify({ path: "a.txt" }),
                },
                { type: "finish", finishReason: "tool-calls", usage: USAGE },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "ok" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: "stop", usage: USAGE },
              ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)

  const session = createSession(project)
  savePlan(session.id, "- [ ] masih ada")
  await prompt({ sessionID: session.id, text: "delegasikan", agent: "pendek" })

  // Induknya boleh melanjutkan; yang diperiksa di sini adalah anaknya tidak
  // menambah sesi anak baru atas kemauannya sendiri.
  const { listChildSessions } = await import("../src/core/storage/session.ts")
  assert.equal(listChildSessions(session.id).length, 1, "satu task = satu sesi anak")
})
