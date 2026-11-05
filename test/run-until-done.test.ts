import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import {
  closingText,
  continueReason,
  isIdleContinuation,
  isProgressCall,
  type TurnEnding,
} from "../src/core/continuation.ts"

/**
 * "Jalan sampai selesai" — lanjutan yang dipicu oleh giliran yang berakhir
 * PREMATUR, bukan hanya oleh giliran yang mentok batas.
 *
 * Diukur dari sesi nyata: kebanyakan berhenti-sebelum-selesai adalah model yang
 * mengakhiri gilirannya sendiri — teks berakhir titik dua yang mengumumkan aksi
 * yang tidak pernah diambil, atau tool call yang ditulis sebagai teks. Lanjutan
 * lama (hanya saat mentok + rencana terbuka) tidak pernah menangkap keduanya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-until-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "until.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver, abort } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")
const { bus } = await import("../src/core/event.ts")

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

// ---------- keputusannya ----------

function end(partial: Partial<TurnEnding>): TurnEnding {
  return {
    stoppedAtLimit: false,
    lastText: "",
    calledQuestion: false,
    plan: undefined,
    chainStarted: 1000,
    ...partial,
  }
}

/** Rencana yang ditulis SESUDAH rangkaian dimulai (`chainStarted` bawaan 1000). */
function fresh(text: string): { text: string; updated: number } {
  return { text, updated: 2000 }
}

test("teks berakhir titik dua memicu 'announced'", () =>
  assert.equal(continueReason(end({ lastText: "Sekarang buat semua app Django sekaligus:" })), "announced"))

test("tool call yang ditulis sebagai teks memicu 'text-tool-call'", () =>
  assert.equal(continueReason(end({ lastText: "<tool_call>\n<function=read>" })), "text-tool-call"))

test("pertanyaan ke user tidak pernah dilanjutkan, walau rencananya terbuka", () => {
  assert.equal(continueReason(end({ lastText: "Mau pakai Postgres atau SQLite?", plan: fresh("- [ ] a") })), undefined)
  assert.equal(continueReason(end({ calledQuestion: true, stoppedAtLimit: true, plan: fresh("- [ ] a") })), undefined)
})

test("rencana terbuka yang ditulis dalam rangkaian ini memicu 'open-plan'", () =>
  assert.equal(continueReason(end({ plan: { text: "- [ ] a", updated: 2000 }, chainStarted: 1000 })), "open-plan"))

test("rencana lama yang tidak disentuh giliran ini tidak memicu lanjutan", () =>
  assert.equal(continueReason(end({ plan: { text: "- [ ] a", updated: 500 }, chainStarted: 1000 })), undefined))

test("giliran yang selesai wajar dengan rencana tuntas tidak dilanjutkan", () =>
  assert.equal(continueReason(end({ lastText: "Selesai.", plan: fresh("- [x] a") })), undefined))

test("giliran yang mentok batas dengan rencana terbuka dari rangkaian ini memicu 'limit'", () =>
  assert.equal(continueReason(end({ stoppedAtLimit: true, plan: fresh("- [ ] a") })), "limit"))

test("giliran yang mentok batas dengan rencana lama tidak melanjutkan rencana itu", () =>
  /*
   * Pertanyaan sampingan di sesi interaktif yang kebetulan mentok batas, di
   * atas rencana setengah jadi dari kemarin. Melanjutkan dengan "Continue the
   * unfinished items in your plan" berarti membangunkan pekerjaan yang tidak
   * diminta hari ini — anti-tujuan spec.
   */
  assert.equal(
    continueReason(end({ stoppedAtLimit: true, plan: { text: "- [ ] a", updated: 500 }, chainStarted: 1000 })),
    undefined,
  ))

test("teks yang disusul tool call di langkah yang sama bukan pengumuman tanpa aksi", () => {
  /*
   * Giliran yang mentok batas berakhir pada tool call. "Let me read the file:"
   * dari langkah sebelumnya sudah dijawab oleh `read` sesudahnya; membacanya
   * sebagai teks penutup membuat setiap giliran mentok terlihat "announced".
   */
  const steps = [
    { text: "Let me read the file:", toolCalls: [{}] },
    { text: "Now the next one:", toolCalls: [{}] },
  ]
  assert.equal(closingText(steps), "")
  assert.equal(continueReason(end({ stoppedAtLimit: true, lastText: closingText(steps) })), undefined)
})

