import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

/**
 * Heartbeat: satu-satunya hal yang Titah kirim tentang pekerjaanmu.
 *
 * Yang dijaga tes ini bukan "apakah requestnya terkirim" — itu bagian yang
 * mudah. Yang dijaga adalah janji-janji di sekelilingnya: tidak pernah kirim
 * tanpa login, tidak pernah menggagalkan giliran, tidak pernah menulis satu
 * byte pun ke stdout, dan angkanya sama dengan yang dilaporkan `titah stats`
 * untuk folder yang sama. Yang terakhir itu kelas bug yang berulang di repo
 * ini: yang diukur bukan yang dikirim.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-track-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "track.db")
process.env.HOME = path.join(root, "home")
delete process.env.TITAH_ACCOUNT_SERVER

const {
  buildPayload,
  isExcluded,
  markSent,
  lastSent,
  pathHash,
  sendHeartbeat,
  startTracking,
  trackingReason,
} = await import("../src/core/tracking.ts")
const { createSession, createMessage, saveMessage } = await import(
  "../src/core/storage/session.ts"
)
const { saveAccount, signOut } = await import("../src/core/account.ts")
const { collectStats } = await import("../src/core/stats.ts")
const { Config } = await import("../src/core/schema.ts")
const { bus } = await import("../src/core/event.ts")

const project = path.join(root, "proyek")
const rahasia = path.join(root, "klien", "akme")

const config = Config.parse({
  provider: {
    p: { options: { baseURL: "http://x/v1" }, models: { mahal: { price: { input: 3, output: 15 } } } },
  },
})

const off = (extra: Record<string, unknown>) => Config.parse({ tracking: extra })

const account = {
  server: "http://127.0.0.1:1",
  token: "tok_abc",
  tokenType: "Bearer",
  user: { email: "ada@example.com", name: "Ada" },
  deviceName: "ada@laptop (linux)",
  signedInAt: 1_000,
}

beforeEach(() => {
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(rahasia, { recursive: true })
  signOut()
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function record(directory: string, usage: { input: number; output: number }): string {
  const id = createSession(directory).id
  const message = createMessage(id, "assistant", [{ type: "text", text: "ok" }])
  message.model = "p/mahal"
  message.usage = usage
  saveMessage(message)
  return id
}

async function withServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += String(chunk)))
    req.on("end", () => handler(req, body, res))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

// ---------------------------------------------------------------------------
// Identitas
// ---------------------------------------------------------------------------

test("path_hash memakai kunci proyek yang sama dengan sesi lokal", () => {
  /*
   * Kalau heartbeat menormalkan path dengan caranya sendiri, `~/proj` dan
   * `~/proj/` bisa jadi DUA baris di dashboard sementara lokal keduanya satu
   * proyek yang sama. Hash-nya harus dihitung dari `projectKey`, bukan dari
   * string apa adanya.
   */
  const expected = crypto.createHash("sha256").update(path.resolve(project)).digest("hex")
  assert.equal(pathHash(project), expected)
  assert.equal(pathHash(`${project}/`), expected)
  assert.equal(pathHash(path.join(project, "..", "proyek")), expected)
})

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

test("angka payload sama persis dengan yang dilaporkan titah stats", () => {
  /*
   * Satu penggaris, bukan dua. Begitu heartbeat menghitung sendiri, angka di
   * dashboard dan angka di `titah stats` menyimpang, dan tidak ada yang tahu
   * mana yang benar sampai seseorang membandingkannya.
   */
  record(project, { input: 1_000_000, output: 100_000 })
  record(project, { input: 500_000, output: 0 })

  const stats = collectStats(config, { directory: project })
  const payload = buildPayload(config, project, "0.2.0")

  assert.equal(payload.stats.total_sessions, stats.sessions)
  assert.equal(payload.stats.total_tokens, stats.input + stats.output)
  assert.equal(payload.stats.total_cost_usd, stats.cost)
  assert.equal(payload.cli_version, "0.2.0")
})

test("nama diambil dari manifest kalau ada, kalau tidak dari nama folder", () => {
  const withManifest = path.join(root, "berman")
  fs.mkdirSync(withManifest, { recursive: true })
  fs.writeFileSync(path.join(withManifest, "package.json"), JSON.stringify({ name: "paket-nya" }))

  assert.equal(buildPayload(config, withManifest, "0.2.0").name, "paket-nya")
  assert.equal(buildPayload(config, project, "0.2.0").name, "proyek")
})

test("bahasa dikenali dari manifest, dan kosong kalau tidak ada yang cocok", () => {
  const go = path.join(root, "bahasa-go")
  fs.mkdirSync(go, { recursive: true })
  fs.writeFileSync(path.join(go, "go.mod"), "module contoh\n")

  assert.equal(buildPayload(config, go, "0.2.0").language, "go")
  assert.equal(buildPayload(config, project, "0.2.0").language, "")
})

