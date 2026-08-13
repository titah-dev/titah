import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  BUNDLE_VERSION,
  BundleError,
  exportBundle,
  mergeConfig,
  parseBundle,
  planImport,
  stripSecrets,
} from "../src/core/portable.ts"
import type { Json } from "../src/core/config.ts"

const NOW = new Date("2026-08-13T00:00:00.000Z")

// ---------- rahasia ----------

test("apiKey literal dibuang, dan jalurnya disebutkan", () => {
  /*
   * Diam bukan pilihan. Orang yang memasang bundel ini di mesin lain harus tahu
   * persis apa yang masih harus ia isi — menemukannya sebagai kegagalan pada
   * giliran pertama jauh lebih mahal daripada membacanya saat mengekspor.
   */
  const bundle = exportBundle(
    { provider: { acme: { options: { apiKey: "sk-rahasia", baseURL: "http://x" } } } },
    "0.1.0",
    NOW,
  )

  assert.deepEqual(bundle.secretsDropped, ["provider.acme.options.apiKey"])
  assert.equal(JSON.stringify(bundle.config).includes("sk-rahasia"), false)
  assert.match(JSON.stringify(bundle.config), /baseURL/, "yang bukan rahasia tetap ikut")
})

test("rujukan ${env:...} DIPERTAHANKAN — ia petunjuk, bukan rahasianya", () => {
  const bundle = exportBundle(
    { provider: { acme: { options: { apiKey: "${env:ACME_KEY}" } } } },
    "0.1.0",
    NOW,
  )

  assert.deepEqual(bundle.secretsDropped, [], "tidak ada yang dibuang")
  assert.match(JSON.stringify(bundle.config), /\$\{env:ACME_KEY\}/)
})

test("header yang namanya berbau rahasia ikut dibuang, sisanya tidak", () => {
  const dropped: string[] = []
  const bersih = stripSecrets(
    {
      provider: {
        acme: {
          options: {
            headers: { Authorization: "Bearer abc", "X-Tenant": "titah", "X-Api-Key": "k" },
          },
        },
      },
    },
    dropped,
  )

  assert.deepEqual(dropped.sort(), [
    "provider.acme.options.headers.Authorization",
    "provider.acme.options.headers.X-Api-Key",
  ])
  assert.match(JSON.stringify(bersih), /X-Tenant/, "header biasa tetap ikut")
})

test("provider yang tidak dikenal skema tetap dibersihkan", () => {
  // Pembersihnya bekerja atas BENTUK config mentah, bukan atas skema Zod —
  // jadi provider apa pun yang user tulis ikut tersaring.
  const dropped: string[] = []
  stripSecrets({ provider: { "provider-baru-2030": { options: { apiKey: "x" } } } }, dropped)
  assert.deepEqual(dropped, ["provider.provider-baru-2030.options.apiKey"])
})

// ---------- bentuk bundel ----------

test("bundel membawa versi Titah dan versi formatnya sendiri", () => {
  const bundle = exportBundle({ model: "a/b" }, "0.1.0", NOW)
  assert.equal(bundle.titah, "0.1.0")
  assert.equal(bundle.bundleVersion, BUNDLE_VERSION)
  assert.equal(bundle.exportedAt, "2026-08-13T00:00:00.000Z")
})

test("titah.json biasa yang dikira bundel ditolak dengan kalimat yang menjelaskan", () => {
  /*
   * Ini kekeliruan yang paling mungkin terjadi, dan pesannya harus menyebutkan
   * jalan keluarnya. `undefined is not an object` beberapa baris kemudian tidak
   * memberi tahu apa pun.
   */
  assert.throws(
    () => parseBundle(JSON.stringify({ model: "a/b" })),
    (error: unknown) =>
      error instanceof BundleError && /looks like a plain titah\.json/.test((error as Error).message),
  )
})

test("bundel dari versi yang lebih baru ditolak, bukan dipaksakan", () => {
  // Memaksakannya berarti diam-diam mengabaikan kunci yang versi ini tidak
  // kenal — dan yang diabaikan diam-diam adalah yang paling mahal.
  assert.throws(
    () => parseBundle(JSON.stringify({ config: {}, bundleVersion: BUNDLE_VERSION + 1 })),
    (error: unknown) => error instanceof BundleError && /Upgrade Titah/.test((error as Error).message),
  )
})

