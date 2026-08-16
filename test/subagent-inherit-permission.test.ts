import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach, after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { effectivePermission, inheritedPermission, narrower } from "../src/core/permission.ts"
import { Config, DEFAULT_AGENTS } from "../src/core/schema.ts"

/**
 * "Tanpa konfirmasi" yang berhenti berlaku begitu mendelegasikan.
 *
 * `build-auto` membuka delapan sumbu. Agent yang user daftarkan hampir tidak
 * pernah menulis blok `permission` sendiri, jadi mereka jatuh ke global — yang
 * pada umumnya `ask` seluruhnya — dan `narrower` mempertahankan `ask` itu
 * karena ia memang lebih ketat.
 *
 * Diukur pada config user sungguhan sebelum perbaikan:
 *
 *   INDUK build-auto : bash=allow write=allow edit=allow
 *   anak explore     : bash=ask   write=ask   edit=ask
 *
 * Jadi sub-agent bertanya untuk `ls`, `cat`, `grep`.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-inh-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "inh.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession, listMessages } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

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

/** Global yang serba `ask` — bentuk paling umum, dan yang memicu masalahnya. */
const GLOBAL_ASK = {
  edit: "ask",
  write: "ask",
  bash: "ask",
  network: "ask",
  delete: "ask",
  mcp: "ask",
  external_directory: "deny",
  doom_loop: "ask",
} as const

const config = (extra: Record<string, unknown> = {}) =>
  Config.parse({ skills: { discover: [], paths: [] }, permission: GLOBAL_ASK, ...extra })

/**
 * `Config.parse` mengembalikan `agent: {}` — preset bawaan baru digabung
 * `loadConfig`. Jadi induk bawaan diambil dari `DEFAULT_AGENTS`, persis seperti
 * yang akan dilihat giliran sungguhan.
 */
const parentOf = (parsed: ReturnType<typeof config>, id: string) =>
  effectivePermission(parsed, id, parsed.agent[id] ?? DEFAULT_AGENTS[id])

const childUnder = (parsed: ReturnType<typeof config>, parentID: string, childID: string) => {
  const induk = parentOf(parsed, parentID)
  return narrower(induk, inheritedPermission(induk, childID, parsed.agent[childID]))
}

// ---------- pewarisan ----------

test("sub-agent tanpa blok permission MEWARISI induk, bukan global", () => {
  /*
   * Inti perbaikannya. Sebelum ini hasilnya `ask` di semua sumbu, dan
   * build-auto yang menjanjikan tidak menyela berhenti menepatinya persis pada
   * langkah yang paling ingin dipercepat user.
   */
  const parsed = config({ agent: { explore: { mode: "all", description: "Telusuri" } } })
  const anak = childUnder(parsed, "build-auto", "explore")

  assert.equal(anak.bash, "allow")
  assert.equal(anak.write, "allow")
  assert.equal(anak.edit, "allow")
  assert.equal(anak.network, "allow")
})

test("tidak ada kewenangan baru: yang diwarisi hanya yang sudah dipunyai induk", () => {
  /*
   * Alasan kenapa ini aman, dinyatakan sebagai test: setiap sumbu anak selalu
   * sama atau lebih ketat dari induknya. Anak tidak pernah bisa melakukan
   * sesuatu yang induknya tidak bisa lakukan sendiri, langsung.
   */
  const parsed = config({ agent: { explore: { mode: "all" } } })
  const urutan = { deny: 0, ask: 1, allow: 2 } as const
  const sumbu = ["edit", "write", "bash", "network", "delete", "mcp", "doom_loop"] as const

  for (const induk of ["plan", "build", "build-auto"]) {
    const atas = parentOf(parsed, induk)
    const bawah = childUnder(parsed, induk, "explore")
    for (const key of sumbu) {
      assert.ok(
        urutan[bawah[key]] <= urutan[atas[key]],
        `di bawah ${induk}, anak ${key}=${bawah[key]} melampaui induk ${atas[key]}`,
      )
    }
  }
})

test("di bawah plan, anak tetap mewarisi deny", () => {
  // Arah sebaliknya, dan ini yang menjaga Plan mode tetap berarti.
  const parsed = config({ agent: { explore: { mode: "all" } } })
  const anak = childUnder(parsed, "plan", "explore")
  assert.equal(anak.write, "deny")
  assert.equal(anak.edit, "deny")
})

test("anak yang menyatakan lebih longgar dari induk TETAP dijepit", () => {
  // Pewarisan tidak menggantikan batas atas; ia hanya mengisi sumbu yang
  // dibiarkan kosong.
  const parsed = config({
    agent: { nekat: { mode: "all", permission: { write: "allow", edit: "allow" } } },
  })
  const anak = childUnder(parsed, "plan", "nekat")
  assert.equal(anak.write, "deny")
})