test("folder tanpa git tidak menggagalkan payload", () => {
  /*
   * Gagal-diam ke string kosong. Folder tanpa git bukan kesalahan, dan
   * heartbeat yang batal karena `git` tidak terpasang adalah heartbeat yang
   * tidak pernah terkirim di setengah mesin.
   */
  const payload = buildPayload(config, project, "0.2.0")
  assert.equal(payload.git_remote_url, "")
  assert.equal(payload.git_branch, "")
})

test('tracking.git=false menghilangkan dua field git, sisanya tetap', () => {
  /*
   * URL remote sering menyebut nama klien, dan itu membocorkan lebih banyak
   * daripada "ada folder bernama api".
   */
  const payload = buildPayload(off({ git: false }), project, "0.2.0")
  assert.equal(payload.git_remote_url, "")
  assert.equal(payload.git_branch, "")
  assert.equal(payload.name, "proyek")
  assert.ok(payload.path_hash.length === 64)
})

// ---------------------------------------------------------------------------
// Gerbang: kapan TIDAK dikirim
// ---------------------------------------------------------------------------

test("tanpa login tidak pernah mengirim, meski enabled true", () => {
  assert.equal(trackingReason(off({ enabled: true }), project), "not-signed-in")
})

test("enabled false mematikan seluruhnya", () => {
  saveAccount(account)
  assert.equal(trackingReason(off({ enabled: false }), project), "disabled")
})

test("exclude cocok lewat glob yang sama dengan permission.allowlist", () => {
  /*
   * Satu dialek glob di seluruh config, bukan dua. Di matcher itu `*` sudah
   * melintasi `/`, jadi satu bintang cukup untuk seluruh subpohon.
   */
  saveAccount(account)
  const c = off({ enabled: true, exclude: [path.join(root, "klien", "*")] })
  assert.equal(trackingReason(c, rahasia), "excluded")
  assert.equal(trackingReason(c, project), "ok")
})

test("exclude mengekspansi ~ sebelum mencocokkan", () => {
  saveAccount(account)
  const home = process.env.HOME as string
  const di = path.join(home, "rahasia")
  fs.mkdirSync(di, { recursive: true })
  assert.equal(trackingReason(off({ enabled: true, exclude: ["~/rahasia*"] }), di), "excluded")
})

test("sudah login dan tidak dikecualikan berarti boleh kirim", () => {
  saveAccount(account)
  assert.equal(trackingReason(off({ enabled: true }), project), "ok")
})

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

test("debounce bertahan lintas proses, karena tersimpan di SQLite", () => {
  /*
   * `titah run` adalah SATU PROSES per giliran. Debounce di memori tidak akan
   * pernah menyala di sana — skrip yang memanggil `titah run` seratus kali
   * mengirim seratus request. Yang menyimpannya harus tempat yang dibaca
   * proses berikutnya.
   */
  const dir = path.join(root, "debounce")
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(lastSent(pathHash(dir)), undefined)
  markSent(pathHash(dir), 10_000)
  assert.equal(lastSent(pathHash(dir)), 10_000)
  markSent(pathHash(dir), 20_000)
  assert.equal(lastSent(pathHash(dir)), 20_000)
})

test("giliran kedua di dalam jendela tidak mengirim, sesudahnya mengirim", async () => {
  saveAccount({ ...account, server: "http://127.0.0.1:1" })
  const dir = path.join(root, "jendela")
  fs.mkdirSync(dir, { recursive: true })

  let hits = 0
  await withServer(
    (_req, _body, res) => {
      hits += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    },
    async (origin) => {
      saveAccount({ ...account, server: origin })
      const c = off({ enabled: true })
      assert.equal(await sendHeartbeat(c, dir, "0.2.0", 0), true)
      assert.equal(await sendHeartbeat(c, dir, "0.2.0", 60_000), false)
      assert.equal(await sendHeartbeat(c, dir, "0.2.0", 5 * 60_000 + 1), true)
    },
  )
  assert.equal(hits, 2)
})

// ---------------------------------------------------------------------------
// Bentuk request
// ---------------------------------------------------------------------------

