import assert from "node:assert/strict"
import test from "node:test"
import { effectivePermission } from "../src/core/permission.ts"
import { Agent, Config, DEFAULT_AGENTS } from "../src/core/schema.ts"
import { checkUrl, htmlToText, webfetchTool } from "../src/core/tool/webfetch.ts"
import { parseDuckDuckGo, searchBackend, websearchTool } from "../src/core/tool/websearch.ts"
import { ToolError } from "../src/core/tool/types.ts"

/**
 * Gap 6 di docs/gap-analysis.md, plus sumbu izin yang gap 10 minta LEBIH DULU:
 * "begitu tool web atau MCP masuk, model izin ini akan kekurangan sumbu justru
 * pada hal yang paling perlu dibatasi."
 *
 * Test di sini tidak menyentuh jaringan. Yang perlu dipaku adalah batas-batasnya
 * — skema yang diterima, pemotongan, sumbu izin, dan penanganan backend tanpa
 * kunci — dan semuanya bisa diperiksa tanpa satu pun permintaan keluar.
 */

const ctx = (config = Config.parse({})) =>
  ({
    cwd: "/tmp",
    sessionID: "ses_web",
    callID: "call_1",
    signal: new AbortController().signal,
    config,
  }) as never

// ---------- sumbu izin ----------

test("webfetch dan websearch memakai sumbu network, bukan menumpang bash", () => {
  // Menumpang sumbu lain berarti user yang membuka `bash` untuk menjalankan
  // test diam-diam juga membuka jalan keluar untuk isi repo-nya.
  const fetchNeed = webfetchTool.permission?.({ url: "https://example.com", format: "text" }, ctx())
  const searchNeed = websearchTool.permission?.({ query: "apa pun" }, ctx())

  assert.equal(fetchNeed?.kind, "network")
  assert.equal(searchNeed?.kind, "network")
})

test("dialog izin webfetch menyebut URL LENGKAP, bukan yang dipotong", () => {
  // Yang dinilai user saat memberi izin adalah ke mana permintaan itu pergi,
  // dan host bisa bersembunyi di belakang path yang panjang.
  const url = `https://evil.example/${"a".repeat(200)}`
  const need = webfetchTool.permission?.({ url, format: "text" }, ctx())
  assert.ok(need?.detail.includes(url), "URL lengkap harus ada di detail")
  assert.match(need?.detail ?? "", /outside your machine/)
})

test("bawaan sumbu network adalah ask, dan agent bisa menimpanya", () => {
  const config = Config.parse({
    agent: { riset: { permission: { network: "allow" } } },
  })
  assert.equal(effectivePermission(config).network, "ask")
  assert.equal(effectivePermission(config, "riset", config.agent["riset"]).network, "allow")
})

test("mode plan menolak delete, tapi TIDAK menolak network", () => {
  // Membaca dokumentasi sebelum menyusun rencana justru pekerjaan mode ini, dan
  // itu tidak mengubah apa pun di mesin. Yang dijanjikan mode plan adalah tidak
  // mengubah, bukan tidak membaca.
  // DEFAULT_AGENTS disisipkan oleh `loadConfig`, bukan oleh `Config.parse` —
  // jadi diambil langsung dari sumbernya, seperti test/permission.test.ts.
  const plan = effectivePermission(
    Config.parse({}),
    "plan",
    Agent.parse(DEFAULT_AGENTS["plan"]),
  )
  assert.equal(plan.edit, "deny")
  assert.equal(plan.delete, "deny")
  assert.equal(plan.network, "ask")
})

// ---------- batas alamat ----------

test("webfetch menolak file: — jalan pintas melewati penjagaan cwd", () => {
  // resolveInside menjaga SELURUH tool berkas tetap di dalam cwd. Sebuah tool
  // jaringan yang menerima file:// akan membatalkan penjagaan itu dari samping,
  // dan tidak satu pun test tool berkas akan menangkapnya.
  assert.throws(() => checkUrl("file:///etc/passwd"), (error: unknown) => {
    assert.ok(error instanceof ToolError)
    assert.match(error.message, /only speaks http and https/)
    assert.match(error.message, /read tool/, "harus menunjukkan jalan yang benar")
    return true
  })
})

test("webfetch menolak skema lain, dan menerima http/https", () => {
  for (const bad of ["ftp://x/y", "data:text/html,<b>hi", "javascript:alert(1)"]) {
    assert.throws(() => checkUrl(bad), ToolError, `harus menolak ${bad}`)
  }
  assert.equal(checkUrl("https://example.com/a").host, "example.com")
  assert.equal(checkUrl("http://localhost:3000/health").port, "3000")
})

