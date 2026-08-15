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

test("sub-agent yang SETIAP tool-nya ditolak dilaporkan gagal, bukan done", async () => {
  /*
   * Gilirannya memang selesai tanpa error — ia menerima penolakan, lalu
   * menjawab. Tapi bagi koordinator, `✓` di atas sub-agent yang tidak
   * mengerjakan apa pun adalah kabar yang salah: ia melihat keberhasilan, dan
   * langkah berikutnya dibangun di atas pekerjaan yang tidak pernah terjadi.
   */
  configWith()
  mock([
    call("task", { agent: "penulis", instruction: "buat y.ts" }),
    call("write", { path: "y.ts", content: "y\n" }),
    text("sudah saya kerjakan"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "buat", agent: "plan" })

  const state = toolStates(session.id).find((entry) => "output" in entry) as
    | { title?: string; outcome?: string; output?: string }
    | undefined

  assert.equal(state?.outcome, "failed", "glyph sukses akan berbohong di sini")
  assert.match(state?.title ?? "", /\(failed\)/)
  assert.match(state?.output ?? "", /REFUSED/, "koordinator diberi tahu, bukan dibiarkan menebak")
  assert.match(state?.output ?? "", /sudah saya kerjakan/, "kata-kata anaknya tetap ikut")
})

test("sub-agent yang TIDAK memakai tool sama sekali tetap done", async () => {
  /*
   * Buktinya adalah percobaan yang ditolak, bukan ketiadaan percobaan. Giliran
   * tanpa tool call bisa saja jawaban yang benar dari konteks yang diberikan —
   * menandainya gagal akan salah lebih sering daripada benar.
   */
  configWith()
  mock([
    call("task", { agent: "penulis", instruction: "jawab saja" }),
    text("jawabannya empat"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "tanya", agent: "plan" })

  const state = toolStates(session.id).find((entry) => "output" in entry) as
    | { outcome?: string; output?: string }
    | undefined

  assert.equal(state?.outcome, undefined, "tanpa percobaan, tidak ada bukti kegagalan")
  assert.match(state?.output ?? "", /jawabannya empat/)
})

test("sub-agent yang SEBAGIAN tool-nya lolos tetap done", async () => {
  // Satu penolakan di antara pekerjaan yang berhasil bukan kegagalan; menandainya
  // begitu membuat penanda ini berhenti berarti apa-apa.
  configWith()
  mock([
    call("task", { agent: "penulis", instruction: "baca lalu tulis" }),
    call("read", { path: "kode.ts" }, "c2"),
    call("write", { path: "z.ts", content: "z\n" }, "c3"),
    text("sebagian selesai"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "kerjakan", agent: "plan" })

  const state = toolStates(session.id).find((entry) => "output" in entry) as
    | { outcome?: string }
    | undefined
  assert.equal(state?.outcome, undefined, "ada yang berhasil, jadi bukan sepenuhnya ditolak")
})
