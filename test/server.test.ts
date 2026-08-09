import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before, after } from "node:test"

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
