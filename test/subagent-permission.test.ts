import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import type { Event } from "../src/core/event.ts"
import type { PermissionDecision } from "../src/core/permission.ts"

/**
 * Fix round 1 (review Task 8): dua Critical dan tiga Important, semua tentang
 * apakah dialog izin sub-agent SUNGGUH sampai ke klien dan apakah jawaban
 * "always"-nya bukan celah keamanan. `test/permission.test.ts` sudah menguji
 * mekanismenya di `permission.ts` lewat API publik, tapi tidak menguji
 * PENGKABELAN di `agent.ts` — `prompt()` menghitung `allowlistSessionID` dan
 * `streamSessionID`-nya sendiri dari state sesi tersimpan, dan test itu tidak
 * pernah menjalankan `prompt()` sungguhan. File ini menutup celah itu: setiap
 * test di sini mendorong giliran SUNGGUHAN lewat `prompt()`/`runSubagent()`,
 * dengan model tiruan, persis pola `test/subagent-run.test.ts`.
 */

// Isolasi HOME/XDG SEBELUM modul apa pun diimpor — lihat catatan yang sama di
// test/subagent-run.test.ts dan test/agent-write.test.ts.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-subagent-perm-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "subagent-perm.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { runSubagent } = await import("../src/core/subagent.ts")
const { createSession } = await import("../src/core/storage/session.ts")
const { Config } = await import("../src/core/schema.ts")
const { bus } = await import("../src/core/event.ts")
const { respond, clearSession } = await import("../src/core/permission.ts")

const project = path.join(root, "proyek")

before(() => {
  fs.mkdirSync(project, { recursive: true })
  // Disk HARUS sejalan dengan `configWithWriter()` di bawah — giliran anak
  // memuat config-nya SENDIRI dari sini lewat `loadConfig`, terlepas dari
  // config in-memory yang dikirim ke `runSubagent`. Lihat catatan yang sama
  // di test/subagent-run.test.ts.
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({ agent: { writer: { mode: "subagent" } } }),
  )
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function configWithWriter() {
  return Config.parse({ agent: { writer: { mode: "subagent" } } })
}

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
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

function call(toolName: string, input: unknown, id = "c1"): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage: USAGE },
  ]
}

/**
 * Satu model tiruan untuk SELURUH test: `resolver` global (lihat
 * `setModelResolver`) tidak dibedakan berdasarkan sesi mana yang memanggilnya,
 * jadi induk dan anak memakai INSTANCE YANG SAMA — cocok, karena panggilan
 * `doStream` toh selalu berurutan (setiap langkah di-`await` sebelum langkah
 * berikutnya diminta, termasuk seluruh giliran anak yang berjalan di dalam
 * satu eksekusi tool `task` milik induk).
 */
function mock(steps: LanguageModelV4StreamPart[][]): { restore: () => void } {
  let index = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(index, steps.length - 1)] as LanguageModelV4StreamPart[]
      index += 1
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  return { restore: setModelResolver(() => model) }
}

/**
 * Klien tiruan yang berlangganan SATU sesi dan menjawab dialog izin dari
 * antrean `queue`, dalam urutan kemunculan. Kalau antrean kosong saat dialog
 * datang, jawab "reject" — gagal aman, bukan menggantung test selamanya.
 */
function attachClient(sessionID: string) {
  const events: Event[] = []
  const queue: PermissionDecision[] = []
  const controller = new AbortController()
  const stream = bus.subscribe({ sessionID, signal: controller.signal })
  const pump = (async () => {
    for await (const event of stream) {
      events.push(event)
      if (event.type === "permission.request") {
        respond(event.request.id, queue.shift() ?? "reject")
      }
    }
  })()
  return {
    events,
    queue,
    stop: async () => {
      controller.abort()
      await pump
    },
  }
}

const permissionRequests = (events: Event[]) =>
  events.filter((event): event is Extract<Event, { type: "permission.request" }> =>
    event.type === "permission.request",
  )

test("izin sub-agent disiarkan ke stream INDUK dengan nama agent, dan tidak auto-deny", async () => {
  // Ini pengukuran Critical 2: klien HANYA berlangganan sesi induk — persis
  // seperti client.events(session.id, …) di src/tui/app.tsx — dan giliran
  // anak harus tetap sampai ke sana, bukan ke id sesi anaknya sendiri yang
  // tidak pernah didengarkan siapa pun.
  const parent = createSession(project)
  const client = attachClient(parent.id)
  client.queue.push("once")

  const { restore } = mock([call("write", { path: "keluar.txt", content: "hai\n" }), text("selesai")])
  try {
    assert.equal(bus.listenerCount(parent.id), 1, "klien harus terhitung pada stream INDUK")

    const result = await runSubagent({
      parentSessionID: parent.id,
      agentID: "writer",
      instruction: "buat file",
      cwd: project,
      config: configWithWriter(),
      signal: new AbortController().signal,
    })

    // Diukur SETELAH giliran anak berjalan: id anak tidak pernah didengarkan
    // siapa pun — kalau kode balik ke rute lama (routing ke id anak sendiri),
    // baris ini masih true, tapi baris di bawahnya (dialog benar-benar
    // sampai & tool benar-benar jalan) akan gagal.
    assert.equal(bus.listenerCount(result.childSessionID), 0)

    assert.equal(result.status, "done")
    assert.equal(fs.readFileSync(path.join(project, "keluar.txt"), "utf8"), "hai\n")

    const requests = permissionRequests(client.events)
    assert.equal(requests.length, 1, "harus persis satu dialog, dan klien induk harus melihatnya")
    assert.equal(requests[0]?.sessionID, parent.id, "event harus disiarkan ke id INDUK")
    assert.equal(requests[0]?.request.agent, "writer", "dialog harus menyebut nama agent yang bertanya")
  } finally {
    restore()
    await client.stop()
    clearSession(parent.id)
  }
})