test("mengirim POST ber-Bearer ke endpoint heartbeat", async () => {
  const dir = path.join(root, "kirim")
  fs.mkdirSync(dir, { recursive: true })

  let seen: { url?: string; method?: string; auth?: string; body?: unknown } = {}
  await withServer(
    (req, body, res) => {
      seen = {
        url: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization ?? "",
        body: JSON.parse(body),
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    },
    async (origin) => {
      saveAccount({ ...account, server: origin })
      await sendHeartbeat(off({ enabled: true }), dir, "0.2.0", 0)
    },
  )

  assert.equal(seen.url, "/api/projects/heartbeat/")
  assert.equal(seen.method, "POST")
  assert.equal(seen.auth, "Bearer tok_abc")
  const body = seen.body as Record<string, unknown>
  assert.equal(body["cli_version"], "0.2.0")
  assert.equal(body["name"], "kirim")
  assert.ok(typeof body["path_hash"] === "string")
})

// ---------------------------------------------------------------------------
// Kegagalan tidak boleh terasa
// ---------------------------------------------------------------------------

test("server yang menolak tidak melempar", async () => {
  const dir = path.join(root, "tolak")
  fs.mkdirSync(dir, { recursive: true })
  await withServer(
    (_req, _body, res) => {
      res.writeHead(500)
      res.end("meledak")
    },
    async (origin) => {
      saveAccount({ ...account, server: origin })
      assert.equal(await sendHeartbeat(off({ enabled: true }), dir, "0.2.0", 0), false)
    },
  )
})

test("server yang tidak ada tidak melempar", async () => {
  const dir = path.join(root, "mati")
  fs.mkdirSync(dir, { recursive: true })
  saveAccount({ ...account, server: "http://127.0.0.1:1" })
  assert.equal(await sendHeartbeat(off({ enabled: true }), dir, "0.2.0", 0), false)
})

test("tidak menulis satu byte pun ke stdout maupun stderr", async () => {
  /*
   * `titah run --output-format json` menjanjikan tidak ada apa pun untuk
   * manusia di stdout. Satu baris "heartbeat sent" merusak JSON.parse milik
   * pemanggil, dan pemanggilnya tidak punya cara menebak bahwa yang salah
   * adalah barisnya, bukan datanya. stderr pun mengganggu skrip yang
   * menggabungkan keduanya.
   */
  const dir = path.join(root, "senyap")
  fs.mkdirSync(dir, { recursive: true })

  const keluar: string[] = []
  const asliOut = process.stdout.write.bind(process.stdout)
  const asliErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string) => (keluar.push(String(chunk)), true)) as never
  process.stderr.write = ((chunk: string) => (keluar.push(String(chunk)), true)) as never
  try {
    saveAccount({ ...account, server: "http://127.0.0.1:1" })
    await sendHeartbeat(off({ enabled: true }), dir, "0.2.0", 0)
  } finally {
    process.stdout.write = asliOut as never
    process.stderr.write = asliErr as never
  }
  assert.deepEqual(keluar, [])
})

test("kegagalan tetap meninggalkan satu baris di log", async () => {
  const dir = path.join(root, "logkan")
  fs.mkdirSync(dir, { recursive: true })
  saveAccount({ ...account, server: "http://127.0.0.1:1" })
  await sendHeartbeat(off({ enabled: true }), dir, "0.2.0", 0)

  const file = path.join(process.env.XDG_CONFIG_HOME as string, "titah", "tracking.log")
  assert.ok(fs.existsSync(file), "log tracking harus dibuat")
  assert.match(fs.readFileSync(file, "utf8"), /logkan|gagal|error|failed/i)
})

// ---------------------------------------------------------------------------
// Bus: pelanggan tracking BUKAN klien
// ---------------------------------------------------------------------------

test("pelanggan non-klien tidak dihitung sebagai yang bisa menjawab izin", () => {
  /*
   * `listenerCount` menjawab "berapa klien yang bisa menjawab dialog izin",
   * dan permission engine memakainya untuk tolak-otomatis (Q17). Pelanggan
   * tracking bukan klien: ia tidak bisa menjawab apa pun. Kalau ia ikut
   * dihitung, `titah run` di CI berhenti menolak-otomatis dan menggantung
   * menunggu jawaban yang tidak akan pernah datang.
   */
  const controller = new AbortController()
  const stream = bus.subscribe({ signal: controller.signal, client: false })
  void stream

  assert.equal(bus.listenerCount("ses_apa_saja"), 0)

  const klien = new AbortController()
  void bus.subscribe({ signal: klien.signal })
  assert.equal(bus.listenerCount("ses_apa_saja"), 1)

  controller.abort()
  klien.abort()
})

// ---------------------------------------------------------------------------
// Flush: `titah run` keluar begitu gilirannya selesai
// ---------------------------------------------------------------------------

test("flush menyerah setelah batasnya, bukan menahan proses keluar", async () => {
  /*
   * Tanpa batas, satu server yang menggantung menahan keluarnya `titah run`
   * selama timeout penuh. Batasnya dilewati berarti prosesnya jalan terus —
   * requestnya mungkin tetap sampai, dan kalau tidak, heartbeat berikutnya
   * membawa angka kumulatif yang sama lengkapnya.
   */
  const dir = path.join(root, "flush")
  fs.mkdirSync(dir, { recursive: true })
  saveAccount({ ...account, server: "http://127.0.0.1:1" })

  const tracker = startTracking(off({ enabled: true }), "0.2.0")
  try {
    const mulai = Date.now()
    await tracker.flush(50)
    assert.ok(Date.now() - mulai < 1_000, "flush tidak boleh menunggu lebih lama dari batasnya")
  } finally {
    tracker.stop()
  }
})

test("flush tanpa pengiriman berjalan selesai seketika", async () => {
  const tracker = startTracking(off({ enabled: true }), "0.2.0")
  try {
    const mulai = Date.now()
    await tracker.flush(5_000)
    assert.ok(Date.now() - mulai < 200, "tidak ada yang ditunggu, jadi tidak boleh menunggu")
  } finally {
    tracker.stop()
  }
})
