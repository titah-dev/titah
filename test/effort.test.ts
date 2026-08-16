import assert from "node:assert/strict"
import test from "node:test"
import {
  buildSystemPrompt,
  conclusionSection,
  EFFORTS,
  nextEffort,
  type EffortChoice,
} from "../src/core/prompt.ts"
import { Config } from "../src/core/schema.ts"
import { buildKeymap, LEADER_ACTIONS, leaderKeyFor, resolve } from "../src/tui/keybinds.ts"

/**
 * Panjang kesimpulan: satu sumbu, empat tingkat, dua tempat yang bisa memilih.
 */

const config = (agent: Record<string, unknown> = {}) =>
  Config.parse({ skills: { discover: [], paths: [] }, agent })

const built = (agentID?: string, override?: EffortChoice, agent: Record<string, unknown> = {}) =>
  buildSystemPrompt(config(agent), process.cwd(), agentID, override).system

// ---------- bagian penutup ----------

test("setiap jawaban diminta ditutup kesimpulan", () => {
  assert.match(built(), /Closing the answer/)
  assert.match(built(), /End every answer with a short conclusion/)
})

test("kesimpulan bukan ringkasan langkah", () => {
  /*
   * Beda yang menentukan gunanya. Langkah-langkahnya sudah tergulir di layar;
   * mengulanginya membuat bagian ini panjang tanpa menambah apa pun, dan
   * bagian yang panjang tanpa isi adalah bagian yang berhenti dibaca.
   */
  assert.match(conclusionSection(), /Not a summary of/)
  assert.match(conclusionSection(), /the user watched those/)
})

test("jawaban satu baris tidak dipaksa punya kesimpulan", () => {
  // Tanpa jalan keluar ini, "halo" dibalas sapaan plus satu paragraf analisa.
  assert.match(conclusionSection(), /Skip it entirely when there is nothing to conclude/)
  assert.match(conclusionSection("low"), /Skip it entirely/)
})

test("tingkat ATAS tidak boleh melewatkan kesimpulan walau pekerjaannya kecil", () => {
  /*
   * Diukur pada giliran sungguhan sebelum pembagian ini ada: `high` menghasilkan
   * penutup sependek `low` untuk suntingan satu baris — 269 kata keluaran lawan
   * 328, jadi yang "lebih tinggi" justru lebih pendek. Klausa "lewati kalau
   * tidak ada yang disimpulkan" mengalahkan seluruh aturan panjangnya.
   *
   * Masuk akal bagi model, dan salah bagi user: ia baru saja MEMILIH analisa
   * panjang, dan Titah yang memutuskan pekerjaannya tidak layak disimpulkan
   * mengambil kembali pilihan yang baru diberikan.
   */
  for (const level of ["medium", "high"] as const) {
    assert.doesNotMatch(conclusionSection(level), /Skip it entirely/, level)
    assert.match(conclusionSection(level), /even when the change was small/, level)
  }
})

// ---------- tingkatnya ----------

test("makin tinggi, makin panjang yang diminta", () => {
  const rendah = conclusionSection("low")
  const sedang = conclusionSection("medium")
  const tinggi = conclusionSection("high")

  assert.match(rendah, /one or two sentences/)
  assert.match(sedang, /A short paragraph/)
  assert.match(tinggi, /what you deliberately left alone/)
  assert.ok(
    rendah.length < sedang.length && sedang.length < tinggi.length,
    "aturannya sendiri harus ikut menanjak, bukan cuma katanya",
  )
})

test("tingkat tertinggi menuntut menyebut yang belum pasti", () => {
  // Analisa yang hanya memuat keberhasilan bukan analisa — dan itu bentuk
  // kegagalan yang paling mudah lolos, karena ia terbaca meyakinkan.
  assert.match(conclusionSection("high"), /Say what you are unsure/)
})

test("TANPA tingkat, panjang tidak disebut sama sekali", () => {
  /*
   * `undefined` bukan tingkat kelima yang kebetulan longgar — ia satu-satunya
   * keadaan di mana MODEL yang menakar. Menyebut angka apa pun di sini akan
   * salah di salah satu ujungnya: dua kalimat untuk perbaikan satu baris, atau
   * setengah halaman untuk migrasi.
   */
  const bebas = conclusionSection()
  assert.doesNotMatch(bebas, /one or two sentences/)
  assert.doesNotMatch(bebas, /A short paragraph/)
  assert.match(bebas, /Let its length follow the work/)
})

