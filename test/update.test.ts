import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { checkUpdate, updateNotice, UPDATE_TTL_MS } from "../src/core/update.ts"

function scratch(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "titah-update-")), "update.json")
}

const npmSays = (version: string) => async () => JSON.stringify({ version })

test("versi yang lebih baru dilaporkan beserta perintahnya", async () => {
  // "0.3.0 available" menyuruh orang mengingat cara memasangnya. Menyebut
  // perintahnya membuat baris itu lengkap sendiri.
  const status = await checkUpdate({ current: "0.2.1", file: scratch(), fetcher: npmSays("0.3.0") })
  assert.deepEqual(status, { current: "0.2.1", latest: "0.3.0", newer: true })
  assert.equal(updateNotice(status), "0.3.0 available — run titah upgrade")
})

test("versi yang sama tidak melaporkan apa pun", async () => {
  const status = await checkUpdate({ current: "0.2.1", file: scratch(), fetcher: npmSays("0.2.1") })
  assert.equal(status.newer, false)
  assert.equal(updateNotice(status), undefined)
})

test("versi npm yang lebih TUA tidak dilaporkan sebagai update", async () => {
  // Terjadi sungguhan saat menjalankan build lokal yang mendahului rilis.
  const status = await checkUpdate({ current: "0.3.0", file: scratch(), fetcher: npmSays("0.2.1") })
  assert.equal(status.newer, false)
})

test("perbandingan dua digit tidak jatuh ke perbandingan string", async () => {
  /*
   * `"0.10.0" > "0.9.0"` bernilai false secara leksikografis. Perbandingan
   * string membuat update yang menyeberangi angka dua digit — yang biasanya
   * justru yang paling penting — jadi satu-satunya yang tidak pernah
   * dilaporkan.
   */
  const status = await checkUpdate({ current: "0.9.0", file: scratch(), fetcher: npmSays("0.10.0") })
  assert.equal(status.newer, true)
})

test("cache mencegah request kedua di dalam TTL", async () => {
  const file = scratch()
  let calls = 0
  const fetcher = async () => { calls++; return JSON.stringify({ version: "0.3.0" }) }
  await checkUpdate({ current: "0.2.1", file, fetcher, now: 0 })
  await checkUpdate({ current: "0.2.1", file, fetcher, now: UPDATE_TTL_MS - 1 })
  assert.equal(calls, 1)
})

test("cache kedaluwarsa memicu request lagi", async () => {
  const file = scratch()
  let calls = 0
  const fetcher = async () => { calls++; return JSON.stringify({ version: "0.3.0" }) }
  await checkUpdate({ current: "0.2.1", file, fetcher, now: 0 })
  await checkUpdate({ current: "0.2.1", file, fetcher, now: UPDATE_TTL_MS + 1 })
  assert.equal(calls, 2)
})

test("jaringan mati tanpa cache DIAM, bukan melaporkan kegagalan", async () => {
  /*
   * Satu-satunya tempat di Titah yang sengaja menyembunyikan kegagalan, dan
   * alasannya spesifik: user tidak meminta pemeriksaan ini, jadi memberitahunya
   * bahwa pemeriksaan yang tidak ia minta gagal adalah gangguan tanpa tindakan
   * yang bisa ia ambil.
   */
  const status = await checkUpdate({
    current: "0.2.1",
    file: scratch(),
    fetcher: async () => { throw new Error("ENOTFOUND") },
  })
  assert.deepEqual(status, { current: "0.2.1", newer: false })
  assert.equal(updateNotice(status), undefined)
})

test("jaringan mati DENGAN cache tetap memakai versi yang diketahui kemarin", async () => {
  // Versi yang diketahui kemarin tidak jadi salah karena hari ini jaringannya
  // mati.
  const file = scratch()
  await checkUpdate({ current: "0.2.1", file, fetcher: npmSays("0.3.0"), now: 0 })
  const offline = await checkUpdate({
    current: "0.2.1",
    file,
    fetcher: async () => { throw new Error("ENOTFOUND") },
    now: UPDATE_TTL_MS + 1,
  })
  assert.equal(offline.newer, true)
  assert.equal(offline.latest, "0.3.0")
})

test("balasan npm tanpa field version diperlakukan sebagai kegagalan", async () => {
  const status = await checkUpdate({
    current: "0.2.1",
    file: scratch(),
    fetcher: async () => JSON.stringify({ name: "titah-code" }),
  })
  assert.equal(status.newer, false)
})
