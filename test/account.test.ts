import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-acc-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
delete process.env.TITAH_ACCOUNT_SERVER

const {
  AccountError,
  accountServer,
  chooseAnonymous,
  currentAccount,
  DEFAULT_SERVER,
  fetchUserInfo,
  formatUserCode,
  hasChosen,
  isSignedIn,
  login,
  normaliseServer,
  pollForToken,
  saveAccount,
  signOut,
  startDeviceAuthorization,
} = await import("../src/core/account.ts")
const { accountFile } = await import("../src/core/paths.ts")
const { Config } = await import("../src/core/schema.ts")

const account = {
  server: "http://127.0.0.1:1",
  token: "tok_abc",
  tokenType: "Bearer",
  user: { email: "ada@example.com", name: "Ada" },
  deviceName: "ada@laptop (linux)",
  signedInAt: 1_000,
}

beforeEach(() => {
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true })
  delete process.env.TITAH_ACCOUNT_SERVER
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Server tiruan: tidak ada satu pun test yang menyentuh jaringan sungguhan. */
async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += String(chunk)))
    req.on("end", () => handler(req, res, body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// Penyimpanan & pilihan
// ---------------------------------------------------------------------------

test("mesin baru belum pernah memilih apa pun", () => {
  assert.equal(hasChosen(), false)
  assert.equal(isSignedIn(), false)
  assert.equal(currentAccount(), undefined)
})

test("lanjut tanpa akun tercatat, supaya tidak ditanya dua kali", () => {
  chooseAnonymous()
  assert.equal(hasChosen(), true)
  assert.equal(isSignedIn(), false)
})

test("account.json ditulis dengan mode 0600", () => {
  saveAccount(account)
  const mode = fs.statSync(accountFile()).mode & 0o777
  assert.equal(mode, 0o600)
})

test("token kedaluwarsa dianggap tidak ada, tapi pilihannya tetap tercatat", () => {
  saveAccount({ ...account, expiresAt: 5_000 })
  assert.equal(currentAccount(4_999)?.user.email, "ada@example.com")
  assert.equal(currentAccount(5_000), undefined)
  // Inilah bedanya: kedaluwarsa TIDAK boleh memunculkan lagi layar sambutan.
  assert.equal(hasChosen(), true)
})

test("sign out menghapus token tapi mempertahankan pilihan", () => {
  saveAccount(account)
  assert.equal(signOut(), true)
  assert.equal(isSignedIn(), false)
  assert.equal(hasChosen(), true)
  assert.equal(signOut(), false)
})

test("account.json rusak tidak menjatuhkan apa pun", () => {
  fs.mkdirSync(path.dirname(accountFile()), { recursive: true })
  fs.writeFileSync(accountFile(), "{ini bukan json")
  assert.equal(hasChosen(), false)
  assert.equal(currentAccount(), undefined)
})

// ---------------------------------------------------------------------------
// Pemilihan server
// ---------------------------------------------------------------------------

test("server: env menang atas config, config menang atas default", () => {
  const empty = Config.parse({})
  assert.equal(accountServer(empty), DEFAULT_SERVER)

  const configured = Config.parse({ account: { server: "https://titah.internal/" } })
  assert.equal(accountServer(configured), "https://titah.internal")

  process.env.TITAH_ACCOUNT_SERVER = "http://localhost:8080"
  assert.equal(accountServer(configured), "http://localhost:8080")
})

test("server tanpa skema ditolak, bukan ditebak", () => {
  assert.throws(() => normaliseServer("titah.dev"), AccountError)
  assert.equal(normaliseServer("https://a.example///"), "https://a.example")
})

test("kode ditampilkan berkelompok supaya bisa dibacakan", () => {
  assert.equal(formatUserCode("abcdefgh"), "ABCD-EFGH")
  assert.equal(formatUserCode("ABCD-EFGH"), "ABCD-EFGH")
})

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

test("permintaan kode perangkat mengirim client_id dan mengembalikan kodenya", async () => {
  let seen = ""
  await withServer(
    (req, res, body) => {
      seen = body
      json(res, 200, {
        device_code: "dev_1",
        user_code: "ABCDEFGH",
        verification_uri: "http://x/cli/activate/",
        verification_uri_complete: "http://x/cli/activate/?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      })
    },
    async (origin) => {
      const authorization = await startDeviceAuthorization(origin, 1_000)
      assert.match(seen, /client_id=titah-cli/)
      assert.match(seen, /device_name=/)
      assert.equal(authorization.userCode, "ABCDEFGH")
      assert.equal(authorization.interval, 5_000)
      assert.equal(authorization.expiresAt, 1_000 + 600_000)
    },
  )
})

test("server yang bukan Titah dilaporkan sebagai bukan Titah", async () => {
  await withServer(
    (_req, res) => json(res, 200, { hello: "world" }),
    async (origin) => {
      await assert.rejects(() => startDeviceAuthorization(origin), {
        name: "AccountError",
        code: "bad_response",
      })
    },
  )
})

test("server mati menghasilkan pesan yang menyebut cara menunjuk ke tempat lain", async () => {
  await assert.rejects(() => startDeviceAuthorization("http://127.0.0.1:1"), (error: unknown) => {
    assert.ok(error instanceof AccountError)
    assert.equal(error.code, "unreachable")
    assert.match(error.message, /TITAH_ACCOUNT_SERVER/)
    return true
  })
})

test("authorization_pending berarti terus menunggu, bukan gagal", async () => {
  let calls = 0
  await withServer(
    (_req, res) => {
      calls += 1
      if (calls < 3) return json(res, 400, { error: "authorization_pending" })
      json(res, 200, {
        access_token: "tok_xyz",
        token_type: "Bearer",
        expires_in: 3600,
        user: { email: "ada@example.com", name: "Ada" },
      })
    },
    async (origin) => {
      const state = await pollForToken(
        origin,
        {
          deviceCode: "dev_1",
          userCode: "ABCDEFGH",
          verificationUri: `${origin}/cli/activate/`,
          interval: 1,
          expiresAt: 9_999_999,
        },
        { sleep: async () => {}, now: () => 1_000 },
      )
      assert.equal(calls, 3)
      assert.equal(state.token, "tok_xyz")
      assert.equal(state.user.email, "ada@example.com")
      assert.equal(state.expiresAt, 1_000 + 3_600_000)
    },
  )
})

test("slow_down menaikkan jeda dan diumumkan, bukan didiamkan", async () => {
  let calls = 0
  const intervals: number[] = []
  await withServer(
    (_req, res) => {
      calls += 1
      if (calls === 1) return json(res, 400, { error: "slow_down" })
      json(res, 200, { access_token: "t", user: { email: "a@b.c" } })
    },
    async (origin) => {
      await pollForToken(
        origin,
        {
          deviceCode: "dev_1",
          userCode: "ABCDEFGH",
          verificationUri: "",
          interval: 5_000,
          expiresAt: 9_999_999,
        },
        {
          sleep: async () => {},
          now: () => 1_000,
          onSlowDown: (next) => intervals.push(next),
        },
      )
      assert.deepEqual(intervals, [10_000])
    },
  )
})

test("penolakan di browser dibedakan dari kode kedaluwarsa", async () => {
  for (const [error, code] of [
    ["access_denied", "access_denied"],
    ["expired_token", "expired_token"],
  ] as const) {
    await withServer(
      (_req, res) => json(res, 400, { error }),
      async (origin) => {
        await assert.rejects(
          () =>
            pollForToken(
              origin,
              {
                deviceCode: "d",
                userCode: "ABCDEFGH",
                verificationUri: "",
                interval: 1,
                expiresAt: 9_999_999,
              },
              { sleep: async () => {}, now: () => 1_000 },
            ),
          { name: "AccountError", code },
        )
      },
    )
  }
})

test("kode yang sudah lewat waktunya berhenti tanpa memanggil server", async () => {
  await assert.rejects(
    () =>
      pollForToken(
        "http://127.0.0.1:1",
        {
          deviceCode: "d",
          userCode: "ABCDEFGH",
          verificationUri: "",
          interval: 1,
          expiresAt: 500,
        },
        { sleep: async () => {}, now: () => 1_000 },
      ),
    { name: "AccountError", code: "expired_token" },
  )
})

test("token tanpa user ditolak — sesi tanpa identitas tidak ada gunanya", async () => {
  await withServer(
    (_req, res) => json(res, 200, { access_token: "t" }),
    async (origin) => {
      await assert.rejects(
        () =>
          pollForToken(
            origin,
            {
              deviceCode: "d",
              userCode: "ABCDEFGH",
              verificationUri: "",
              interval: 1,
              expiresAt: 9_999_999,
            },
            { sleep: async () => {}, now: () => 1_000 },
          ),
        { name: "AccountError", code: "bad_response" },
      )
    },
  )
})

test("login yang berhasil menyimpan akun dan menandai pilihannya", async () => {
  await withServer(
    (req, res) => {
      if (req.url?.includes("device")) {
        return json(res, 200, {
          device_code: "dev_1",
          user_code: "ABCDEFGH",
          verification_uri: "http://x/cli/activate/",
          expires_in: 600,
          interval: 1,
        })
      }
      json(res, 200, { access_token: "tok_final", user: { email: "ada@example.com" } })
    },
    async (origin) => {
      const prompts: boolean[] = []
      const state = await login(
        origin,
        { onPrompt: (_auth, opened) => prompts.push(opened) },
        { openBrowser: false, sleep: async () => {} },
      )
      assert.equal(state.user.email, "ada@example.com")
      assert.deepEqual(prompts, [false])
      // Tersimpan, dan mesin ini sekarang terhitung sudah memilih.
      assert.equal(currentAccount()?.token, "tok_final")
      assert.equal(hasChosen(), true)
    },
  )
})

test("login yang dibatalkan tidak menyimpan apa pun", async () => {
  const controller = new AbortController()
  await withServer(
    (req, res) => {
      if (req.url?.includes("device")) {
        return json(res, 200, {
          device_code: "d",
          user_code: "ABCDEFGH",
          verification_uri: "http://x",
          expires_in: 600,
          interval: 1,
        })
      }
      json(res, 400, { error: "authorization_pending" })
    },
    async (origin) => {
      await assert.rejects(
        () =>
          login(
            origin,
            { onPrompt: () => controller.abort() },
            { openBrowser: false, signal: controller.signal, sleep: async () => {} },
          ),
        { name: "AccountError", code: "cancelled" },
      )
      assert.equal(currentAccount(), undefined)
      assert.equal(hasChosen(), false)
    },
  )
})

// ---------------------------------------------------------------------------
// Verifikasi
// ---------------------------------------------------------------------------

test("userinfo membawa bearer token dan mengembalikan identitas", async () => {
  let auth = ""
  await withServer(
    (req, res) => {
      auth = req.headers.authorization ?? ""
      json(res, 200, { email: "ada@example.com", name: "Ada" })
    },
    async (origin) => {
      const user = await fetchUserInfo({ ...account, server: origin })
      assert.equal(auth, "Bearer tok_abc")
      assert.equal(user.email, "ada@example.com")
    },
  )
})

test("token yang dicabut di dashboard mematikan sesi di CLI", async () => {
  await withServer(
    (_req, res) => json(res, 401, { error: "invalid_token" }),
    async (origin) => {
      await assert.rejects(() => fetchUserInfo({ ...account, server: origin }), {
        name: "AccountError",
        code: "revoked",
      })
    },
  )
})