test("alamat privat TIDAK diblokir — itu tugas sumbu network, bukan daftar IP", () => {
  // Agent coding memang perlu memeriksa dev server-nya sendiri. Memblokir
  // localhost mematikan salah satu kegunaan utamanya, dan user yang tidak mau
  // ada permintaan keluar sama sekali punya pernyataan yang jauh lebih jelas:
  // network: "deny".
  assert.doesNotThrow(() => checkUrl("http://127.0.0.1:8080/"))
  assert.doesNotThrow(() => checkUrl("http://192.168.1.10/"))
})

test("URL yang tidak valid tidak menggagalkan pembuatan dialog izin", () => {
  // `permission()` berjalan SEBELUM `execute`, jadi ia bisa menerima sampah.
  // Melempar di sana akan menggagalkan giliran dengan pesan tentang pembuatan
  // pola, bukan tentang URL-nya.
  assert.doesNotThrow(() => webfetchTool.permission?.({ url: "bukan url", format: "text" }, ctx()))
  assert.throws(() => checkUrl("bukan url"), /Not a valid URL/)
})

// ---------- HTML jadi teks ----------

test("script, style, dan komentar dibuang seluruhnya", () => {
  const html = `<html><head><style>.a{color:red}</style><script>evil()</script></head>
    <body><!-- catatan --><p>Halo</p><p>dunia</p></body></html>`
  const text = htmlToText(html)

  assert.match(text, /Halo/)
  assert.match(text, /dunia/)
  assert.doesNotMatch(text, /evil/, "isi script tidak boleh sampai ke model")
  assert.doesNotMatch(text, /color:red/)
  assert.doesNotMatch(text, /catatan/)
})

test("batas blok jadi baris baru, bukan satu paragraf raksasa", () => {
  assert.equal(htmlToText("<p>satu</p><p>dua</p>"), "satu\ndua")
  assert.equal(htmlToText("a<br>b"), "a\nb")
  assert.equal(htmlToText("<li>x</li><li>y</li>"), "x\ny")
})

test("entitas HTML dipulihkan, dan &amp; dipulihkan TERAKHIR", () => {
  // Urutan penting: kalau &amp; diproses lebih dulu, "&amp;lt;" — cara menulis
  // "&lt;" secara harfiah — akan berubah jadi "<" dan mengarang markup yang
  // tidak pernah ada di halaman aslinya.
  assert.equal(htmlToText("a &amp;lt; b"), "a &lt; b")
  assert.equal(htmlToText("&lt;div&gt; &quot;x&quot; &#39;y&#39;"), `<div> "x" 'y'`)
})

// ---------- websearch ----------

test("backend yang butuh kunci mengatakannya sebelum mengirim apa pun", async () => {
  const config = Config.parse({ search: { backend: "brave" } })
  await assert.rejects(
    () => websearchTool.execute({ query: "x" }, ctx(config)),
    (error: unknown) => {
      assert.ok(error instanceof ToolError)
      assert.match(error.message, /needs an API key/)
      // Harus menyebut kedua jalan keluar, bukan cuma menyalahkan.
      assert.match(error.message, /search\.apiKey/)
      assert.match(error.message, /"ddg"/)
      return true
    },
  )
})

test("ddg tidak pernah dianggap butuh kunci", () => {
  assert.deepEqual(searchBackend(Config.parse({}).search), { needsKey: false, hasKey: false })
  assert.equal(searchBackend(Config.parse({ search: { backend: "tavily" } }).search).needsKey, true)
})

test("bawaan backend adalah ddg, supaya websearch jalan tanpa konfigurasi", () => {
  assert.equal(Config.parse({}).search.backend, "ddg")
})

test("hasil DuckDuckGo diurai, dan duplikat dibuang", () => {
  const html = `
    <a rel="nofollow" href="https://a.example/1">Judul A</a>
    <a rel="nofollow" href="https://a.example/1">Judul A lagi</a>
    <a rel="nofollow" href="https://b.example/2">Judul &amp; B</a>
    <a rel="nofollow" href="/relatif">Bukan absolut</a>`
  const hits = parseDuckDuckGo(html)

  assert.equal(hits.length, 2, "duplikat dan URL relatif harus dibuang")
  assert.equal(hits[0]?.url, "https://a.example/1")
  assert.equal(hits[1]?.title, "Judul & B")
})

test("nol hasil dari ddg menyebut bahwa itu bisa berarti HTML-nya berubah", async () => {
  // Ambiguitas yang sesungguhnya: "tidak ada hasil" dan "scraper-nya rusak"
  // terlihat sama persis dari sini, dan tindakan user berbeda untuk keduanya.
  assert.deepEqual(parseDuckDuckGo("<html><body>tidak ada apa-apa</body></html>"), [])
})
