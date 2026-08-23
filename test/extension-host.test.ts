import assert from "node:assert/strict"
import test from "node:test"
import type { LoadedExtension } from "../src/core/extension.ts"
import type { RenderRequest, View } from "../src/extension.ts"
import { errorLines, renderPanel } from "../src/tui/extension-host.ts"

function fake(render: (request: RenderRequest) => unknown, spec = "./x"): LoadedExtension {
  return { spec, side: "left", panel: { title: "X", render: render as (r: RenderRequest) => View } }
}

test("render yang berhasil menghasilkan baris, tanpa error", async () => {
  const result = await renderPanel({
    extension: fake(() => ({ kind: "rows", rows: [{ text: "main" }] })),
    width: 20,
    rows: 8,
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.lines, [{ text: "main" }])
})

test("extension menerima lebar yang SUDAH bersih dari bingkai", async () => {
  /*
   * Kalau extension harus menguranginya sendiri, setiap extension menebak
   * berapa yang diambil bingkai — dan tebakan yang salah muncul sebagai teks
   * yang membungkus, dengan Titah yang disalahkan.
   */
  let seen: { width: number; rows: number } | undefined
  await renderPanel({
    extension: fake((request) => {
      seen = { width: request.width, rows: request.rows }
      return { kind: "text", text: "" }
    }),
    width: 20,
    rows: 8,
  })
  assert.deepEqual(seen, { width: 16, rows: 5 })
})

test("render yang melempar menghasilkan pesannya, bukan lemparan yang lolos", async () => {
  const result = await renderPanel({
    extension: fake(() => {
      throw new Error("git tidak ditemukan")
    }),
    width: 20,
    rows: 8,
  })
  assert.equal(result.error, "git tidak ditemukan")
  assert.deepEqual(result.lines, [])
})

test("render yang menggantung dibatalkan dan dilaporkan sebagai timeout", async () => {
  /*
   * Dilaporkan sebagai timeout dan bukan sebagai "aborted": AbortError adalah
   * nama yang benar secara teknis dan tidak berguna secara praktis — ia tidak
   * memberi tahu bahwa yang membatalkan adalah batas waktu Titah, jadi orang
   * akan mencari pembatalan di kode extension-nya.
   */
  const result = await renderPanel({
    extension: fake(
      (request) =>
        new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    ),
    width: 20,
    rows: 8,
    timeoutMs: 30,
  })
  assert.match(result.error ?? "", /timed out after 30ms/)
})

test("signal benar-benar diberi tahu, bukan hanya dijanjikan", async () => {
  // Extension yang mengabaikan signal tetap bekerja untuk hasil yang tidak
  // dipakai — dan pekerjaan itu bersaing dengan giliran agent di proses yang
  // sama. Jadi signal harus sungguh menyala.
  let aborted = false
  await renderPanel({
    extension: fake(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted = true
            resolve({ kind: "text", text: "" })
          })
        }),
    ),
    width: 20,
    rows: 8,
    timeoutMs: 20,
  })
  assert.equal(aborted, true)
})

test("bentuk yang bukan View ditolak di sini, bukan diteruskan ke renderer", async () => {
  /*
   * Cabang yang lupa `return` mengembalikan `undefined`. Diteruskan, ia meledak
   * di dalam `viewLines` dengan pesan tentang `kind` — dan pesan itu menunjuk
   * berkas Titah, bukan berkas extension yang sebenarnya salah.
   */
  for (const bad of [undefined, null, 42, "rows", {}, { kind: "nope" }, { kind: "rows" }, { kind: "text" }]) {
    const result = await renderPanel({ extension: fake(() => bad), width: 20, rows: 8 })
    assert.match(result.error ?? "", /unknown view shape/, `lolos: ${JSON.stringify(bad)}`)
  }
})

test("view yang bentuknya benar tapi isinya kosong TIDAK dianggap salah", async () => {
  // Daftar branch yang kosong adalah keadaan yang sah, dan melaporkannya
  // sebagai kegagalan menuduh extension atas repo yang memang belum punya apa
  // pun.
  const result = await renderPanel({ extension: fake(() => ({ kind: "rows", rows: [] })), width: 20, rows: 8 })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.lines, [])
})

test("pesan error dibuka dengan penanda merah, lalu sebabnya", async () => {
  const lines = errorLines("git: command not found")
  assert.equal(lines[0]?.color, "red")
  assert.equal(lines[1]?.text, "git: command not found")
})

test("panel yang error menyebut spec-nya, supaya tahu extension mana", async () => {
  const result = await renderPanel({
    extension: fake(() => undefined, "@acme/titah-git"),
    width: 20,
    rows: 8,
  })
  assert.match(result.error ?? "", /@acme\/titah-git/)
})
