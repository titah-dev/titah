import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-mcpr-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.HOME = path.join(root, "home")

const { HttpTransport, NeedsAuthorization, readSseResponse, resourceMetadataOf } = await import(
  "../src/core/mcp-http.ts"
)
const {
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  forgetToken,
  loopback,
  randomState,
  readTokens,
  refresh,
  registerClient,
  validToken,
  writeToken,
} = await import("../src/core/mcp-oauth.ts")
const { McpServer } = await import("../src/core/mcp.ts")

const closers: (() => void)[] = []
after(() => {
  for (const close of closers) close()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Server HTTP sungguhan; test ini tidak menipu `fetch`. */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  closers.push(() => server.close())
  return `http://127.0.0.1:${address.port}`
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = ""
    req.on("data", (chunk) => (text += chunk))
    req.on("end", () => resolve(text))
  })
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test("jawaban JSON biasa diterima", async () => {
  const url = await serve(async (req, res) => {
    const request = JSON.parse(await body(req)) as { id: number; method: string }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echo: request.method } }))
  })

  const transport = new HttpTransport({ url })
  assert.deepEqual(await transport.request("tools/list"), { echo: "tools/list" })
})

test("jawaban SSE juga diterima — server memilih bentuknya, bukan klien", async () => {
  /*
   * Ini inti "Streamable HTTP": satu endpoint yang boleh menjawab dengan JSON
   * atau aliran, per permintaan. Klien yang memilih satu bentuk di awal akan
   * gagal pada separuh server yang sah.
   */
  const url = await serve(async (req, res) => {
    const request = JSON.parse(await body(req)) as { id: number }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`)
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n\n`)
    res.end()
  })

  assert.deepEqual(await new HttpTransport({ url }).request("tools/list"), { ok: true })
})

test("jawaban milik permintaan LAIN di aliran yang sama tidak diambil", async () => {
  /*
   * Aliran boleh berisi jawaban untuk permintaan lain yang sedang berjalan.
   * Mengambil yang pertama datang berarti sesekali mengembalikan hasil tool
   * yang tertukar — kegagalan yang jauh lebih sulit dilacak daripada error.
   */
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 99, result: "salah" })}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 7, result: "benar" })}\n\n`))
      controller.close()
    },
  })

  assert.equal((await readSseResponse(stream, 7)).result, "benar")
})

test("aliran ber-CRLF ikut terbaca", () => {
  // Sebagian server menulis CRLF. Memotong hanya pada `\n\n` membuat seluruh
  // aliran dari server itu terlihat seperti satu event yang tidak pernah usai.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 1, result: "ya" })}\r\n\r\n`))
      controller.close()
    },
  })
  return readSseResponse(stream, 1).then((response) => assert.equal(response.result, "ya"))
})

test("Mcp-Session-Id dikembalikan pada permintaan BERIKUTNYA", async () => {
  /*
   * Server yang menyimpan keadaan per sesi memperlakukan permintaan tanpa
   * header ini sebagai klien baru: jabat tangannya terulang, dan tool yang
   * bergantung pada keadaan sebelumnya gagal dengan alasan yang tidak menyebut
   * sesi sama sekali.
   */
  const seen: (string | undefined)[] = []
  const url = await serve(async (req, res) => {
    seen.push(req.headers["mcp-session-id"] as string | undefined)
    const request = JSON.parse(await body(req)) as { id: number }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sesi-42" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }))
  })

  const transport = new HttpTransport({ url })
  await transport.request("initialize")
  await transport.request("tools/list")

  assert.deepEqual(seen, [undefined, "sesi-42"])
  assert.equal(transport.sessionId, "sesi-42")
})

test("error JSON-RPC jadi kegagalan yang menyebut pesannya", async () => {
  const url = await serve(async (req, res) => {
    const request = JSON.parse(await body(req)) as { id: number }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "tidak ada" } }))
  })

  await assert.rejects(() => new HttpTransport({ url }).request("apa"), /tidak ada/)
})

test("401 jadi NeedsAuthorization, lengkap dengan alamat metadatanya", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(401, {
      "WWW-Authenticate": 'Bearer resource_metadata="https://as.test/.well-known/x", scope="a"',
    })
    res.end()
  })

  await assert.rejects(
    () => new HttpTransport({ url }).request("tools/list"),
    (error: unknown) =>
      error instanceof NeedsAuthorization &&
      error.resourceMetadata === "https://as.test/.well-known/x",
  )
})

test("resourceMetadataOf membaca satu parameter, dan tahan header tanpa itu", () => {
  assert.equal(resourceMetadataOf('Bearer resource_metadata="https://a/b"'), "https://a/b")
  assert.equal(resourceMetadataOf("Bearer"), undefined)
  assert.equal(resourceMetadataOf(null), undefined)
})

