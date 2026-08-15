import assert from "node:assert/strict"
import test from "node:test"
import {
  effectivePermission,
  maySpawnExternal,
  narrower,
  type EffectivePermission,
} from "../src/core/permission.ts"
import { Agent, Config, DEFAULT_AGENTS } from "../src/core/schema.ts"

/**
 * Batas atas izin untuk sub-agent.
 *
 * Tanpa ini, `plan` — yang `edit` dan `write`-nya `deny` — bisa memanggil
 * `task("senior-developer")` dan agent itu menulis berkas dengan bebas. Batas
 * Plan mode bocor lewat delegasi, dan bocornya lewat jalan yang justru
 * disediakan Titah sendiri.
 */

/**
 * Izin efektif satu agent.
 *
 * Preset bawaan disuntik di sini karena `Config.parse` TIDAK melakukannya —
 * penyuntikannya ada di `loadConfig`. Tanpa ini `of("plan")` diam-diam
 * mengembalikan izin global (semua "ask") dan setiap assertion tentang plan
 * lulus karena alasan yang salah.
 */
const of = (agent: string, config: Record<string, unknown> = {}) => {
  const parsed = Config.parse(config)
  for (const [id, preset] of Object.entries(DEFAULT_AGENTS)) {
    if (parsed.agent[id] === undefined) parsed.agent[id] = Agent.parse(preset)
  }
  return effectivePermission(parsed, agent, parsed.agent[agent])
}

// ---------- irisan ----------

test("induk yang lebih ketat menang", () => {
  const parent = of("plan")
  const child = of("penulis", { agent: { penulis: { permission: { edit: "allow", write: "allow" } } } })
  const hasil = narrower(parent, child)

  assert.equal(hasil.edit, "deny", "plan tidak boleh menyunting, jadi bawahannya juga tidak")
  assert.equal(hasil.write, "deny")
})

test("anak yang lebih ketat juga menang — irisannya dua arah", () => {
  /*
   * `deny` milik anak adalah pernyataan tentang dirinya sendiri, bukan sekadar
   * bawaan yang boleh ditimpa. Induk yang longgar tidak melonggarkannya.
   */
  const parent = of("bebas", { agent: { bebas: { permission: { edit: "allow", write: "allow" } } } })
  const child = of("pembaca", { agent: { pembaca: { permission: { edit: "deny", write: "deny" } } } })
  const hasil = narrower(parent, child)

  assert.equal(hasil.edit, "deny")
  assert.equal(hasil.write, "deny")
})

test("ask berada di antara allow dan deny", () => {
  // Urutannya menentukan: kalau `ask` diperlakukan setara `allow`, induk yang
  // bertanya akan diam-diam melepaskan anak yang seharusnya juga bertanya.
  const longgar: EffectivePermission = { ...of("x"), bash: "allow" }
  const tanya: EffectivePermission = { ...of("x"), bash: "ask" }
  const tolak: EffectivePermission = { ...of("x"), bash: "deny" }

  assert.equal(narrower(longgar, tanya).bash, "ask")
  assert.equal(narrower(tanya, longgar).bash, "ask")
  assert.equal(narrower(tanya, tolak).bash, "deny")
  assert.equal(narrower(tolak, longgar).bash, "deny")
})

test("build-auto tetap bisa memberi kebebasan penuh ke bawahannya", () => {
  /*
   * Jaring pengaman ke arah sebaliknya. Perbaikan keamanan yang diam-diam
   * mematikan jalur yang sah lebih buruk daripada tidak ada perbaikan: orang
   * akan mematikannya seluruhnya.
   */
  const parent = of("build-auto")
  const child = of("penulis", {
    agent: { penulis: { permission: { edit: "allow", write: "allow", bash: "allow" } } },
  })
  const hasil = narrower(parent, child)

  assert.equal(hasil.edit, "allow")
  assert.equal(hasil.write, "allow")
  assert.equal(hasil.bash, "allow")
})

