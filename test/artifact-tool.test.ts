import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

/**
 * Tidak satu pun test di sini menyentuh jaringan — dan HOME diisolasi supaya
 * itu tetap benar di mesin yang kebetulan sedang login.
 *
 * Tanpa isolasi ini, test "tanpa akun ia menolak" akan lolos di CI dan
 * MENGIRIM permintaan sungguhan ke titah.dev di laptop siapa pun yang pernah
 * menjalankan `titah login`. Impor ditunda sampai setelah env diset karena
 * `dataDir()` membaca XDG_DATA_HOME saat dipanggil.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-artifact-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
delete process.env.TITAH_ACCOUNT_SERVER

const { Config } = await import("../src/core/schema.ts")
const { saveAccount, signOut } = await import("../src/core/account.ts")
const { artifactReason, artifactTool } = await import("../src/core/tool/artifact.ts")
const { allTools, toolByName } = await import("../src/core/tool/index.ts")
const { ToolError } = await import("../src/core/tool/types.ts")

/**
 * Akun palsu di HOME yang terisolasi.
 *
 * Server-nya sengaja alamat yang tidak bisa dihubungi: setiap test di bawah
 * harus menolak SEBELUM ada fetch, jadi kalau suatu saat salah satu benar-benar
 * mencoba mengirim, ia gagal dengan berisik alih-alih diam-diam menembak
 * sesuatu yang nyata.
 */
function signIn(): void {
  saveAccount({
    server: "https://titah.invalid",
    token: "titah_test-token",
    tokenType: "Bearer",
    user: { email: "ada@example.com" },
    deviceName: "test",
    signedInAt: Date.now(),
  })
}

/**
 * Yang perlu dipaku adalah batas-batasnya: sumbu izin yang dipakai, apa yang
 * dikatakan dialognya, dan yang terpenting — bahwa dokumen kebesaran ditolak
 * SEBELUM ada `fetch` sama sekali. Yang terakhir itu bukan optimasi; ia yang
 * membuat model mendapat kedua angkanya alih-alih menunggu 413 dari server.
 */

const ctx = (config = Config.parse({})) =>
  ({
    cwd: "/tmp",
    sessionID: "ses_artifact",
    callID: "call_1",
    signal: new AbortController().signal,
    config,
  }) as never

const PAGE = "<!doctype html><html><body><h1>hi</h1></body></html>"

// ---------- pendaftaran ----------

test("artifact terdaftar tepat sekali di allTools()", () => {
  const found = allTools().filter((tool) => tool.name === "artifact")
  assert.equal(found.length, 1)
  assert.equal(toolByName("artifact"), artifactTool)
})

// ---------- sumbu izin ----------

test("artifact memakai sumbu network, bukan menumpang bash atau write", () => {
  const need = artifactTool.permission?.({ title: "Report", body: PAGE }, ctx())

  assert.equal(need?.kind, "network")
})

test("mutates dibiarkan kosong: tidak ada berkas di dalam cwd yang berubah", () => {
  // `mutates` memicu snapshot repo supaya /undo bekerja. Menyetelnya di sini
  // berarti menyalin seluruh repo tiap kali model menerbitkan halaman, tanpa
  // ada yang bisa di-undo.
  assert.equal(artifactTool.mutates, undefined)
})

test("dialog izin menyebut host, judul, dan jumlah byte", () => {
  const body = "x".repeat(4096)
  const need = artifactTool.permission?.({ title: "Weekly build times", body }, ctx())

  assert.match(need?.detail ?? "", /4 KiB/)
  assert.match(need?.detail ?? "", /Weekly build times/)
  // Host yang SUNGGUH dihubungi, supaya user menilai tujuan yang benar.
  assert.match(need?.detail ?? "", /titah\.dev/)
  assert.match(need?.pattern ?? "", /^https:\/\/titah\.dev\/\*$/)
  assert.equal(need?.subject, "https://titah.dev/api/v1/artifacts/")
})