test('jawaban "always" satu sub-agent lolos ke sub-agent LAIN pada giliran yang sama, tanpa dialog kedua', async () => {
  // Ini pembeda mutasi Important 1: kalau `prompt()` menghitung
  // `allowlistSessionID` dari sesi anak sendiri (bukan `parentID`-nya),
  // sub-agent KEDUA ini tidak akan pernah lolos lewat allowlist — ia akan
  // memicu dialog kedua yang kita jawab "reject" di bawah, dan assertion
  // filenya akan gagal.
  const parent = createSession(project)
  const client = attachClient(parent.id)
  client.queue.push("always", "reject")

  const { restore } = mock([
    call("write", { path: "satu.txt", content: "a\n" }),
    text("satu selesai"),
    call("write", { path: "dua.txt", content: "b\n" }),
    text("dua selesai"),
  ])
  try {
    const pertama = await runSubagent({
      parentSessionID: parent.id,
      agentID: "writer",
      instruction: "tulis satu",
      cwd: project,
      config: configWithWriter(),
      signal: new AbortController().signal,
    })
    const kedua = await runSubagent({
      parentSessionID: parent.id,
      agentID: "writer",
      instruction: "tulis dua",
      cwd: project,
      config: configWithWriter(),
      signal: new AbortController().signal,
    })

    assert.equal(pertama.status, "done")
    assert.equal(kedua.status, "done")
    assert.equal(fs.readFileSync(path.join(project, "satu.txt"), "utf8"), "a\n")
    assert.equal(
      fs.readFileSync(path.join(project, "dua.txt"), "utf8"),
      "b\n",
      "sub-agent kedua harus lolos lewat allowlist milik INDUK, tanpa dialog sendiri",
    )
    assert.equal(
      permissionRequests(client.events).length,
      1,
      "hanya sub-agent PERTAMA yang bertanya — jawaban 'always'-nya menutup giliran ini",
    )
  } finally {
    restore()
    await client.stop()
    clearSession(parent.id)
  }
})

