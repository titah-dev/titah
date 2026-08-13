import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

/**
 * Plugin di dalam GILIRAN yang sungguhan.
 *
 * Unit test di `plugin.test.ts` membuktikan `runBefore`/`runAfter` berperilaku
 * benar. Tidak satu pun darinya membuktikan keduanya benar-benar TERPASANG di
 * jalur eksekusi tool — dan justru itu yang paling mudah salah, karena
 * pemasangannya ada di satu tempat yang tidak dipanggil test mana pun.
 *
 * Yang paling penting diuji di sini adalah URUTANNYA terhadap izin. `tool.before`
 * harus berjalan lebih dulu; kalau tidak, plugin bisa mengubah masukan setelah
 * user menyetujui yang lama, dan yang disetujui bukan lagi yang dijalankan.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-pt-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "pt.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "kode.ts"), "export const nilai = 1\n")
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

function text(body: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: body },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

function call(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]
}

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

/**
 * Menulis plugin ke proyek dan menyebutnya di titah.json.
 *
 * Nama berkasnya UNIK per pemanggilan. `import()` menyimpan modul berdasarkan
 * URL-nya, jadi dua test yang menulis isi berbeda ke path yang sama akan
 * dilayani modul yang PERTAMA — dan test kedua gagal dengan gejala yang
 * menunjuk ke fitur, bukan ke cache.
 */
let nomor = 0
function withPlugin(body: string, extra: Record<string, unknown> = {}): void {
  nomor += 1
  const nama = `plug${nomor}.mjs`
  fs.writeFileSync(path.join(project, nama), body)
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      plugin: { [`./${nama}`]: {} },
      ...extra,
    }),
  )
}

function toolPart(sessionID: string) {
  return listMessages(sessionID)
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool") as
    | { type: "tool"; state: { status: string; reason?: string; output?: string; input?: unknown } }
    | undefined
}

test("tool.before menolak, dan tool-nya TIDAK pernah berjalan", async () => {
  /*
   * Bukti bahwa ia menolak sungguhan, bukan sekadar melapor: berkasnya
   * diperiksa. Plugin yang "menolak" tapi tool-nya tetap jalan adalah kegagalan
   * yang terlihat persis seperti keberhasilan di transkrip.
   */
  withPlugin(`export default () => ({
    "tool.before": ({ tool }) => (tool === "write" ? { deny: "berkas ini terkunci" } : undefined),
  })`)

  mock([call("write", { path: "baru.ts", content: "x" }), text("sudah")])
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "tulis" })

  const part = toolPart(session.id)
  assert.equal(part?.state.status, "denied")
  assert.match(part?.state.reason ?? "", /berkas ini terkunci/)
  assert.equal(fs.existsSync(path.join(project, "baru.ts")), false, "tidak boleh ada berkas baru")
})

test("tool.before berjalan SEBELUM izin: yang disetujui adalah masukan yang sudah diubah", async () => {
  /*
   * Inti seluruh urutan ini. Plugin mengarahkan tulisan ke berkas lain; kalau
   * ia berjalan sesudah izin, dialog akan menyebut berkas yang lama sementara
   * yang ditulis berkas yang baru — dan itu membatalkan arti dialog izin.
   *
   * `auto: true` di sini supaya yang diuji urutannya, bukan dialog izinnya —
   * tanpa klien yang terhubung, setiap tulisan ditolak otomatis dan test ini
   * akan hijau karena alasan yang sama sekali salah.
   */
  withPlugin(
    `export default () => ({
      "tool.before": ({ tool, input }) =>
        tool === "write" ? { input: { ...input, path: "dialihkan.ts" } } : undefined,
    })`,
  )

  mock([call("write", { path: "asli.ts", content: "isi" }), text("sudah")])
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "tulis", auto: true })

  assert.equal(fs.existsSync(path.join(project, "dialihkan.ts")), true, "yang ditulis yang baru")
  assert.equal(fs.existsSync(path.join(project, "asli.ts")), false, "yang lama tidak ditulis")

  const part = toolPart(session.id)
  assert.deepEqual(
    (part?.state.input as { path: string }).path,
    "dialihkan.ts",
    "yang tercatat adalah masukan yang benar-benar dijalankan",
  )
})

test("tool.after membentuk keluaran yang dilihat model", async () => {
  withPlugin(`export default () => ({
    "tool.after": ({ output }) => output + "\\n[dilihat plugin]",
  })`)

  mock([call("read", { path: "kode.ts" }), text("sudah")])
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca" })

  assert.match(toolPart(session.id)?.state.output ?? "", /\[dilihat plugin\]/)
})

test("plugin yang gagal dimuat TIDAK menjatuhkan giliran", async () => {
  /*
   * Aturan yang sama dengan server MCP yang mati. Sesi yang menolak dimulai
   * karena satu plugin rusak menghukum orang atas hal yang tidak ia minta.
   */
  withPlugin(`throw new Error("plugin ini rusak")`)

  mock([text("tetap menjawab")])
  const session = createSession(project)
  const jawaban = await prompt({ sessionID: session.id, text: "halo" })

  const body = jawaban.parts.find((part) => part.type === "text") as { text?: string } | undefined
  assert.match(body?.text ?? "", /tetap menjawab/)
})
