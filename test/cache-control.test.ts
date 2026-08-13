import assert from "node:assert/strict"
import http from "node:http"
import test, { after } from "node:test"
import { EPHEMERAL, markCacheControl, withCacheControl } from "../src/core/cache-control.ts"

const closers: (() => void)[] = []
after(() => {
  for (const close of closers) close()
})

const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: "ant",
  messages,
  ...extra,
})

const systemOf = (result: unknown) =>
  ((result as { messages: Record<string, unknown>[] }).messages[0] as Record<string, unknown>)

// ---------- penandaan ----------

test("system berupa string diubah jadi blok, lalu ditandai", () => {
  /*
   * Harus ada blok supaya ada tempat menaruh tandanya. Bentuk ini diterima
   * gateway yang meneruskan ke Anthropic, dan diabaikan dengan aman oleh yang
   * benar-benar OpenAI.
   */
  const marked = markCacheControl(body([{ role: "system", content: "kamu Titah" }]))
  assert.deepEqual(systemOf(marked)["content"], [
    { type: "text", text: "kamu Titah", cache_control: EPHEMERAL },
  ])
})

test("tandanya di system, karena itu yang mencakup tool DAN prompt", () => {
  /*
   * `cache_control` menandai UJUNG sebuah awalan, bukan satu blok sendirian.
   * Urutan Anthropic adalah tools → system → messages, jadi satu tanda di ujung
   * system mencakup seluruh definisi tool sekaligus — ~10.200 token pada Titah,
   * dan tidak ada tanda lain yang mencakup sebanyak itu.
   */
  const marked = markCacheControl(
    body([
      { role: "system", content: "S" },
      { role: "user", content: "halo" },
    ]),
  )

  const messages = (marked as { messages: Record<string, unknown>[] }).messages
  assert.ok(JSON.stringify(messages[0]).includes("cache_control"))
  assert.equal(JSON.stringify(messages[1]).includes("cache_control"), false, "ekor tidak ditandai")
})

test("system yang sudah berupa blok ditandai di blok TERAKHIR", () => {
  const marked = markCacheControl(
    body([{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]),
  )
  const blocks = systemOf(marked)["content"] as Record<string, unknown>[]
  assert.equal("cache_control" in (blocks[0] as object), false)
  assert.deepEqual(blocks[1]?.["cache_control"], EPHEMERAL)
})

test("tanda tidak pernah ditumpuk", () => {
  // Dua tanda pada blok yang sama bukan sekadar mubazir — sebagian gateway
  // menolak permintaannya.
  const once = markCacheControl(body([{ role: "system", content: "S" }]))
  const twice = markCacheControl(once)
  assert.equal(twice, once, "yang sudah ditandai dikembalikan apa adanya")
})

test("system yang tidak ada, kosong, atau bukan pesan sama sekali dibiarkan", () => {
  /*
   * Fungsi ini duduk di jalur SETIAP permintaan model. Kehilangan cache berarti
   * membayar lebih; permintaan yang rusak berarti giliran yang mati. Yang kedua
   * jauh lebih mahal, jadi apa pun yang tidak dikenali lewat apa adanya.
   */
  for (const input of [
    body([{ role: "user", content: "halo" }]),
    body([{ role: "system", content: "" }]),
    body([]),
    body([{ role: "system", content: [] }]),
    { tanpa: "messages" },
    "bukan objek",
    null,
  ]) {
    assert.equal(markCacheControl(input), input, `disentuh padahal tidak seharusnya: ${JSON.stringify(input)}`)
  }
})

test("field lain di badan permintaan tidak tersentuh", () => {
  const marked = markCacheControl(
    body([{ role: "system", content: "S" }], { tools: [{ name: "read" }], stream: true }),
  ) as Record<string, unknown>

  assert.equal(marked["stream"], true)
  assert.deepEqual(marked["tools"], [{ name: "read" }])
  assert.equal(marked["model"], "ant")
})

// ---------- pembungkus fetch ----------

async function serve(): Promise<{ url: string; seen: unknown[] }> {
  const seen: unknown[] = []
  const server = http.createServer((req, res) => {
    let text = ""
    req.on("data", (chunk) => (text += chunk))
    req.on("end", () => {
      try {
        seen.push(JSON.parse(text))
      } catch {
        seen.push(text)
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  closers.push(() => server.close())
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

test("tanda benar-benar sampai di KABEL, bukan cuma di objeknya", async () => {
  /*
   * Ini yang membedakan perbaikan ini dari yang sebelumnya. `providerOptions`
   * bernamespace per provider: tanda yang ditulis di namespace `anthropic`
   * dibuang provider openai-compatible sebelum menyentuh kabel, diam-diam dan
   * tanpa error. Jadi satu-satunya bukti yang berarti adalah badan permintaan
   * yang benar-benar diterima server.
   */
  const { url, seen } = await serve()
  const wrapped = withCacheControl()

  await wrapped(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body([{ role: "system", content: "S" }, { role: "user", content: "hai" }])),
  })

  const sent = seen[0] as { messages: Record<string, unknown>[] }
  assert.deepEqual(sent.messages[0]?.["content"], [
    { type: "text", text: "S", cache_control: EPHEMERAL },
  ])
})

test("permintaan tanpa badan JSON lewat tanpa disentuh", async () => {
  const { url, seen } = await serve()
  await withCacheControl()(url, { method: "POST", body: "bukan json" })
  assert.equal(seen[0], "bukan json")
})

test("permintaan tanpa badan sama sekali tidak menjatuhkan apa pun", async () => {
  const { url } = await serve()
  const response = await withCacheControl()(url, { method: "GET" })
  assert.equal(response.status, 200)
})

test("fetch dasar yang melempar tetap melempar apa adanya", async () => {
  // Pembungkus ini tidak boleh menelan kegagalan jaringan: yang hilang bukan
  // cache melainkan pesan error yang menjelaskan giliran gagal kenapa.
  const meledak = () => Promise.reject(new Error("jaringan mati"))
  await assert.rejects(
    () => withCacheControl(meledak as unknown as typeof fetch)("http://x", { method: "GET" }),
    /jaringan mati/,
  )
})