test(
  '"always" dari sub-agent tidak bertahan lewat giliran induk, tapi "always" milik induk sendiri bertahan',
  async () => {
    // Ini Critical 1, ujung ke ujung. Dua pola BERBEDA dipakai supaya tidak
    // saling menutupi: "edit" dijawab langsung oleh INDUK sendiri (harus
    // permanen, lintas giliran — perilaku ini sudah ada sebelum fitur
    // sub-agent), "write" dijawab oleh SUB-AGENT di tengah satu giliran induk
    // (harus hilang begitu giliran itu berakhir).
    fs.writeFileSync(path.join(project, "seed.ts"), "export const nilai = 1\n")

    const parent = createSession(project)
    const client = attachClient(parent.id)

    const { restore } = mock([
      // Giliran 1 — INDUK sendiri mengedit dan menjawab "always" untuk "edit".
      call("edit", { path: "seed.ts", oldString: "nilai = 1", newString: "nilai = 2" }),
      text("sudah diubah"),
      // Giliran 2 — INDUK men-dispatch sub-agent lewat tool `task`. Sub-agent
      // menulis file dan menjawab "always" untuk "write" — HANYA berlaku
      // sampai giliran 2 berakhir.
      call("task", { agent: "writer", instruction: "tulis file" }),
      call("write", { path: "anak.txt", content: "dari sub-agent\n" }),
      text("sub-agent selesai"),
      text("induk selesai"),
      // Sub-agent BERDIRI SENDIRI setelah giliran 2 berakhir — kalau grant
      // "write" ikut terhapus (yang benar), tool ini ditolak dan file di
      // bawah tidak pernah tertulis.
      call("write", { path: "anak2.txt", content: "dari sub-agent lain\n" }),
      text("sub-agent lain selesai"),
      // Giliran 4 — INDUK mengedit lagi. Harus lolos lewat grant PERMANEN
      // dari giliran 1, tanpa dialog baru.
      call("edit", { path: "seed.ts", oldString: "nilai = 2", newString: "nilai = 3" }),
      text("sudah diubah lagi"),
    ])
    try {
      client.queue.push("always")
      const turn1 = await prompt({ sessionID: parent.id, text: "ubah nilai jadi 2" })
      assert.equal(turn1.error, undefined)
      assert.match(fs.readFileSync(path.join(project, "seed.ts"), "utf8"), /nilai = 2/)

      client.queue.push("always")
      const turn2 = await prompt({ sessionID: parent.id, text: "delegasikan ke sub-agent" })
      assert.equal(turn2.error, undefined)
      assert.equal(
        fs.readFileSync(path.join(project, "anak.txt"), "utf8"),
        "dari sub-agent\n",
        "tool tulis sub-agent harus benar-benar jalan setelah dijawab 'always'",
      )

      // Giliran induk (turn2) sudah SELESAI di titik ini — `prompt()` sudah
      // resolve, jadi `finally`-nya (termasuk `clearTurn`) sudah jalan.
      // Sub-agent BERDIRI SENDIRI berikutnya tidak boleh lagi mewarisi grant
      // "write" milik sub-agent sebelumnya.
      client.queue.push("reject")
      const setelahGiliranBerakhir = await runSubagent({
        parentSessionID: parent.id,
        agentID: "writer",
        instruction: "tulis file lain",
        cwd: project,
        config: configWithWriter(),
        signal: new AbortController().signal,
      })
      assert.equal(
        fs.existsSync(path.join(project, "anak2.txt")),
        false,
        "grant 'write' turun-temurun sub-agent seharusnya sudah hilang setelah giliran induk berakhir",
      )
      /*
       * `failed`, bukan `done` — dan itu perubahan yang disengaja.
       *
       * Gilirannya memang selesai tanpa error, dan komentar lama di sini
       * menyebutnya "selesai normal, cuma tool-nya ditolak". Tapi sub-agent
       * yang SETIAP tool call-nya ditolak tidak mengerjakan apa pun, dan glyph
       * sukses di atasnya membuat koordinator membangun langkah berikutnya di
       * atas pekerjaan yang tidak pernah terjadi.
       *
       * Yang diuji test ini tetap sama: `anak2.txt` tidak dibuat. Statusnya
       * kebetulan ikut, dan sekarang ikut dengan nilai yang benar.
       */
      assert.equal(
        setelahGiliranBerakhir.status,
        "failed",
        "semua tool-nya ditolak, jadi ia tidak mengerjakan apa pun",
      )

      // Giliran 4 — INDUK sendiri mengedit lagi. Harus lolos TANPA dialog:
      // grant permanennya (dari giliran 1) tidak boleh ikut terhapus oleh
      // `clearTurn` yang berjalan di antara giliran 1 dan sekarang.
      const before = permissionRequests(client.events).length
      const turn4 = await prompt({ sessionID: parent.id, text: "ubah nilai jadi 3" })
      assert.equal(turn4.error, undefined)
      assert.match(fs.readFileSync(path.join(project, "seed.ts"), "utf8"), /nilai = 3/)
      assert.equal(
        permissionRequests(client.events).length,
        before,
        "grant permanen milik induk sendiri harus tetap berlaku, tanpa dialog baru",
      )

      assert.equal(
        permissionRequests(client.events).length,
        3,
        "tepat tiga dialog sepanjang test: edit induk, write sub-agent, write sub-agent berikutnya yang ditolak",
      )
    } finally {
      restore()
      await client.stop()
      clearSession(parent.id)
    }
  },
)

test("--auto pada giliran induk membebaskan tool sub-agent dari dialog juga", async () => {
  // Important 2: `setAutoApprove` hanya pernah dipanggil untuk sesi TOP-LEVEL
  // yang membawa `--auto` (`runSubagent` tidak pernah mengirim `auto` ke
  // `prompt()` anaknya). Tanpa pengecekan `--auto` mengikuti aturan
  // parent-scoped yang sama dengan allowlist, tulisan pertama sub-agent jatuh
  // ke pengecekan listener lalu ditolak — persis kebalikan dari yang
  // dimaksudkan `--auto`.
  const parent = createSession(project)
  const client = attachClient(parent.id)

  const { restore } = mock([
    call("task", { agent: "writer", instruction: "tulis file" }),
    call("write", { path: "auto.txt", content: "otomatis\n" }),
    text("sub-agent selesai"),
    text("induk selesai"),
  ])
  try {
    const turn = await prompt({ sessionID: parent.id, text: "delegasikan dengan auto", auto: true })
    assert.equal(turn.error, undefined)
    assert.equal(fs.readFileSync(path.join(project, "auto.txt"), "utf8"), "otomatis\n")
    assert.equal(
      permissionRequests(client.events).length,
      0,
      "--auto milik induk harus membebaskan tool sub-agent dari dialog juga, tanpa satu pun dialog",
    )
  } finally {
    restore()
    await client.stop()
    clearSession(parent.id)
  }
})
