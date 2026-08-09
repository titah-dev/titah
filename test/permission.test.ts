import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import {
  ask,
  clearSession,
  effectivePermission,
  listPending,
  matchesPattern,
  respond,
  setAutoApprove,
} from "../src/core/permission.ts"
import { Agent, Config, DEFAULT_AGENTS } from "../src/core/schema.ts"

/** Izin efektif dari config global saja, tanpa agent. */
const base = (overrides: Record<string, unknown> = {}) =>
  effectivePermission(
    Config.parse({
      permission: { edit: "ask", write: "ask", bash: "ask", allowlist: [], ...overrides },
    }),
  )

let session = 0
const nextSession = () => `ses_perm_${(session += 1)}`

afterEach(() => {
  for (let i = 1; i <= session; i += 1) clearSession(`ses_perm_${i}`)
})

const request = (sessionID: string, permission = base(), listeners = 1) =>
  ask({
    sessionID,
    permission,
    kind: "bash",
    title: "bash: git status",
    detail: "git status",
    pattern: "git *",
    listeners,
  })

test("matchesPattern menangani wildcard tanpa bocor ke regex", () => {
  assert.equal(matchesPattern("git *", "git status"), true)
  assert.equal(matchesPattern("git *", "gitk"), false)
  assert.equal(matchesPattern("npm test", "npm test"), true)
  assert.equal(matchesPattern("npm test", "npm test -- --watch"), false)
  // Titik harus literal, bukan "karakter apa saja".
  assert.equal(matchesPattern("a.b", "axb"), false)
})

test("tanpa klien terhubung, izin ditolak otomatis dan alasannya jelas", async () => {
  const id = nextSession()
  const result = await request(id, base(), 0)

  assert.equal(result.granted, false)
  assert.match(result.reason, /no client is connected/i)
  assert.match(result.reason, /--auto/, "harus menunjukkan jalan keluar yang benar")
  assert.deepEqual(listPending(id), [], "tidak boleh meninggalkan permintaan menggantung")
})

test('config "deny" menolak tanpa bertanya, meski ada klien', async () => {
  const result = await request(nextSession(), base({ bash: "deny" }), 5)
  assert.equal(result.granted, false)
  assert.match(result.reason, /config/)
})

test('config "allow" mengizinkan tanpa bertanya', async () => {
  const result = await request(nextSession(), base({ bash: "allow" }), 0)
  assert.equal(result.granted, true)
})

test("allowlist di config mengizinkan tanpa dialog", async () => {
  const result = await request(nextSession(), base({ allowlist: ["git *"] }), 0)
  assert.equal(result.granted, true)
  assert.match(result.reason, /allowlist/)
})

test("mode --auto mengizinkan, tapi tidak menembus config deny", async () => {
  const id = nextSession()
  setAutoApprove(id, true)

  assert.equal((await request(id, base(), 0)).granted, true)
  assert.equal(
    (await request(id, base({ bash: "deny" }), 0)).granted,
    false,
    "config deny harus tetap menang atas --auto",
  )
})

test('jawaban "once" mengizinkan sekali saja', async () => {
  const id = nextSession()
  const pending = request(id)

  await new Promise((resolve) => setTimeout(resolve, 10))
  const [outstanding] = listPending(id)
  assert.ok(outstanding, "permintaan harus terdaftar sambil menunggu jawaban")
  assert.equal(respond(outstanding.id, "once"), true)
  assert.equal((await pending).granted, true)

  // Permintaan berikutnya harus bertanya lagi.
  const kedua = request(id)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(listPending(id).length, 1, "harus bertanya lagi setelah jawaban 'once'")
  respond(listPending(id)[0]?.id as string, "reject")
  assert.equal((await kedua).granted, false)
})

test('jawaban "always" mengingat polanya untuk sesi itu saja', async () => {
  const id = nextSession()
  const lain = nextSession()

  const pending = request(id)
  await new Promise((resolve) => setTimeout(resolve, 10))
  respond(listPending(id)[0]?.id as string, "always")
  assert.equal((await pending).granted, true)

  // Perintah git berikutnya lolos tanpa dialog.
  const kedua = await ask({
    sessionID: id,
    permission: base(),
    kind: "bash",
    title: "bash: git diff",
    detail: "git diff",
    pattern: "git *",
    listeners: 1,
  })
  assert.equal(kedua.granted, true)
  assert.match(kedua.reason, /allowlist/)

  // Sesi lain tidak ikut kebagian.
  const asing = request(lain, base(), 0)
  assert.equal((await asing).granted, false)
})

test("respond untuk id yang tidak ada mengembalikan false", () => {
  assert.equal(respond("perm_hantu", "once"), false)
})