test("teks penutup diambil dari langkah terakhir saja", () =>
  assert.equal(
    closingText([
      { text: "Sekarang tulis berkas:", toolCalls: [{}] },
      { text: "Selesai.", toolCalls: [] },
    ]),
    "Selesai.",
  ))

test("lanjutan tanpa tool call dihitung menganggur", () => assert.equal(isIdleContinuation(0, 0, "a", "b"), true))

test("lanjutan yang menulis berkas tanpa memperbarui rencana tetap kemajuan", () =>
  assert.equal(isIdleContinuation(5, 2, "a", "a"), false))

test("lanjutan yang hanya membaca dan tidak menyentuh rencana dihitung menganggur", () =>
  assert.equal(isIdleContinuation(3, 0, "a", "a"), true))

test("lanjutan yang hanya membaca tapi memperbarui rencana tetap kemajuan", () =>
  assert.equal(isIdleContinuation(3, 0, "- [ ] a", "- [x] a"), false))

test("lanjutan yang hanya mendelegasikan lewat task tetap kemajuan", () => {
  // `task` tidak `mutates` — yang menulis adalah sub-agentnya, di sesi lain.
  // Tanpa ini, koordinator yang terus mendelegasikan direm setelah dua lanjutan.
  const mutating = new Set(["write", "edit"])
  assert.equal(isProgressCall("task", mutating), true)
  assert.equal(isProgressCall("write", mutating), true)
  assert.equal(isProgressCall("read", mutating), false)
  const progress = ["task", "read"].filter((name) => isProgressCall(name, mutating)).length
  assert.equal(isIdleContinuation(2, progress, "a", "a"), false)
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

function textOnly(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

/** Teks user terakhir di permintaan, atau "" kalau tidak ada. */
function lastUserText(options: LanguageModelV4CallOptions): string {
  const users = options.prompt.filter((message) => message.role === "user")
  const last = users.at(-1)?.content
  if (!Array.isArray(last)) return ""
  const text = last.find((part) => part.type === "text")
  return text && "text" in text ? text.text : ""
}

/**
 * Giliran pertama berakhir dengan "Sekarang tulis berkas:" tanpa tool call;
 * sesudahnya model menulis berkas lalu menutup dengan kalimat wajar.
 */
function announcesThenStops(): { prompts: string[]; calls: number } {
  const seen: { prompts: string[]; calls: number } = { prompts: [], calls: 0 }
  let userTurns = 0
  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      seen.calls += 1
      const isNewTurn = options.prompt.at(-1)?.role === "user"
      if (isNewTurn) {
        userTurns += 1
        seen.prompts.push(lastUserText(options))
      }
      const chunks: LanguageModelV4StreamPart[] =
        userTurns === 1
          ? textOnly("Sekarang tulis berkas:")
          : isNewTurn
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: `w${seen.calls}`,
                  toolName: "write",
                  input: JSON.stringify({ path: "b.txt", content: "baru\n" }),
                },
                { type: "finish", finishReason: "tool-calls", usage: USAGE },
              ]
            : textOnly("Berkasnya sudah ditulis.")
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)
  return seen
}

/**
 * Model yang SELALU mengumumkan langkah tanpa pernah mengambilnya.
 *
 * `calls` hanya menghitung panggilan dengan sinyal yang masih hidup — provider
 * sungguhan menolak `fetch` yang sinyalnya sudah dibatalkan sebelum satu token
 * pun ditagih, dan mock yang mengabaikan sinyal akan menghitung panggilan yang
 * di dunia nyata tidak pernah terjadi.
 */