test("dialog membedakan menerbitkan baru dari merevisi", () => {
  const fresh = artifactTool.permission?.({ title: "Report", body: PAGE }, ctx())
  const revise = artifactTool.permission?.({ title: "Report", body: PAGE, slug: "abc123" }, ctx())

  assert.match(fresh?.title ?? "", /publish/)
  assert.match(revise?.title ?? "", /revise abc123/)
})

test("dialog mengatakan halaman tetap privat", () => {
  const need = artifactTool.permission?.({ title: "Report", body: PAGE }, ctx())

  assert.match(need?.detail ?? "", /private/)
})

// ---------- penolakan lokal, sebelum jaringan ----------

test("dokumen di atas 512 KiB ditolak sebelum fetch mana pun, dengan kedua angkanya", async () => {
  signIn()
  const oversized = "x".repeat(600 * 1024)

  await assert.rejects(
    () => artifactTool.execute({ title: "Huge", body: oversized }, ctx()),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      // Model yang hanya diberi tahu "kebesaran" menulis halaman yang sama lagi.
      assert.match(error.message, /600 KiB/)
      assert.match(error.message, /512 KiB/)
      assert.match(error.message, /Nothing was sent/)
      return true
    },
  )
})

test("ukuran diukur dalam byte UTF-8, bukan jumlah karakter", async () => {
  signIn()
  // 200_000 karakter CJK = 600_000 byte. Batas yang memakai .length akan lolos.
  const cjk = "だ".repeat(200_000)
  assert.ok(cjk.length < 512 * 1024, "prasyarat: jumlah karakternya di bawah batas")

  await assert.rejects(
    () => artifactTool.execute({ title: "CJK", body: cjk }, ctx()),
    (error: unknown) => error instanceof ToolError && /586 KiB/.test(error.message),
  )
})

test("tanpa akun, tool menolak dan menyuruh titah login", async () => {
  signOut()

  await assert.rejects(
    () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /titah login/)
      assert.match(error.message, /Nothing was sent/)
      return true
    },
  )
})

test("artifacts.enabled=false menolak sebelum akun diperiksa", async () => {
  // Urutannya penting dan sama dengan artifactReason: menyuruh `titah login`
  // kepada user yang sengaja mematikan fitur ini adalah saran yang salah.
  signIn()
  const config = Config.parse({ artifacts: { enabled: false } })

  await assert.rejects(
    () => artifactTool.execute({ title: "Report", body: PAGE }, ctx(config)),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /artifacts\.enabled/)
      assert.match(error.message, /Nothing was sent/)
      return true
    },
  )
})

// ---------- alasan untuk doctor ----------

test("artifactReason mengembalikan alasan, bukan boolean", () => {
  signIn()
  assert.equal(artifactReason(Config.parse({})), "ok")
  // Config yang mati menang lebih dulu, bahkan saat sudah masuk.
  assert.equal(artifactReason(Config.parse({ artifacts: { enabled: false } })), "disabled")

  signOut()
  assert.equal(artifactReason(Config.parse({})), "not-signed-in")
})

test("artifacts nyala secara bawaan, tidak seperti tracking.sync", () => {
  const config = Config.parse({})

  assert.equal(config.artifacts.enabled, true)
  // Bedanya disengaja: sync mengunggah otomatis tanpa user di dalam putaran,
  // sedangkan tiap penerbitan artifact melewati dialog izin.
  assert.equal(config.tracking.sync, false)
})

// ---------- deskripsi yang menyetir model ----------

test("deskripsi tool mengatakan halaman privat dan bagaimana merevisinya", () => {
  // Ini satu-satunya teks yang dibaca model sebelum memutuskan memanggil tool
  // ini, jadi dua hal harus ada di dalamnya: bahwa hasilnya tidak publik, dan
  // bahwa merevisi halaman yang sama adalah dengan mengoper slug.
  assert.match(artifactTool.description, /PRIVATE/)
  assert.match(artifactTool.description, /slug/)
  assert.match(artifactTool.description, /dashboard/)
})

