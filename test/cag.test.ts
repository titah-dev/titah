import assert from "node:assert/strict"
import type { ModelMessage } from "ai"
import test from "node:test"
import {
  MIN_CACHEABLE_TOKENS,
  buildCachedRequest,
  shouldCache,
  tokensOf,
  withCacheBreakpoint,
} from "../src/core/cag.ts"

/**
 * Cache-Augmented Generation.
 *
 * Yang diuji bukan "cache-nya kena" — itu milik provider dan tidak bisa
 * diperiksa dari sini tanpa jaringan. Yang diuji adalah SATU-SATUNYA hal yang
 * ada di tangan Titah: bentuk permintaannya. Cache dikunci pada awalan yang
 * identik byte demi byte, jadi urutan stabil→volatil adalah keseluruhan
 * mekanismenya, dan urutan itu bisa dipaku persis.
 */

const big = "x".repeat(MIN_CACHEABLE_TOKENS * 4 + 100) // > ambang, dalam byte
const small = "x".repeat(100)

const msg = (role: "user" | "assistant", content: string): ModelMessage =>
  ({ role, content }) as ModelMessage

// ---------- kapan CAG dipakai ----------

test("awalan di bawah ambang tidak pernah ditandai", () => {
  // Menandai blok yang terlalu kecil menambah overhead tanpa memberi apa pun,
  // dan Anthropic memang menolaknya.
  const decision = shouldCache({ npm: "@ai-sdk/anthropic", systemText: small, historyLength: 10 })
  assert.equal(decision.style, "off")
  assert.match(decision.reason, /below the 1024-token floor/)
})

test("giliran pertama tidak menulis cache yang tidak akan dibaca", () => {
  // Menulis cache lebih mahal daripada membacanya. Kalau tidak akan ada giliran
  // kedua, itu rugi bersih.
  const decision = shouldCache({ npm: "@ai-sdk/anthropic", systemText: big, historyLength: 0 })
  assert.equal(decision.style, "prefix-only")
  assert.match(decision.reason, /first turn/)
})

test("giliran kedua dan seterusnya memakai cache_control pada Anthropic", () => {
  const decision = shouldCache({ npm: "@ai-sdk/anthropic", systemText: big, historyLength: 2 })
  assert.equal(decision.style, "anthropic")
})

test("endpoint openai-compatible tidak pernah ditandai, hanya diurutkan", () => {
  // Prefix caching di sana otomatis di sisi server. Mengirim cache_control ke
  // endpoint yang tidak memahaminya menukar penghematan nol dengan risiko
  // permintaan ditolak.
  const decision = shouldCache({
    npm: "@ai-sdk/openai-compatible",
    systemText: big,
    historyLength: 10,
  })
  assert.equal(decision.style, "prefix-only")
  assert.match(decision.reason, /ordering is what matters/)
})

test("tokensOf memakai penggaris yang sama dengan pemadatan", () => {
  assert.equal(tokensOf("abcd"), 1)
  assert.equal(tokensOf("abcde"), 2)
})

// ---------- bentuk permintaan ----------

test("system prompt TIDAK boleh masuk ke messages — AI SDK v7 menolaknya", () => {
  // Rancangan pertama memindahkannya ke sana supaya bisa membawa cache_control
  // sendiri, dan AI SDK v7 menolak: "System messages are not allowed in the
  // prompt or messages fields." Ditemukan oleh test sub-agent, bukan oleh
  // membaca dokumentasi. Test ini menjaga rancangan itu tidak kembali.
  const { messages } = buildCachedRequest({
    protectedBlock: [],
    tail: [msg("user", "halo")],
    decision: { style: "off", reason: "" },
  })
  assert.ok(
    messages.every((message) => message.role !== "system"),
    "tidak boleh ada pesan berperan system",
  )
  assert.equal(messages[0]?.content, "halo")
})

test("urutannya stabil → volatil, dan itu SELURUH mekanismenya", () => {
  const { messages } = buildCachedRequest({
    protectedBlock: [msg("user", "RINGKASAN"), msg("assistant", "ok")],
    tail: [msg("user", "EKOR")],
    decision: { style: "off", reason: "" },
  })
  assert.deepEqual(
    messages.map((m) => String(m.content)),
    ["RINGKASAN", "ok", "EKOR"],
  )
})