test("Authorization dibaca ULANG setiap permintaan", async () => {
  /*
   * Sesi Titah berjalan berjam-jam sementara token OAuth hidup beberapa menit.
   * Membacanya sekali saat server dibuat berarti permintaan pertama berhasil
   * dan sisanya 401 — kegagalan yang muncul di tengah pekerjaan.
   */
  const seen: string[] = []
  const url = await serve(async (req, res) => {
    seen.push(String(req.headers["authorization"]))
    const request = JSON.parse(await body(req)) as { id: number }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }))
  })

  let nomor = 0
  const transport = new HttpTransport({
    url,
    authorization: async () => `Bearer token-${++nomor}`,
  })
  await transport.request("a")
  await transport.request("b")

  assert.deepEqual(seen, ["Bearer token-1", "Bearer token-2"])
})

test("McpServer.http menjabat tangan dan menamai tool dengan awalan server", async () => {
  const url = await serve(async (req, res) => {
    const request = JSON.parse(await body(req)) as { id: number; method: string }
    const result =
      request.method === "tools/list"
        ? { tools: [{ name: "cari", description: "mencari", inputSchema: {} }] }
        : {}
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
  })

  const tools = await McpServer.http("jauh", { url }).connect()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, "jauh_cari", "diberi awalan supaya dua server tidak bertabrakan")
  assert.equal(tools[0]?.remoteName, "cari")
})

test("server remote yang 401 melaporkan perintah berikutnya, bukan cuma kodenya", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(401, {})
    res.end()
  })

  const server = McpServer.http("berbayar", { url })
  assert.deepEqual(await server.connect(), [])
  assert.match(server.failure ?? "", /titah mcp login berbayar/)
})

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

test("PKCE memakai S256, dan challenge-nya benar-benar hash verifier-nya", async () => {
  /*
   * `plain` mengirim verifier apa adanya di URL otorisasi, tempat ia berakhir
   * di riwayat browser dan log server — dan seluruh gunanya PKCE adalah bahwa
   * yang terlihat di sana tidak cukup untuk menukar kode.
   */
  const { createHash } = await import("node:crypto")
  const pkce = createPkce()
  assert.equal(pkce.challenge, createHash("sha256").update(pkce.verifier).digest("base64url"))
  assert.ok(!pkce.challenge.includes("+") && !pkce.challenge.includes("/"), "base64url, bukan base64")
})

test("penemuan mengikuti petunjuk sumber daya ke authorization server lain", async () => {
  const as = await serve((req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(
        JSON.stringify({
          issuer: "as",
          authorization_endpoint: "https://as.test/auth",
          token_endpoint: "https://as.test/token",
        }),
      )
    }
    res.writeHead(404).end()
  })

  const resource = await serve((req, res) => {
    if (req.url === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ authorization_servers: [as] }))
    }
    res.writeHead(404).end()
  })

  const metadata = await discover(`${resource}/mcp`)
  assert.equal(metadata.token_endpoint, "https://as.test/token")
})

test("sumber daya yang tidak mengumumkan apa pun dianggap issuer-nya sendiri", async () => {
  // Bukan kesalahan: spesifikasi mengizinkannya, dan memperlakukannya sebagai
  // kegagalan akan menolak server yang sebenarnya sah.
  const url = await serve((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(
        JSON.stringify({ issuer: "x", authorization_endpoint: "https://x/a", token_endpoint: "https://x/t" }),
      )
    }
    res.writeHead(404).end()
  })

  assert.equal((await discover(`${url}/mcp`)).authorization_endpoint, "https://x/a")
})

test("server tanpa OAuth menyarankan header statis alih-alih sekadar gagal", async () => {
  const url = await serve((_req, res) => res.writeHead(404).end())
  await assert.rejects(() => discover(`${url}/mcp`), /headers/)
})

test("pendaftaran dinamis yang tidak tersedia menyebut jalan keluarnya", async () => {
  await assert.rejects(
    () => registerClient({ issuer: "x", authorization_endpoint: "a", token_endpoint: "t" }, "http://127.0.0.1/cb"),
    /ask its operator for a client_id/i,
  )
})

test("URL otorisasi membawa PKCE, state, dan sumber daya yang dituju", () => {
  const url = new URL(
    authorizationUrl({
      metadata: { issuer: "i", authorization_endpoint: "https://as/auth", token_endpoint: "t" },
      clientId: "c1",
      redirectUri: "http://127.0.0.1:1/cb",
      pkce: { verifier: "v", challenge: "ch" },
      state: "st",
      resource: "https://mcp.test/x",
      scope: "read",
    }),
  )

  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("code_challenge"), "ch")
  assert.equal(url.searchParams.get("state"), "st")
  assert.equal(url.searchParams.get("resource"), "https://mcp.test/x")
  assert.equal(url.searchParams.get("client_id"), "c1")
  assert.equal(url.searchParams.has("code_verifier"), false, "verifier TIDAK boleh ikut di URL")
})