// ---------- config vs tombol ----------

test("agent boleh menyetel tingkatnya di config", () => {
  const system = built("penulis", undefined, { penulis: { mode: "all", effort: "high" } })
  assert.match(system, /what you deliberately left alone/)
})

test("tanpa effort di config, agent tidak mewarisi tingkat apa pun", () => {
  const system = built("polos", undefined, { polos: { mode: "all" } })
  assert.match(system, /Let its length follow the work/)
})

test("yang DITEKAN mengalahkan yang ditulis di config", () => {
  /*
   * Kalau tidak, sakelarnya terasa rusak justru pada agent yang paling mungkin
   * disetel user — dan ia tidak akan pernah tahu kenapa.
   */
  const system = built("penulis", "low", { penulis: { mode: "all", effort: "high" } })
  assert.match(system, /one or two sentences/)
  assert.doesNotMatch(system, /what you deliberately left alone/)
})

test('"default" mengembalikan penakaran ke model, MESKI config menyetel', () => {
  /*
   * Inilah alasan `"default"` ikut dalam putaran alih-alih jadi sekadar
   * "belum dipilih". Tanpa nilai ini, sekali user menulis `effort` di config ia
   * tidak akan pernah bisa kembali ke perilaku tanpa batas dari keyboard.
   */
  const system = built("penulis", "default", { penulis: { mode: "all", effort: "high" } })
  assert.match(system, /Let its length follow the work/)
  assert.doesNotMatch(system, /what you deliberately left alone/)
})

// ---------- putarannya ----------

test("putarannya melewati keempatnya lalu kembali", () => {
  assert.deepEqual(EFFORTS, ["default", "low", "medium", "high"])

  const dilalui: EffortChoice[] = []
  let current: EffortChoice = "default"
  for (let i = 0; i < 4; i += 1) {
    current = nextEffort(current)
    dilalui.push(current)
  }
  assert.deepEqual(dilalui, ["low", "medium", "high", "default"])
})

test("urutannya dari yang paling ringkas, bukan alfabetis", () => {
  // `high, low, medium` akan membuat satu tekanan melompat dari terpanjang ke
  // terpendek, dan putaran yang tidak bisa ditebak arahnya harus dibaca tiap
  // kali alih-alih ditekan.
  assert.deepEqual(EFFORTS.slice(1), ["low", "medium", "high"])
})

// ---------- tombolnya ----------

test("ctrl+r memutar tingkatnya", () => {
  const keymap = buildKeymap()
  assert.equal(
    resolve(keymap, { key: "r", ctrl: true }, false, ["effort_cycle"]),
    "effort_cycle",
  )
})

test("ctrl+r tidak merebut tombol yang sudah dipakai editor", () => {
  /*
   * a/b/e/f/j/u sudah memindahkan kursor. Tombol yang merebut salah satunya
   * akan terasa seperti editor yang rusak, bukan seperti fitur baru.
   */
  const keymap = buildKeymap()
  for (const key of ["a", "b", "e", "f", "j", "u", "c", "d", "p"]) {
    assert.notEqual(
      resolve(keymap, { key, ctrl: true }, false, ["effort_cycle"]),
      "effort_cycle",
      `ctrl+${key} seharusnya bukan milik effort_cycle`,
    )
  }
})

test("juga bisa ditemukan lewat menu leader", () => {
  // Tombol yang tidak bisa ditemukan sama saja dengan tidak ada — dan `ctrl+r`
  // tidak akan pernah ditebak orang yang belum membaca changelog.
  const keymap = buildKeymap()
  assert.equal(leaderKeyFor(keymap, "effort_cycle"), "r")
  assert.ok(LEADER_ACTIONS.some((entry) => entry.action === "effort_cycle"))
})

test("tab tetap milik agent, tidak dibagi dua putaran", () => {
  // Dua putaran di tombol yang sama menuntut user mengingat mana yang sedang
  // ia putar sebelum menekan.
  const keymap = buildKeymap()
  assert.equal(resolve(keymap, { key: "tab" }, false, ["effort_cycle"]), undefined)
  assert.equal(resolve(keymap, { key: "tab" }, false, ["agent_cycle"]), "agent_cycle")
})