test("breakpoint dipasang di UJUNG blok stabil, bukan di tengahnya", () => {
  // Kalau dipasang pada system padahal ada blok terlindungi sesudahnya, segmen
  // cache berhenti terlalu awal dan ringkasan ikut dihitung ulang tiap giliran.
  const { messages, breakpoints } = buildCachedRequest({
    protectedBlock: [msg("user", "RINGKASAN"), msg("assistant", "ok")],
    tail: [msg("user", "EKOR")],
    decision: { style: "anthropic", reason: "" },
  })

  assert.equal(breakpoints, 1)
  assert.equal(messages[0]?.providerOptions, undefined)
  // Tanda di UJUNG blok stabil. Segmen yang di-cache adalah semua yang
  // MENDAHULUINYA — termasuk system prompt dan definisi tool, yang berada
  // paling depan dan tidak pernah bisa ditandai langsung.
  assert.deepEqual(messages[1]?.providerOptions?.["anthropic"], { cacheControl: { type: "ephemeral" } })
  assert.equal(messages[2]?.providerOptions, undefined, "ekor tidak pernah ditandai")
})

test("tanpa blok stabil, tanda jatuh pada pesan PERTAMA percakapan", () => {
  // Ia stabil — tidak pernah berubah lagi setelah ditulis — dan tanpa tanda apa
  // pun Anthropic tidak meng-cache apa pun, justru pada giliran awal ketika
  // system prompt adalah hampir seluruh permintaan.
  const { messages, breakpoints } = buildCachedRequest({
    protectedBlock: [],
    tail: [msg("user", "PERTAMA"), msg("assistant", "a"), msg("user", "KEDUA")],
    decision: { style: "anthropic", reason: "" },
  })
  assert.equal(breakpoints, 1)
  assert.deepEqual(messages[0]?.providerOptions?.["anthropic"], { cacheControl: { type: "ephemeral" } })
  assert.equal(messages[2]?.providerOptions, undefined)
})

test("ekor TIDAK pernah ditandai, seberapa pun panjangnya", () => {
  // Ekor berubah tiap langkah. Menandainya berarti menulis cache yang tidak
  // akan pernah dibaca — persis kerugian yang aturan giliran-pertama hindari.
  const tail = Array.from({ length: 20 }, (_, i) => msg("user", `p${i}`))
  const { messages, breakpoints } = buildCachedRequest({
    protectedBlock: [msg("user", "S")],
    tail,
    decision: { style: "anthropic", reason: "" },
  })
  assert.equal(breakpoints, 1, "Anthropic membatasi empat; satu di tempat yang tepat sudah cukup")
  for (const message of messages.slice(1)) {
    assert.equal(message.providerOptions, undefined)
  }
})

test("provider non-Anthropic tidak menerima providerOptions sama sekali", () => {
  const marked = withCacheBreakpoint(msg("user", "x"), "prefix-only")
  assert.equal(marked.providerOptions, undefined)
})

test("penandaan tidak menghapus providerOptions yang sudah ada", () => {
  const original = { role: "user", content: "x", providerOptions: { openai: { foo: 1 } } } as ModelMessage
  const marked = withCacheBreakpoint(original, "anthropic")
  assert.deepEqual(marked.providerOptions?.["openai"], { foo: 1 })
  assert.deepEqual(marked.providerOptions?.["anthropic"], { cacheControl: { type: "ephemeral" } })
})

test("merakit ulang menghasilkan bentuk yang identik untuk masukan yang identik", () => {
  // Determinisme BUKAN detail: awalan yang berbeda satu byte membatalkan
  // seluruh cache. Perakit yang menyisipkan timestamp atau id acak akan
  // membuat cache tidak pernah kena, dan tidak ada yang akan menyadarinya
  // selain tagihan.
  const input = {
    protectedBlock: [msg("user", "S")],
    tail: [msg("user", "E")],
    decision: { style: "anthropic" as const, reason: "" },
  }
  assert.deepEqual(buildCachedRequest(input).messages, buildCachedRequest(input).messages)
})