test("loopback menolak redirect dengan state yang tidak cocok", async () => {
  /*
   * Tanpa pemeriksaan ini, siapa pun yang bisa membuat browser user membuka
   * satu URL bisa menyuntikkan kode otorisasi milik akun LAIN ke sesi ini —
   * dan Titah akan menyimpannya sebagai token user.
   */
  const handle = await loopback("benar")
  const gagal = assert.rejects(() => handle.code, /State mismatch|state/i)
  await fetch(`${handle.redirectUri}?code=abc&state=salah`)
  await gagal
  handle.close()
})

test("bolak-balik penuh: authorize → tukar kode → simpan → segarkan", async () => {
  /*
   * Dijalankan terhadap authorization server HTTP yang sungguhan, termasuk
   * redirect yang benar-benar dikirim ke loopback. Memalsukan `fetch` hanya
   * membuktikan palsuannya bekerja.
   */
  let terimaVerifier: string | undefined
  const as = await serve(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (url.pathname === "/register") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ client_id: "klien-uji" }))
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(req))
      if (form.get("grant_type") === "refresh_token") {
        res.writeHead(200, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ access_token: "kedua", token_type: "Bearer", expires_in: 3600 }))
      }
      terimaVerifier = form.get("code_verifier") ?? undefined
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(
        JSON.stringify({
          access_token: "pertama",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "r1",
        }),
      )
    }
    res.writeHead(404).end()
  })

  const metadata = {
    issuer: as,
    authorization_endpoint: `${as}/auth`,
    token_endpoint: `${as}/token`,
    registration_endpoint: `${as}/register`,
  }

  const pkce = createPkce()
  const state = randomState()
  const handle = await loopback(state)
  const clientId = await registerClient(metadata, handle.redirectUri)

  // Browser "membuka" URL-nya dan server otorisasi mengirim balik kodenya.
  await fetch(`${handle.redirectUri}?code=kode-abc&state=${state}`)
  const code = await handle.code
  handle.close()

  const token = await exchangeCode({
    metadata,
    clientId,
    redirectUri: handle.redirectUri,
    code,
    verifier: pkce.verifier,
    resource: "https://mcp.test/x",
  })

  assert.equal(terimaVerifier, pkce.verifier, "verifier dikirim saat menukar, bukan saat authorize")
  assert.equal(token.accessToken, "pertama")
  assert.ok((token.expiresAt ?? 0) > Date.now())

  writeToken("uji", token)
  assert.equal(validToken("uji")?.accessToken, "pertama")

  const lagi = await refresh({ metadata, token, resource: "https://mcp.test/x" })
  assert.equal(lagi.accessToken, "kedua")
  assert.equal(lagi.refreshToken, "r1", "refresh token lama dipertahankan kalau tidak dikirim ulang")
})

test("token kedaluwarsa dianggap TIDAK ADA, dengan margin", async () => {
  // Token yang sah "sepuluh detik lagi" akan kedaluwarsa di tengah permintaan.
  writeToken("hampir", {
    accessToken: "x",
    tokenType: "Bearer",
    expiresAt: Date.now() + 10_000,
    issuer: "i",
    clientId: "c",
  })
  assert.equal(validToken("hampir"), undefined)

  writeToken("lama", {
    accessToken: "y",
    tokenType: "Bearer",
    expiresAt: Date.now() + 600_000,
    issuer: "i",
    clientId: "c",
  })
  assert.equal(validToken("lama")?.accessToken, "y")
})

test("token disimpan di berkasnya sendiri, mode 0600", async () => {
  /*
   * Terpisah dari auth.json dan account.json dengan sengaja: tiga jenis rahasia
   * dengan tiga pemilik. Menyatukannya berarti `titah auth remove` bisa
   * menghapus hal yang tidak disebut namanya.
   */
  const { mcpAuthFile } = await import("../src/core/mcp-oauth.ts")
  writeToken("mode", { accessToken: "z", tokenType: "Bearer", issuer: "i", clientId: "c" })

  assert.equal(fs.statSync(mcpAuthFile()).mode & 0o777, 0o600)
  assert.ok("mode" in readTokens())
  assert.equal(forgetToken("mode"), true)
  assert.equal(forgetToken("mode"), false, "menghapus dua kali bukan kesalahan")
})
