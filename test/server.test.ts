import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before, after } from "node:test"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-server-"))
process.env.XDG_DATA_HOME = root
process.env.TITAH_DB = path.join(root, "server.db")
// Pesan yang diposting di sini kebetulan semuanya `/agents`, yang berhenti
// sebelum buildSystemPrompt — tapi satu pesan biasa saja sudah cukup untuk
// membuat berkas ini memindai 56 skill milik siapa pun yang menjalankannya.
// HOME diisolasi karena os.homedir() membaca $HOME langsung, melewati XDG;
// XDG_CONFIG_HOME karena loadConfig di sini kalau tidak akan membaca
// titah.json global pengembang.
process.env.HOME = path.join(root, "home")
process.env.XDG_CONFIG_HOME = path.join(root, "config")

const { listen } = await import("../src/server/index.ts")
const { bus } = await import("../src/core/event.ts")
const { setModelResolver } = await import("../src/core/agent.ts")
const { listMessages } = await import("../src/core/storage/session.ts")

let base: string
let close: () => Promise<void>

before(async () => {
  const handle = await listen("test", 0, "127.0.0.1")
  base = handle.url
  close = handle.close
})

after(async () => {
  await close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function api(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
}

test("GET /health melaporkan versi dan pid", async () => {
  const response = await api("GET", "/health")
  assert.equal(response.status, 200)
  const body = (await response.json()) as { status: string; version: string; pid: number }
  assert.equal(body.status, "ok")
  assert.equal(body.version, "test")
  assert.equal(body.pid, process.pid)
})

test("POST /session membuat sesi, GET /session mendaftarnya", async () => {
  const created = await api("POST", "/session", { directory: "/tmp/proyek", title: "uji" })
  assert.equal(created.status, 201)
  const session = (await created.json()) as { id: string; directory: string }
  assert.match(session.id, /^ses_/)
  assert.equal(session.directory, "/tmp/proyek")

  // Sesi kosong sengaja TIDAK didaftar — baru muncul setelah ada percakapan.
  const kosong = (await (await api("GET", "/session")).json()) as { id: string }[]
  assert.ok(!kosong.some((entry) => entry.id === session.id))

  await api("POST", `/session/${session.id}/message`, { text: "/agents" })
  const list = (await (await api("GET", "/session")).json()) as { id: string }[]
  assert.ok(list.some((entry) => entry.id === session.id))
})

test("POST /session/:id/discard membuang yang kosong, menolak yang ada isinya", async () => {
  const kosong = (await (await api("POST", "/session", { directory: "/tmp/p" })).json()) as {
    id: string
  }
  const dibuang = (await (await api("POST", `/session/${kosong.id}/discard`)).json()) as {
    discarded: boolean
  }
  assert.equal(dibuang.discarded, true)
  assert.equal((await api("GET", `/session/${kosong.id}`)).status, 404)

  const isi = (await (await api("POST", "/session", { directory: "/tmp/p" })).json()) as {
    id: string
  }
  await api("POST", `/session/${isi.id}/message`, { text: "/agents" })
  const ditolak = (await (await api("POST", `/session/${isi.id}/discard`)).json()) as {
    discarded: boolean
  }
  assert.equal(ditolak.discarded, false, "percakapan sungguhan tidak boleh terbuang")
  assert.equal((await api("GET", `/session/${isi.id}`)).status, 200)
})

test("sesi yang tidak ada menghasilkan 404, bukan 500", async () => {
  const response = await api("GET", "/session/ses_tidak-ada")
  assert.equal(response.status, 404)
  const body = (await response.json()) as { error: string }
  assert.match(body.error, /not found/)
})

test("rute tak dikenal menghasilkan 404 dengan pesan yang menyebut path", async () => {
  const response = await api("GET", "/entah")
  assert.equal(response.status, 404)
  assert.match(((await response.json()) as { error: string }).error, /\/entah/)
})

test("method yang salah menghasilkan 405", async () => {
  const response = await api("PATCH", "/session")
  assert.equal(response.status, 405)
})

test("POST message tanpa text ditolak 400", async () => {
  const session = (await (await api("POST", "/session", {})).json()) as { id: string }
  const response = await api("POST", `/session/${session.id}/message`, { text: "   " })
  assert.equal(response.status, 400)
})

test("body JSON rusak ditolak 400, tidak membuat server tumbang", async () => {
  const session = (await (await api("POST", "/session", {})).json()) as { id: string }
  const response = await fetch(`${base}/session/${session.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ rusak",
  })
  assert.equal(response.status, 400)

  assert.equal((await api("GET", "/health")).status, 200, "server harus tetap hidup")
})

test("DELETE /session/:id menghapus sesi", async () => {
  const session = (await (await api("POST", "/session", {})).json()) as { id: string }
  const deleted = await api("DELETE", `/session/${session.id}`)
  assert.deepEqual(await deleted.json(), { deleted: true })
  assert.equal((await api("GET", `/session/${session.id}`)).status, 404)
})

test("abort pada sesi yang tidak sedang jalan mengembalikan false, bukan error", async () => {
  const session = (await (await api("POST", "/session", {})).json()) as { id: string }
  const response = await api("POST", `/session/${session.id}/abort`)
  assert.deepEqual(await response.json(), { aborted: false })
})

test("GET /event menstream event bus sebagai SSE", async () => {
  const session = (await (await api("POST", "/session", {})).json()) as { id: string }
  const controller = new AbortController()

  const response = await fetch(`${base}/event?session=${session.id}`, {
    signal: controller.signal,
  })
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8")

  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  // Baca sampai handshake ": terhubung" masuk, supaya publish di bawah tidak lolos.
  let buffer = decoder.decode((await reader.read()).value)
  bus.publish({ type: "session.idle", sessionID: session.id })

  while (!buffer.includes("event: session.idle")) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value)
  }

  assert.match(buffer, /event: session\.idle/)
  assert.match(buffer, new RegExp(session.id))
  controller.abort()
})

test("GET /event dengan filter sesi tidak menerima event sesi lain", async () => {
  const mine = (await (await api("POST", "/session", {})).json()) as { id: string }
  const controller = new AbortController()

  const response = await fetch(`${base}/event?session=${mine.id}`, { signal: controller.signal })
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = decoder.decode((await reader.read()).value)

  bus.publish({ type: "session.idle", sessionID: "ses_orang-lain" })
  bus.publish({ type: "session.idle", sessionID: mine.id })

  while (!buffer.includes("event: session.idle")) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value)
  }

  assert.doesNotMatch(buffer, /ses_orang-lain/)
  controller.abort()
})

test("GET /session?directory= hanya mengembalikan sesi proyek itu", async () => {
  const a = (await (await api("POST", "/session", { directory: "/tmp/alfa" })).json()) as {
    id: string
  }
  const b = (await (await api("POST", "/session", { directory: "/tmp/beta" })).json()) as {
    id: string
  }
  await api("POST", `/session/${a.id}/message`, { text: "/agents" })
  await api("POST", `/session/${b.id}/message`, { text: "/agents" })

  const alfa = (await (
    await api("GET", `/session?directory=${encodeURIComponent("/tmp/alfa")}`)
  ).json()) as { id: string }[]
  assert.ok(alfa.some((entry) => entry.id === a.id))
  assert.ok(!alfa.some((entry) => entry.id === b.id))

  const semua = (await (await api("GET", "/session")).json()) as { id: string }[]
  assert.ok(semua.some((entry) => entry.id === a.id))
  assert.ok(semua.some((entry) => entry.id === b.id))
})


test("GET /session/:id/children mendaftar sesi anak, dan sesi anak TIDAK muncul di /session", async () => {
  /*
   * Dua sifat sekaligus, dan keduanya harus benar bersamaan.
   *
   * Sesi anak sengaja disembunyikan dari daftar sesi biasa — memilihnya di sana
   * akan MENGGANTI sesi aktif, dan prompt berikutnya ikut masuk ke sesi milik
   * sub-agent. Tapi menyembunyikannya saja membuat pekerjaannya tidak punya satu
   * pun jalan masuk; rute ini yang menyediakannya.
   */
  const { createChildSession } = await import("../src/core/storage/session.ts")

  const parent = (await (await api("POST", "/session", { directory: "/tmp/anak" })).json()) as {
    id: string
  }
  await api("POST", `/session/${parent.id}/message`, { text: "/agents" })

  assert.deepEqual(
    (await (await api("GET", `/session/${parent.id}/children`)).json()),
    [],
    "belum ada sub-agent yang jalan",
  )

  const child = createChildSession(parent.id, "/tmp/anak", "explore")

  const children = (await (await api("GET", `/session/${parent.id}/children`)).json()) as {
    id: string
    title: string
    parentID?: string
  }[]
  assert.equal(children.length, 1)
  assert.equal(children[0]?.id, child.id)
  assert.equal(children[0]?.title, "explore", "judulnya adalah nama agent-nya")
  assert.equal(children[0]?.parentID, parent.id)

  const daftar = (await (await api("GET", "/session")).json()) as { id: string }[]
  assert.ok(
    !daftar.some((entry) => entry.id === child.id),
    "sesi anak tidak boleh bisa dipilih sebagai sesi aktif",
  )
})

test("GET /session/:id/children pada sesi yang tidak ada tetap 404", async () => {
  // Rute baru mewarisi penjaga yang sama dengan saudara-saudaranya: id yang
  // tidak dikenal dijawab 404, bukan daftar kosong yang terbaca seperti
  // "sesinya ada, sub-agent-nya belum".
  assert.equal((await api("GET", "/session/ses_tidak_ada/children")).status, 404)
})

/*
 * Satu-satunya hal yang membedakan giliran interaktif dari yang tidak adalah
 * apakah ia dilanjutkan, jadi itulah yang diamati: model yang menulis rencana
 * berbutir terbuka lalu terus membaca. Menangkap `PromptInput` langsung tidak
 * mungkin dari luar proses server, dan test yang hanya memeriksa body yang
 * dikirim tidak akan tahu kalau salah satu dari DUA panggilan `prompt` di rute
 * ini lupa meneruskannya.
 */
async function assistantTurns(opts: { interactive?: boolean; stream: boolean }): Promise<number> {
  const project = path.join(root, `proyek-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi\n")
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [] },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow" },
      agent: { pendek: { mode: "primary", steps: 2 } },
    }),
  )
  const created = await api("POST", "/session", { directory: project })
  const session = (await created.json()) as { id: string }
  const usage = {
    inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  }
  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls += 1
      // Rencana ditulis di DALAM giliran: yang lebih tua dari pesan user dianggap usang.
      if (calls === 1) {
        const { savePlan } = await import("../src/core/storage/session.ts")
        savePlan(session.id, "- [ ] satu\n- [ ] dua")
      }
      const chunks =
        (options.tools ?? []).length > 0
          ? [
              { type: "stream-start" as const, warnings: [] },
              { type: "tool-call" as const, toolCallId: `c${calls}`, toolName: "read", input: JSON.stringify({ path: "a.txt" }) },
              { type: "finish" as const, finishReason: "tool-calls" as const, usage },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "mentok" },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: "stop" as const, usage },
            ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  const restore = setModelResolver(() => model)
  try {
    const res = await fetch(`${base}/session/${session.id}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.stream ? { accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        text: "kerjakan",
        agent: "pendek",
        ...(opts.interactive === undefined ? {} : { interactive: opts.interactive }),
      }),
    })
    await res.text()
  } finally {
    restore()
  }
  return listMessages(session.id).filter((message) => message.role === "assistant").length
}

test("POST message dengan interactive:true diteruskan ke giliran (non-stream)", async () => {
  assert.ok((await assistantTurns({ interactive: true, stream: false })) > 1, "giliran yang mentok dilanjutkan")
})

test("POST message dengan interactive:true diteruskan ke giliran (stream)", async () => {
  assert.ok((await assistantTurns({ interactive: true, stream: true })) > 1, "giliran yang mentok dilanjutkan")
})

test("POST message tanpa interactive tidak melanjutkan giliran yang mentok", async () => {
  assert.equal(await assistantTurns({ stream: false }), 1)
  assert.equal(await assistantTurns({ stream: true }), 1)
})

test("titah run tidak menandai dirinya interaktif", () => {
  /*
   * Membaca sumber, bukan memata-matai: `titah run` memanggil `prompt()` dalam
   * proses dan memanggil `process.exit` sesudahnya, jadi tidak ada seam untuk
   * menangkap PromptInput tanpa menjalankan CLI utuh. Bawaan lanjut-sampai-
   * selesai harus tetap mati di sini; tidak ada yang bisa menekan Esc.
   */
  const source = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  const blocks = [...source.matchAll(/\bprompt\(\{[\s\S]*?\n  \}\)/g)].map((match) => match[0])
  assert.ok(blocks.length > 0, "blok prompt({ ... }) ditemukan di cli.ts")
  for (const block of blocks) assert.doesNotMatch(block, /interactive/)
})
