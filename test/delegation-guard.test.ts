import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * Batas induk yang benar-benar menahan, diuji lewat GILIRAN sungguhan.
 *
 * `permission-ceiling.test.ts` membuktikan `narrower` menghitung dengan benar.
 * Tidak satu pun darinya membuktikan hasil hitungan itu sampai ke tempat yang
 * memutuskan — dan rantainya panjang: buildTools → ToolContext → task →
 * runSubagent → prompt → effectivePermission. Satu sambungan yang lepas
 * membuat seluruh perbaikan tidak berarti apa-apa, tanpa satu pun test unit
 * berubah warna.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-dg-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "dg.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

const AGENTS = {
  penulis: {
    mode: "all",
    description: "Menulis berkas",
    permission: { edit: "allow", write: "allow", bash: "allow" },
  },
}

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "kode.ts"), "export const a = 1\n")
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function configWith(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] }, agent: AGENTS, ...extra }),
  )
}

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: body },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", usage: USAGE },
]

const call = (tool: string, input: unknown, id = "c1"): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: tool, input: JSON.stringify(input) },
  { type: "finish", finishReason: "tool-calls", usage: USAGE },
]

/**
 * Model palsu yang berbeda untuk INDUK dan ANAK.
 *
 * Keduanya memakai resolver yang sama, jadi urutan panggilannya yang
 * membedakan: giliran induk memanggil `task`, giliran anak mencoba `write`.
 */
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

function toolStates(sessionID: string) {
  return listMessages(sessionID)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool")
    .map((part) => (part as { state: { status: string; reason?: string } }).state)
}

test("plan TIDAK bisa menulis lewat sub-agent yang boleh menulis", async () => {
  /*
   * Inti seluruh Fase 0. `plan` punya `edit`/`write` = "deny", dan `penulis`
   * punya keduanya "allow". Sebelum perbaikan ini, sub-agent berjalan dengan
   * izinnya sendiri — jadi batas Plan mode bocor lewat jalan yang justru
   * disediakan Titah.
   *
   * Buktinya berkas, bukan status: sub-agent yang "ditolak" tapi berkasnya
   * tetap berubah adalah kegagalan yang terlihat persis seperti keberhasilan.
   */
  configWith()
  mock([
    call("task", { agent: "penulis", instruction: "buat baru.ts" }),
    call("write", { path: "baru.ts", content: "seharusnya tidak ada\n" }),
    text("selesai"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "tolong buat berkas", agent: "plan" })

  assert.equal(
    fs.existsSync(path.join(project, "baru.ts")),
    false,
    "plan menembus batasnya lewat sub-agent",
  )
})

test("build-auto TETAP bisa menulis lewat sub-agent — jalur sah tidak ikut mati", async () => {
  /*
   * Jaring pengaman ke arah sebaliknya, dan sama pentingnya. Perbaikan keamanan
   * yang diam-diam mematikan jalur yang sah akan dimatikan seluruhnya oleh
   * orang yang memakainya.
   */
  configWith()
  mock([
    call("task", { agent: "penulis", instruction: "buat halo.ts" }),
    call("write", { path: "halo.ts", content: "isi\n" }),
    text("selesai"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "buat berkas", agent: "build-auto", auto: true })

  assert.equal(fs.existsSync(path.join(project, "halo.ts")), true, "jalur sah harus tetap jalan")
})

test("agent ber-delegate ditolak dari induk read-only", async () => {
  /*
   * Blok izin Titah tidak pernah sampai ke CLI eksternal. Membiarkannya jalan
   * berarti `plan` bisa mengubah repo lewat pintu yang tidak punya kunci sama
   * sekali — jadi ia ditolak, bukan dibatasi setengah-setengah.
   */
  configWith({
    externalAgent: { palsu: { command: process.execPath, args: ["-e", "0"] } },
    agent: { ...AGENTS, luar: { mode: "all", delegate: "palsu" } },
  })
  mock([call("task", { agent: "luar", instruction: "kerjakan" }), text("selesai")])

  const session = createSession(project)
  const assistant = await prompt({ sessionID: session.id, text: "kerjakan", agent: "plan" })

  const output = JSON.stringify(assistant.parts)
  assert.match(output, /Refused/i)
  assert.match(output, /external CLI/i, "alasannya menyebut kenapa ia tidak bisa dibatasi")
})