// ---------- fetch yang melempar ----------

/** `TypeError: fetch failed` seperti yang dilempar undici, dengan sebabnya di `cause`. */
function fetchFailed(code: string, message = `connect ${code} 1.2.3.4:443`): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) })
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const published = () =>
  new Response(
    JSON.stringify({
      slug: "s1",
      title: "Report",
      visibility: "private",
      version: 1,
      version_count: 1,
      byte_size: PAGE.length,
      url: "https://titah.invalid/dashboard/artifacts/s1/",
      share_url: null,
      unchanged: false,
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  )

test("pesan fetch gagal menyebut kode sebab dari error.cause, bukan hanya 'fetch failed'", async () => {
  signIn()
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      throw fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND titah.invalid")
    }) as typeof fetch,
    () =>
      assert.rejects(
        () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
        (error: unknown) => {
          assert.ok(error instanceof ToolError)
          assert.match(error.message, /ENOTFOUND/)
          assert.match(error.message, /getaddrinfo/)
          assert.match(error.message, /Nothing was published/)
          // Supaya model tidak mengarang "firewall di server Anthropic".
          assert.match(error.message, /user's own machine/)
          return true
        },
      ),
  )
  assert.equal(calls, 2, "DNS gagal = tidak ada yang terkirim, jadi dicoba ulang sekali")
})

test("gagal koneksi sesaat dicoba ulang sekali dan publish tetap berhasil", async () => {
  signIn()
  let calls = 0
  const result = await withFetch(
    (async () => {
      calls++
      if (calls === 1) throw fetchFailed("ECONNREFUSED")
      return published()
    }) as typeof fetch,
    () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
  )
  assert.equal(calls, 2)
  assert.match(result.output, /Published: Report/)
})

test("kode di dalam AggregateError (happy eyeballs) tetap terbaca", async () => {
  signIn()
  const aggregate = new AggregateError([Object.assign(new Error("x"), { code: "EHOSTUNREACH" })], "")
  await withFetch(
    (async () => {
      throw new TypeError("fetch failed", { cause: aggregate })
    }) as typeof fetch,
    () =>
      assert.rejects(
        () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
        (error: unknown) => error instanceof ToolError && /EHOSTUNREACH/.test(error.message),
      ),
  )
})

test("ECONNRESET tanpa slug TIDAK dicoba ulang — retry bisa membuat halaman kedua", async () => {
  signIn()
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      throw fetchFailed("ECONNRESET", "read ECONNRESET")
    }) as typeof fetch,
    () =>
      assert.rejects(
        () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
        (error: unknown) => {
          assert.ok(error instanceof ToolError)
          assert.match(error.message, /ECONNRESET/)
          // Request mungkin sudah sampai; "Nothing was published" akan bohong.
          assert.match(error.message, /may or may not have been/)
          assert.doesNotMatch(error.message, /Nothing was published/)
          return true
        },
      ),
  )
  assert.equal(calls, 1)
})

test("ECONNRESET dengan slug dicoba ulang, karena body identik tidak menulis versi baru", async () => {
  signIn()
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      if (calls === 1) throw fetchFailed("ECONNRESET", "read ECONNRESET")
      return published()
    }) as typeof fetch,
    () => artifactTool.execute({ title: "Report", body: PAGE, slug: "s1" }, ctx()),
  )
  assert.equal(calls, 2)
})

test("gagal TLS tidak dicoba ulang dan mengatakan retry tidak menolong", async () => {
  signIn()
  let calls = 0
  await withFetch(
    (async () => {
      calls++
      throw fetchFailed("CERT_HAS_EXPIRED", "certificate has expired")
    }) as typeof fetch,
    () =>
      assert.rejects(
        () => artifactTool.execute({ title: "Report", body: PAGE }, ctx()),
        (error: unknown) =>
          error instanceof ToolError &&
          /CERT_HAS_EXPIRED/.test(error.message) &&
          /Retrying will not help/.test(error.message),
      ),
  )
  assert.equal(calls, 1)
})