test("anak yang menyatakan lebih KETAT dari induk dihormati", () => {
  /*
   * `deny` milik anak adalah pernyataan tentang dirinya sendiri — agent
   * pembaca yang sengaja tidak boleh menulis tidak berubah pikiran hanya
   * karena dipanggil dari mode yang longgar.
   */
  const parsed = config({
    agent: { pembaca: { mode: "all", permission: { write: "deny", edit: "deny" } } },
  })
  const anak = childUnder(parsed, "build-auto", "pembaca")
  assert.equal(anak.write, "deny")
  assert.equal(anak.bash, "allow", "sumbu yang tidak ia sebut tetap ikut induk")
})

test("aturan induk dan anak digabung, tidak saling membuang", () => {
  const parsed = config({
    permission: { ...GLOBAL_ASK, rules: { "bash(rm *)": "deny" } },
    agent: { anak: { mode: "all", permission: { rules: { "bash(git *)": "allow" } } } },
  })
  const sumber = childUnder(parsed, "build-auto", "anak").rules.map((rule) => rule.source)
  assert.ok(sumber.includes("bash(rm *)"), "aturan induk hilang")
  assert.ok(sumber.includes("bash(git *)"), "aturan anak hilang")
})

test("aturan tidak dihitung dua kali", () => {
  // `inheritedPermission` sengaja hanya membawa aturan ANAK; aturan induk ikut
  // lewat `narrower`. Kalau keduanya membawanya, setiap aturan dinilai ganda.
  const parsed = config({
    permission: { ...GLOBAL_ASK, rules: { "bash(rm *)": "deny" } },
    agent: { anak: { mode: "all" } },
  })
  const cocok = childUnder(parsed, "build-auto", "anak").rules.filter(
    (rule) => rule.source === "bash(rm *)",
  )
  assert.equal(cocok.length, 1)
})

// ---------- giliran sungguhan ----------

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

test("sub-agent build-auto menulis TANPA satu pun dialog izin", async () => {
  /*
   * Buktinya berkas, bukan hitungan sumbu. Tanpa klien yang mendengarkan,
   * setiap permintaan izin auto-ditolak (Q17) — jadi berkas yang benar-benar
   * ada hanya mungkin kalau tidak ada yang pernah ditanyakan.
   */
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      permission: GLOBAL_ASK,
      agent: { explore: { mode: "all", description: "Telusuri" } },
    }),
  )

  mock([
    call("task", { agent: "explore", instruction: "buat catatan.md" }),
    call("write", { path: "catatan.md", content: "isi\n" }),
    text("sudah"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "delegasikan", agent: "build-auto" })

  assert.equal(
    fs.existsSync(path.join(project, "catatan.md")),
    true,
    "sub-agent masih ditanya, padahal induknya build-auto",
  )
})

test("dan di bawah plan berkas itu TIDAK pernah ada", async () => {
  // Jaring pengaman: perbaikan ini tidak boleh ikut membuka Plan mode.
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      permission: GLOBAL_ASK,
      agent: { explore: { mode: "all", description: "Telusuri" } },
    }),
  )

  mock([
    call("task", { agent: "explore", instruction: "buat larangan.md" }),
    call("write", { path: "larangan.md", content: "isi\n" }),
    text("sudah"),
  ])

  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "delegasikan", agent: "plan" })

  assert.equal(fs.existsSync(path.join(project, "larangan.md")), false)
})

// ---------- kapan build-auto BOLEH bertanya ----------

test("prompt build-auto memisahkan mekanik dari pertanyaan yang sah", () => {
  /*
   * Sumbu izin tidak bisa menyatakan "tanya kalau permintaannya bertentangan
   * dengan kenyataan proyek" — tidak ada sumbu untuk itu, dan memang tidak
   * seharusnya ada: yang dinilai adalah maknanya, bukan jenis tindakannya.
   * Jadi ia hidup di prompt.
   */
  const auto = DEFAULT_AGENTS["build-auto"]?.prompt ?? ""
  assert.match(auto, /Never stop to confirm mechanics/)
  assert.match(auto, /question/, "dan menyebut tool yang dipakai untuk bertanya")
  assert.match(auto, /MongoDB/, "dengan contoh yang bisa dikenali bentuknya")
  assert.match(
    auto,
    /if reading it resolves the conflict/,
    "membaca kode dulu, supaya ini tidak jadi izin dengan nama lain",
  )
})