test("sumbu yang TIDAK disebut anak tetap jatuh ke global, bukan ikut induk", () => {
  /*
   * Induk `build-auto` serba `allow` tidak melonggarkan sumbu yang anak
   * sendiri tidak pernah buka. Anak yang diam soal `bash` mewarisi global —
   * "ask" — dan irisan mempertahankannya. Induk memberi BATAS ATAS, bukan izin.
   */
  const parent = of("build-auto")
  const child = of("penulis", { agent: { penulis: { permission: { write: "allow" } } } })

  assert.equal(narrower(parent, child).bash, "ask")
})

test("rules dan allowlist DIGABUNG, bukan diambil yang lebih sedikit", () => {
  /*
   * Keduanya bekerja di lapisan yang berbeda dari sumbu: sumbu memutuskan kelas
   * tindakan, aturan memutuskan argumen. Aturan `deny` induk tetap terbawa;
   * aturan `allow` anak tidak bisa membuka sumbu yang sudah `deny`, karena
   * `decide()` memeriksa sumbu lebih dulu.
   */
  const parent = of("a", {
    permission: { rules: { "bash(rm *)": "deny" } },
    agent: { a: {} },
  })
  const child = of("b", {
    permission: { rules: { "bash(git *)": "allow" } },
    agent: { b: {} },
  })
  const hasil = narrower(parent, child)

  const sumber = hasil.rules.map((rule) => rule.source)
  assert.ok(sumber.includes("bash(rm *)"), "aturan induk tidak boleh hilang")
  assert.ok(sumber.includes("bash(git *)"))
})

// ---------- CLI eksternal ----------

test("induk read-only tidak boleh menjalankan CLI eksternal atas namanya", () => {
  /*
   * Blok izin Titah tidak pernah sampai ke CLI eksternal — mesin itu punya
   * kebijakannya sendiri dan menyunting berkas tanpa bertanya ke sini. Jadi
   * membiarkannya jalan berarti `plan` bisa mengubah repo lewat pintu yang
   * tidak punya kunci sama sekali.
   */
  assert.equal(maySpawnExternal(of("plan")), false)
})

test("induk yang boleh menulis boleh mendelegasikan ke luar", () => {
  assert.equal(maySpawnExternal(of("build-auto")), true)
  assert.equal(maySpawnExternal(of("build")), true, "`ask` bukan `deny` — ia tetap boleh")
})

test("hanya edit DAN write yang deny yang menutupnya", () => {
  // Satu sumbu saja tidak cukup: agent yang `edit: deny` tapi `write: allow`
  // masih bisa membuat berkas, jadi ia bukan pembaca.
  const setengah = of("setengah", { agent: { setengah: { permission: { edit: "deny" } } } })
  assert.equal(maySpawnExternal(setengah), true)
})

// ---------- build-auto: janji "tanpa konfirmasi" berlaku penuh ----------

test("build-auto membuka SEMUA delapan sumbu, bukan enam", () => {
  /*
   * `external_directory` dan `doom_loop` dulu tidak disebut presetnya, jadi
   * keduanya jatuh ke global — "deny" dan "ask" — dan mode yang menjanjikan
   * "tanpa konfirmasi" tetap bisa berhenti di tengah jalan. Janji yang hanya
   * berlaku enam dari delapan kali adalah janji yang tidak bisa diandalkan.
   */
  const permission = of("build-auto")

  for (const axis of [
    "edit",
    "write",
    "bash",
    "network",
    "delete",
    "mcp",
    "external_directory",
    "doom_loop",
  ] as const) {
    assert.equal(permission[axis], "allow", `${axis} masih bisa menyela`)
  }
})

test("build MANUAL tidak ikut terbuka", () => {
  // Jaring pengaman: perubahan pada satu preset tidak boleh merembet ke
  // saudaranya, dan keduanya hanya dibedakan oleh blok izin ini.
  const permission = of("build")
  assert.equal(permission.edit, "ask")
  assert.equal(permission.external_directory, "deny", "batas cwd tetap keras di build manual")
})
