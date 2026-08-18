import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_AGENTS, Config } from "../src/core/schema.ts"
import { buildSystemPrompt } from "../src/core/prompt.ts"

/**
 * Kategori KETIGA: keputusan yang membentuk seluruh pekerjaan sesudahnya.
 *
 * Sebelum ini `build-auto` hanya mengenal mekanik (jangan tanya) dan
 * kontradiksi (tanya). Diukur: proyek React kosong, diminta "buatkan halaman
 * admin dashboard" — model membaca, lalu langsung menulis dashboard lengkap
 * dengan sidebar dan menimpa `App.jsx`. Layoutnya diputuskan sendiri, tanpa
 * satu pun pertanyaan.
 *
 * Bukan salah modelnya: layout tidak bertentangan dengan apa pun, jadi
 * satu-satunya syarat berhenti yang ia punya tidak pernah terpenuhi.
 */

const promptOf = (id: string) => DEFAULT_AGENTS[id]?.prompt ?? ""

test("build DAN build-auto sama-sama memuatnya", () => {
  /*
   * `build` mengonfirmasi tiap perubahan, jadi sekilas ia sudah aman. Tidak:
   * waktu dialog izin memunculkan berkas dua ratus baris, layoutnya SUDAH
   * terlanjur dipilih. User mengonfirmasi hasil, bukan keputusan.
   */
  for (const id of ["build", "build-auto"]) {
    assert.match(promptOf(id), /Decisions that shape everything after/, id)
  }
})

test("satu definisi, dua pemakai — bukan dua salinan yang bisa menyimpang", () => {
  const potong = (text: string) =>
    text.slice(text.indexOf("--- Decisions that shape everything after ---"))
  assert.equal(potong(promptOf("build")), potong(promptOf("build-auto")))
})

test("dua ujinya disebut, dan yang kedua tentang ONGKOS YANG TUMBUH", () => {
  /*
   * Uji kedua yang memisahkan "penting" dari sekadar "belum diputuskan".
   * Layout bisa diulang dalam sejam di hari pertama; datastore tidak bisa
   * diulang dalam sebulan di hari kesembilan puluh.
   */
  const text = promptOf("build-auto")
  assert.match(text, /thrown away rather than edited/)
  assert.match(text, /more expensive the longer the work runs/)
})

test("contohnya BERAT DULU — datastore di depan, layout di belakang", () => {
  /*
   * Model membaca contoh sebagai definisi kategorinya. Draf pertama membuka
   * dengan layout, dan pemilihan datastore — anggota terberat — justru terasa
   * di luar cakupan karena tidak disebut.
   */
  const text = promptOf("build-auto")
  const datastore = text.indexOf("which datastore")
  const layout = text.indexOf("page layout")

  assert.ok(datastore > 0 && layout > 0, "keduanya harus disebut")
  assert.ok(datastore < layout, "datastore harus mendahului layout")
  assert.match(text, /how authentication works/)
  assert.match(text, /REST or GraphQL/)
})

test("daftar NEGATIFnya eksplisit — kalau tidak, kategorinya melar", () => {
  // Tanpa ini, "keputusan penting" akan melebar sampai ke pilihan nama
  // variabel, dan user akan mematikan seluruh fiturnya.
  const text = promptOf("build-auto")
  assert.match(text, /Not qualifying: naming, formatting/)
  assert.match(text, /a later edit undoes cheaply is yours to decide/)
})

test("pilihannya wajib membawa REKOMENDASI beserta alasannya", () => {
  /*
   * Menu netral memindahkan seluruh beban riset ke user — ia harus menimbang
   * trade-off yang modelnya sudah punya bahannya.
   */
  const text = promptOf("build-auto")
  assert.match(text, /each with a recommendation/)
  assert.match(text, /reason you drew from the code you just read/)
  assert.match(text, /not a neutral menu/)
})

test("alasan yang tidak bersandar pada kode = pertanyaan yang belum layak", () => {
  // Penjaga yang membuat fitur ini tidak berubah jadi kebiasaan bertanya.
  assert.match(promptOf("build-auto"), /the question is not ready to ask/)
})

test("bertanya SEKALI, di awal — bukan di tengah pekerjaan", () => {
  assert.match(promptOf("build-auto"), /Ask once, before you start building/)
})

test("tidak ada yang menjawab → ambil yang konvensional, dan sebutkan", () => {
  // Headless dan CI tidak punya siapa pun untuk menjawab. Menggantung di sana
  // lebih buruk daripada memilih, asal pilihannya diumumkan.
  assert.match(promptOf("build-auto"), /take the most conventional option and say which one/)
})

// ---------- batasnya ----------

test("BASE_PROMPT tetap BERSIH — sub-agent tidak ikut bertanya", () => {
  /*
   * `BASE_PROMPT` dibaca semua agent, termasuk sub-agent — dan sub-agent bisa
   * bertanya, karena pertanyaannya disiarkan ke stream induk. Sub-agent yang
   * bertanya soal datastore adalah sub-agent yang mempertanyakan brief
   * koordinatornya.
   */
  const parsed = Config.parse({ skills: { discover: [], paths: [] } })
  const anak = buildSystemPrompt(parsed, process.cwd()).system
  assert.doesNotMatch(anak, /Decisions that shape everything after/)
})

test("plan tidak ikut — ia memang sudah tugasnya mengajukan pilihan", () => {
  assert.doesNotMatch(promptOf("plan"), /Decisions that shape everything after/)
})

test("agent primary yang memakainya BENAR-BENAR mengirimnya", () => {
  /*
   * Konstanta yang ada di preset tapi tidak sampai ke system prompt adalah
   * kelas bug yang sudah berulang di repo ini: yang diukur bukan yang dikirim.
   *
   * `DEFAULT_AGENTS` disuntik manual karena `Config.parse` mengembalikan
   * `agent: {}` — preset baru digabung `loadConfig`, dan test yang lupa itu
   * akan hijau tanpa pernah memeriksa apa pun.
   */
  const parsed = Config.parse({ skills: { discover: [], paths: [] }, agent: DEFAULT_AGENTS })
  for (const id of ["build", "build-auto"]) {
    assert.match(
      buildSystemPrompt(parsed, process.cwd(), id).system,
      /Decisions that shape everything after/,
      id,
    )
  }
})
