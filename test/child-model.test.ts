import assert from "node:assert/strict"
import test from "node:test"
import { childModel } from "../src/core/subagent.ts"
import { Config } from "../src/core/schema.ts"

/**
 * Model yang dipakai sub-agent.
 *
 * Sebelumnya ia selalu `agent.<id>.model ?? config.model` — model INDUK tidak
 * pernah ikut turun. Akibatnya `-m` pada induk hanya memindahkan induknya, dan
 * delegasi diam-diam berjalan di model lain: pada mesin ini selisihnya 18 detik
 * versus 51 detik per panggilan.
 */

const config = (extra: Record<string, unknown> = {}) =>
  Config.parse({
    model: "prov/global",
    provider: {
      prov: {
        options: { baseURL: "http://x/v1" },
        models: { global: {}, khusus: {}, induk: {} },
      },
    },
    ...extra,
  })

const withAgent = (agent: Record<string, unknown>) =>
  config({ agent: { anak: { mode: "all", ...agent } } })

test("model milik agent MENANG atas model induk", () => {
  /*
   * Inti "hybrid"-nya. Agent yang memang butuh model tertentu tidak boleh
   * kehilangan itu hanya karena dipanggil dari giliran yang memakai model lain.
   */
  const hasil = childModel(withAgent({ model: "prov/khusus" }), "anak", "prov/induk")
  assert.equal(hasil.model, "prov/khusus")
  assert.equal(hasil.fellBack, undefined)
})

test("tanpa model sendiri, anak MEWARISI model induk", () => {
  // Dulu ia jatuh ke `config.model`, jadi `-m` pada induk berhenti di induk.
  assert.equal(childModel(withAgent({}), "anak", "prov/induk").model, "prov/induk")
})

test("tanpa model sendiri DAN tanpa induk, biarkan config.model yang memilih", () => {
  // `undefined` diteruskan apa adanya; `resolveModel` yang memakai
  // `config.model`, persis seperti sebelum perubahan ini.
  assert.equal(childModel(withAgent({}), "anak", undefined).model, undefined)
})

test("model agent yang TIDAK BISA diresolusi jatuh ke model induk", () => {
  /*
   * Ini yang diminta: agent dengan model salah tulis atau provider yang belum
   * dikonfigurasi tidak gagal seluruhnya, selama induknya punya model yang
   * jelas bekerja.
   */
  const hasil = childModel(withAgent({ model: "tidakada/apa" }), "anak", "prov/induk")
  assert.equal(hasil.model, "prov/induk")
  assert.match(hasil.fellBack ?? "", /tidakada\/apa/, "menyebut yang gagal")
  assert.match(hasil.fellBack ?? "", /prov\/induk/, "dan yang dipakai sebagai gantinya")
})

test("tanpa induk, model yang rusak DIBIARKAN gagal dengan pesan aslinya", () => {
  /*
   * Pesan asli menyebut provider mana yang tidak dikenal dan apa saja yang
   * tersedia. Menggantinya dengan "modelnya tidak bisa dipakai" membuang
   * satu-satunya keterangan yang bisa ditindaklanjuti.
   */
  const hasil = childModel(withAgent({ model: "tidakada/apa" }), "anak", undefined)
  assert.equal(hasil.model, "tidakada/apa")
  assert.equal(hasil.fellBack, undefined)
})

test("jatuh-balik hanya untuk kegagalan RESOLUSI, bukan kegagalan saat berjalan", () => {
  /*
   * Batas yang disengaja. Resolusi terjadi sebelum satu permintaan pun dikirim,
   * jadi jatuh-balik di sana tidak mengulang apa pun. Kegagalan saat berjalan —
   * endpoint mati di tengah, 500, timeout — bisa terjadi SESUDAH sub-agent
   * menulis berkas, dan mengulanginya di model lain berarti mengerjakan efek
   * yang sama dua kali.
   *
   * Model yang bisa diresolusi selalu dipakai apa adanya, apa pun yang terjadi
   * padanya kemudian.
   */
  const hasil = childModel(withAgent({ model: "prov/khusus" }), "anak", "prov/induk")
  assert.equal(hasil.model, "prov/khusus", "yang sehat tidak pernah ditukar di muka")
})

test("agent yang tidak ada di config memakai model induk", () => {
  // Super agent dipanggil lewat id `externalAgent`, jadi ia tidak punya entri
  // di `config.agent` — dan tidak boleh menjatuhkan pemilihan model.
  assert.equal(childModel(config(), "super-yang-tak-terdaftar", "prov/induk").model, "prov/induk")
})