test("abort membatalkan permintaan izin yang menggantung", async () => {
  const id = nextSession()
  const controller = new AbortController()
  const pending = ask({
    sessionID: id,
    permission: base(),
    kind: "write",
    title: "write a.txt",
    detail: "isi",
    pattern: "write",
    listeners: 1,
    signal: controller.signal,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()

  const result = await pending
  assert.equal(result.granted, false)
  assert.match(result.reason, /Cancelled/)
})

test("clearSession menolak permintaan yang masih menggantung", async () => {
  const id = nextSession()
  const pending = request(id)
  await new Promise((resolve) => setTimeout(resolve, 10))

  clearSession(id)
  const result = await pending
  assert.equal(result.granted, false)
  assert.deepEqual(listPending(id), [])
})

// ---------- izin per agent ----------

test("izin agent menimpa izin global", () => {
  const config = Config.parse({
    permission: { edit: "ask", write: "ask", bash: "ask", allowlist: ["git *"] },
    agent: { auto: { permission: { edit: "allow", write: "allow", bash: "allow" } } },
  })
  const eff = effectivePermission(config, "auto", config.agent["auto"])

  assert.equal(eff.edit, "allow")
  assert.equal(eff.bash, "allow")
  assert.equal(eff.source, "auto")
  assert.deepEqual(eff.allowlist, ["git *"], "allowlist global tetap ikut")
})

test("field yang tidak disebut agent mewarisi nilai global", () => {
  const config = Config.parse({
    permission: { edit: "deny", write: "ask", bash: "ask", allowlist: [] },
    agent: { sebagian: { permission: { bash: "allow" } } },
  })
  const eff = effectivePermission(config, "sebagian", config.agent["sebagian"])

  assert.equal(eff.bash, "allow", "yang disebut agent menang")
  assert.equal(eff.edit, "deny", "yang tidak disebut mewarisi global")
})

test("tanpa agent, izin efektif sama persis dengan global", () => {
  const config = Config.parse({
    permission: { edit: "allow", write: "ask", bash: "deny", allowlist: ["npm *"] },
  })
  const eff = effectivePermission(config)

  assert.equal(eff.edit, "allow")
  assert.equal(eff.bash, "deny")
  assert.equal(eff.source, undefined)
  assert.deepEqual(eff.allowlist, ["npm *"])
})

test("alasan penolakan menyebut agent mana yang memutuskan", async () => {
  const config = Config.parse({ agent: { ketat: { permission: { bash: "deny" } } } })
  const result = await ask({
    sessionID: nextSession(),
    permission: effectivePermission(config, "ketat", config.agent["ketat"]),
    kind: "bash",
    title: "bash: rm -rf /",
    detail: "rm -rf /",
    pattern: "rm *",
    listeners: 1,
  })

  assert.equal(result.granted, false)
  assert.match(result.reason, /agent "ketat"/)
})

test("Build Auto mengizinkan tanpa dialog, bahkan tanpa klien terhubung", async () => {
  // Ini yang membuat mode auto berguna di skrip: kebijakan "allow" tidak pernah
  // menyentuh jalur dialog, jadi aturan "tanpa klien = tolak" tidak berlaku.
  const auto = Agent.parse(DEFAULT_AGENTS["build-auto"])
  const permission = effectivePermission(Config.parse({}), "build-auto", auto)

  for (const kind of ["edit", "write", "bash"] as const) {
    const result = await ask({
      sessionID: nextSession(),
      permission,
      kind,
      title: `${kind}: sesuatu`,
      detail: "isi",
      pattern: kind,
      listeners: 0,
    })
    assert.equal(result.granted, true, `${kind} harus lolos tanpa dialog`)
  }
})

test("Build Manual selalu bertanya, dan tanpa klien tetap ditolak", async () => {
  const manual = Agent.parse(DEFAULT_AGENTS["build"])
  const permission = effectivePermission(Config.parse({}), "build", manual)

  const tanpaKlien = await ask({
    sessionID: nextSession(),
    permission,
    kind: "write",
    title: "write a.txt",
    detail: "isi",
    pattern: "write",
    listeners: 0,
  })
  assert.equal(tanpaKlien.granted, false)
  assert.match(tanpaKlien.reason, /no client/i)
})

test("Plan menolak setiap perubahan, dan alasannya bisa dibaca model", async () => {
  const plan = Agent.parse(DEFAULT_AGENTS["plan"])
  const permission = effectivePermission(Config.parse({}), "plan", plan)

  for (const kind of ["edit", "write", "bash"] as const) {
    const result = await ask({
      sessionID: nextSession(),
      permission,
      kind,
      title: `${kind}: sesuatu`,
      detail: "isi",
      pattern: kind,
      listeners: 1,
    })
    assert.equal(result.granted, false, `${kind} harus ditolak di mode plan`)
    assert.match(result.reason, /agent "plan"/, "alasan harus menyebut mode-nya")
  }
})

test("Plan tetap boleh membaca — menyusun rencana butuh menelusuri kode", () => {
  const plan = Agent.parse(DEFAULT_AGENTS["plan"])
  assert.deepEqual(plan.tools, {}, "tidak ada tool yang dihilangkan")
})