function alwaysAnnounces(): { calls: number } {
  const seen = { calls: 0 }
  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      options.abortSignal?.throwIfAborted()
      seen.calls += 1
      return { stream: simulateReadableStream({ chunks: textOnly("lanjut:") }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => model)
  return seen
}

/** Dihitung dari pesan ASSISTANT — lanjutan tidak menulis pesan user. */
function turns(sessionID: string): number {
  return listMessages(sessionID).filter((message) => message.role === "assistant").length
}

/** Mengumpulkan `session.notice` sesi ini; panggil `stop()` sesudah giliran. */
function collectNotices(
  sessionID: string,
  onNotice?: (message: string) => void,
): { notices: string[]; stop: () => Promise<void> } {
  const controller = new AbortController()
  const notices: string[] = []
  void (async () => {
    for await (const event of bus.subscribe({ sessionID, signal: controller.signal })) {
      if (event.type !== "session.notice") continue
      notices.push(event.message)
      onNotice?.(event.message)
    }
  })()
  return {
    notices,
    stop: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
    },
  }
}

test("giliran interaktif yang mengumumkan tanpa aksi dilanjutkan tanpa continueTurns di config", async () => {
  configWith({})
  const seen = announcesThenStops()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })

  assert.equal(turns(session.id), 2)
  assert.match(seen.prompts[1] ?? "", /announced a next step/)
  assert.ok(fs.existsSync(path.join(project, "b.txt")), "lanjutannya benar-benar mengerjakan")
})

test("tanpa interactive, bawaannya tetap mati", async () => {
  // `titah run` di CI tidak punya Esc: belanja tanpa bertanya harus diminta.
  configWith({})
  announcesThenStops()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek" })

  assert.equal(turns(session.id), 1)
})

test("continueTurns 0 yang ditulis eksplisit mematikan lanjutan, juga di client interaktif", async () => {
  configWith({ limits: { continueTurns: 0 } })
  announcesThenStops()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })

  assert.equal(turns(session.id), 1)
})

test("dua lanjutan menganggur berturut-turut menghentikan rangkaian", async () => {
  /*
   * Model yang terus menjawab "lanjut:" tanpa tool tidak sedang bekerja.
   * Jaring 50 lanjutan memang ujungnya, tapi 50 giliran kosong adalah uang
   * yang dibakar untuk sesuatu yang sudah jelas sejak giliran ketiga.
   */
  configWith({})
  alwaysAnnounces()

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })

  assert.equal(turns(session.id), 3, "giliran asli + 2 lanjutan menganggur, lalu berhenti")
})

test("abort sesudah giliran selesai tetap memutus rangkaian", async () => {
  /*
   * Yang dipatok: Esc yang ditekan saat notice lanjutan muncul mencegah
   * panggilan model berikutnya. Handler bus berjalan asinkron, jadi `abort()`
   * mendarat di controller giliran LANJUTAN (yang dipasang sinkron) dan
   * membatalkannya sebelum model dipanggil.
   *
   * Pemeriksaan `abortRequested` sebelum rekursi TIDAK dilalui test ini —
   * hari ini tidak ada `await` di celah itu, jadi ia hanya pertahanan untuk
   * `await` yang kelak ditambahkan di sana.
   */
  configWith({})
  const seen = alwaysAnnounces()

  const session = createSession(project)
  const collected = collectNotices(session.id, (message) => {
    if (message.startsWith("Continuing on its own")) abort(session.id)
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })
  await collected.stop()

  assert.equal(seen.calls, 1, "tidak ada giliran lanjutan yang sempat memanggil model")
})

test("abort di sesi yang diam tidak membatalkan giliran user berikutnya", async () => {
  // Penanda Esc dibersihkan saat user mengetik lagi; kalau tidak, Esc yang
  // ditekan kapan pun sebelumnya akan memotong rangkaian berikutnya diam-diam.
  configWith({})
  announcesThenStops()

  const session = createSession(project)
  abort(session.id)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })

  assert.equal(turns(session.id), 2)
})

test("notice lanjutan menyebut alasannya", async () => {
  configWith({})
  announcesThenStops()

  const session = createSession(project)
  const collected = collectNotices(session.id)
  await new Promise((resolve) => setTimeout(resolve, 10))

  await prompt({ sessionID: session.id, text: "kerjakan", agent: "pendek", interactive: true })
  await collected.stop()

  const notice = collected.notices.find((message) => message.startsWith("Continuing on its own"))
  assert.equal(
    notice,
    "Continuing on its own (1 of 50) — the model announced a step without taking it. Press Esc to stop.",
  )
})