test("JSON rusak dan JSON bukan-objek punya pesannya masing-masing", () => {
  assert.throws(() => parseBundle("{rusak"), (e: unknown) => /Not valid JSON/.test((e as Error).message))
  assert.throws(() => parseBundle("[1,2]"), (e: unknown) => /must be a JSON object/.test((e as Error).message))
})

// ---------- rencana impor ----------

test("hanya kunci yang BERUBAH yang dilaporkan", () => {
  /*
   * Mencantumkan kunci yang isinya sudah sama membuat daftar panjang yang di
   * dalamnya perubahan sungguhan jadi sulit ditemukan — dan daftar yang tidak
   * dibaca sama saja dengan tidak ada konfirmasi.
   */
  const changes = planImport(
    { model: "a/b", agent: { plan: { model: "x/y" } } },
    { model: "a/b", agent: { plan: { model: "z/w" } }, smallModel: "kecil" },
  )

  assert.deepEqual(
    changes.map((c) => c.path).sort(),
    ["agent.plan.model", "smallModel"],
  )
  assert.equal(changes.find((c) => c.path === "smallModel")?.before, undefined, "yang baru: (unset)")
})

test("impor MENGGABUNG, tidak mengganti berkasnya", () => {
  /*
   * Ini yang menjaga kredensial lokal tetap hidup. Impor yang mengganti seluruh
   * berkas akan membuang apa yang justru sengaja tidak ikut diekspor — orang
   * kehilangan apiKey-nya sendiri karena memasang config dari rekan kerja.
   */
  const current: Json = { provider: { acme: { options: { apiKey: "punya-saya" } } }, model: "lama" }
  const hasil = mergeConfig(current, { model: "baru", smallModel: "kecil" })

  assert.equal((hasil as Record<string, Json>)["model"], "baru")
  assert.match(JSON.stringify(hasil), /punya-saya/, "kredensial lokal tidak ikut terbuang")
})

// ---------- lewat CLI sungguhan ----------

const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js")

function jalankan(args: string[], home: string) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
  })
}

test("bolak-balik lewat biner: export di satu HOME, import di HOME lain", () => {
  /*
   * Diuji dengan MENJALANKAN binernya, bukan memanggil fungsinya. Yang
   * dibuktikan di sini bukan logika penggabungan — itu sudah diuji di atas —
   * melainkan bahwa perintahnya benar-benar terpasang di dispatcher, menulis ke
   * berkas yang benar, dan tidak menulis apa pun tanpa `-y`.
   */
  const asal = fs.mkdtempSync(path.join(os.tmpdir(), "titah-asal-"))
  const tujuan = fs.mkdtempSync(path.join(os.tmpdir(), "titah-tujuan-"))
  const configAsal = path.join(asal, ".config", "titah")
  fs.mkdirSync(configAsal, { recursive: true })
  fs.writeFileSync(
    path.join(configAsal, "titah.json"),
    JSON.stringify({ model: "acme/besar", provider: { acme: { options: { apiKey: "sk-bocor" } } } }),
  )

  const bundelFile = path.join(asal, "bundel.json")
  jalankan(["export", "--out", bundelFile], asal)

  const bundel = fs.readFileSync(bundelFile, "utf8")
  assert.equal(bundel.includes("sk-bocor"), false, "kunci tidak boleh ikut keluar")
  assert.match(bundel, /provider\.acme\.options\.apiKey/, "tapi jalurnya disebut")

  // Tanpa -y: memperlihatkan, tidak menulis.
  const pratinjau = jalankan(["import", bundelFile], tujuan)
  assert.match(pratinjau, /model/)
  assert.match(pratinjau, /Nothing written/)
  assert.equal(
    fs.existsSync(path.join(tujuan, ".config", "titah", "titah.json")),
    false,
    "tanpa -y tidak ada berkas yang dibuat",
  )

  // Dengan -y: ditulis.
  jalankan(["import", bundelFile, "-y"], tujuan)
  const ditulis = JSON.parse(
    fs.readFileSync(path.join(tujuan, ".config", "titah", "titah.json"), "utf8"),
  ) as Record<string, unknown>
  assert.equal(ditulis["model"], "acme/besar")
  assert.equal(JSON.stringify(ditulis).includes("sk-bocor"), false)

  // Impor kedua tidak menemukan apa pun untuk diubah.
  assert.match(jalankan(["import", bundelFile], tujuan), /Nothing to change/)
})
