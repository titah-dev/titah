import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  agentPickerItems,
  applySuggestion,
  detectTrigger,
  modelSuggestions,
  skillSuggestions,
  suggest,
} from "../src/tui/complete.ts"
import { shimmer, spinnerFrame, workingLine, workingWord } from "../dist/tui/components.js"
import { Config } from "../src/core/schema.ts"

/** Jumlah kata di `WORKING_WORDS`, dipakai menguji indeks negatif. */
const WORD_COUNT = 12

const config = Config.parse({
  // `discover: []` wajib: suggest("/") sekarang ikut mendaftar skill, dan
  // default ["claude", "opencode"] akan membaca ~/.claude sungguhan milik siapa
  // pun yang menjalankan test ini.
  skills: { discover: [] },
  agent: {
    plan: { description: "Plan only" },
    build: { description: "Build Manual" },
  },
  externalAgent: {
    claude: { command: process.execPath },
    hantu: { command: "titah-agent-yang-tidak-ada" },
  },
  command: { review: { template: "Review {{.Input}}", description: "Quick review" } },
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://x/v1" },
      models: { "qwen3:8b": { name: "Qwen3 8B" }, "llama:70b": {} },
    },
  },
})

const files = ["src/a.ts", "src/nested/b.ts", "README.md"]

// ---------- deteksi pemicu ----------

test("@ di awal kata memicu, @ di dalam kata tidak", () => {
  assert.deepEqual(detectTrigger("@cla", 4), { char: "@", start: 0, query: "cla" })
  assert.deepEqual(detectTrigger("hi @cla", 7), { char: "@", start: 3, query: "cla" })
  assert.equal(detectTrigger("akil@gmail.com", 14), undefined, "email bukan mention")
})

test("/ hanya memicu di posisi paling awal prompt", () => {
  assert.deepEqual(detectTrigger("/rev", 4), { char: "/", start: 0, query: "rev" })
  assert.equal(detectTrigger("lihat /etc/hosts", 16), undefined)
  assert.equal(detectTrigger("a /rev", 6), undefined, "slash di tengah bukan command")
})

test("spasi setelah pemicu menutup popup", () => {
  assert.equal(detectTrigger("@claude ", 8), undefined)
  assert.equal(detectTrigger("/review src", 11), undefined)
})

test("teks tanpa pemicu sama sekali", () => {
  assert.equal(detectTrigger("halo dunia", 10), undefined)
  assert.equal(detectTrigger("", 0), undefined)
})

test("kursor di tengah teks memakai token di kirinya, bukan seluruh baris", () => {
  const draft = "@cla dan lainnya"
  assert.deepEqual(detectTrigger(draft, 4), { char: "@", start: 0, query: "cla" })
})

// ---------- saran ----------

test("@ menggabungkan agent eksternal, agent internal, dan file", () => {
  const items = suggest({ config, cwd: "/x", trigger: { char: "@", start: 0, query: "" }, files })
  const kinds = new Set(items.map((item) => item.kind))

  assert.ok(kinds.has("external-agent"))
  assert.ok(kinds.has("agent"))
  assert.ok(kinds.has("file"))
  assert.equal(items[0]?.kind, "external-agent", "agent eksternal muncul lebih dulu")
})

test("agent eksternal yang tidak terpasang ditandai nonaktif, bukan disembunyikan", () => {
  const items = suggest({ config, cwd: "/x", trigger: { char: "@", start: 0, query: "hantu" }, files })
  assert.equal(items.length, 1)
  assert.equal(items[0]?.disabled, true)
  assert.match(items[0]?.detail ?? "", /unavailable/)
})

test("query menyaring ketiga jenis sekaligus", () => {
  const items = suggest({ config, cwd: "/x", trigger: { char: "@", start: 0, query: "b" }, files })
  const labels = items.map((item) => item.label)

  assert.ok(labels.includes("@build"), "agent yang cocok")
  assert.ok(labels.includes("@src/nested/b.ts"), "file yang cocok")
  assert.ok(!labels.includes("@plan"))
})

test("/ menyarankan command bawaan dan custom", () => {
  const items = suggest({ config, cwd: "/x", trigger: { char: "/", start: 0, query: "" } })
  const labels = items.map((item) => item.label)

  assert.ok(labels.includes("/model"))
  assert.ok(labels.includes("/consensus"))
  assert.ok(labels.includes("/review"), "command dari config ikut")
  assert.ok(items.every((item) => item.kind === "command"), "config ini memang tanpa skill")
})

test("pilihan command menyisakan spasi supaya argumen bisa langsung diketik", () => {
  const items = suggest({ config, cwd: "/x", trigger: { char: "/", start: 0, query: "rev" } })
  assert.equal(items[0]?.value, "/review ")
})

test("model dikumpulkan dari semua provider dengan nama tampilannya", () => {
  const items = modelSuggestions(config)
  assert.deepEqual(items.map((item) => item.value).sort(), ["local/llama:70b", "local/qwen3:8b"])
  assert.equal(items.find((item) => item.value === "local/qwen3:8b")?.detail, "Qwen3 8B")
})

test("model bisa disaring lewat query", () => {
  assert.deepEqual(
    modelSuggestions(config, "llama").map((item) => item.value),
    ["local/llama:70b"],
  )
})

// ---------- skill ----------

function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-complete-skill-"))
  for (const [relative, content] of Object.entries(spec)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

test("memilih skill menyisipkan commandnya, bukan kalimat tentang skill itu", () => {
  // Sebelumnya menyisipkan: Use the "X" skill. — kalimat yang harus dipahami
  // model, bukan perintah yang pasti dijalankan.
  const skillDir = tree({ "a/SKILL.md": "---\nname: a\n---\nisi" })
  const skillConfig = Config.parse({
    skills: { discover: [], paths: [{ path: skillDir, as: "ns" }] },
  })
  const [item] = skillSuggestions(skillConfig, "/x", "")

  assert.equal(item?.label, "/ns:a")
  assert.equal(item?.value, "/ns:a ")
})

test("/ mendaftar skill di samping command, dan namespace mempersempitnya", () => {
  // Persyaratan spec §TUI yang hilang antara spec dan plan: tanpa ini,
  // `/superpowers:brainstorming` menghasilkan daftar KOSONG, popup nol item
  // menelan Enter, dan prompt terlihat mati untuk skill yang sebenarnya ada.
  const skillDir = tree({ "brainstorming/SKILL.md": "---\nname: brainstorming\n---\nisi" })
  const withSkills = Config.parse({
    skills: { discover: [], paths: [{ path: skillDir, as: "superpowers" }] },
    command: { review: { template: "Review {{.Input}}" } },
  })

  const semua = suggest({ config: withSkills, cwd: "/x", trigger: { char: "/", start: 0, query: "" } })
  assert.ok(semua.some((item) => item.kind === "command"), "command tetap ada")
  assert.ok(semua.some((item) => item.label === "/superpowers:brainstorming"), "skill ikut terdaftar")

  const disaring = suggest({
    config: withSkills,
    cwd: "/x",
    trigger: { char: "/", start: 0, query: "superpowers:" },
  })
  assert.deepEqual(
    disaring.map((item) => item.label),
    ["/superpowers:brainstorming"],
    "mengetik namespace menyisakan skill plugin itu saja",
  )

  // Kasus yang persis jadi jalan buntu: id LENGKAP tanpa argumen. Harus tetap
  // menghasilkan tepat satu pilihan, karena daftar kosonglah yang membuat Enter
  // tertelan dan popup nol item terbuka.
  const penuh = suggest({
    config: withSkills,
    cwd: "/x",
    trigger: { char: "/", start: 0, query: "superpowers:brainstorming" },
  })
  assert.equal(penuh.length, 1)
  assert.equal(penuh[0]?.value, "/superpowers:brainstorming ")
})

test("mengetik namespace mempersempit ke plugin itu saja", () => {
  const skillDir = tree({ "a/SKILL.md": "---\nname: a\n---\nisi" })
  const lainDir = tree({ "b/SKILL.md": "---\nname: b\n---\nisi" })
  const skillConfig = Config.parse({
    skills: {
      discover: [],
      paths: [
        { path: skillDir, as: "ns" },
        { path: lainDir, as: "lain" },
      ],
    },
  })
  const hasil = skillSuggestions(skillConfig, "/x", "ns:")
  assert.ok(hasil.every((item) => item.label.startsWith("/ns:")))
  assert.ok(hasil.length > 0)
})

// ---------- penerapan pilihan ----------

test("memilih saran mengganti token pemicu, bukan seluruh prompt", () => {
  const draft = "tolong lihat @cla"
  const trigger = detectTrigger(draft, draft.length)
  assert.ok(trigger)

  const next = applySuggestion(draft, trigger, draft.length, {
    kind: "external-agent",
    value: "@claude ",
    label: "@claude",
  })

  assert.equal(next.draft, "tolong lihat @claude ")
  assert.equal(next.cursor, next.draft.length)
})

test("teks setelah kursor dipertahankan", () => {
  const draft = "@cla lalu jelaskan"
  const trigger = detectTrigger(draft, 4)
  assert.ok(trigger)

  const next = applySuggestion(draft, trigger, 4, {
    kind: "file",
    value: "@src/a.ts ",
    label: "@src/a.ts",
  })

  assert.equal(next.draft, "@src/a.ts  lalu jelaskan")
  assert.equal(next.cursor, "@src/a.ts ".length)
})

// ---------- spinner ----------

test("spinner berputar dan tidak pernah keluar dari bingkainya", () => {
  /*
   * Bintang yang BERKELIP, bukan bentuk yang berputar.
   *
   * Bulatan langkah di riwayat sudah berputar. Dua gerakan yang berbeda
   * jenisnya bisa dibedakan sekilas; dua yang sama-sama berputar hanya berbeda
   * kalau diperhatikan — dan yang perlu diperhatikan bukan lagi pembeda.
   */
  const frames = new Set<string>()
  for (let i = 0; i < 40; i += 1) frames.add(spinnerFrame(i))

  assert.equal(frames.size, 5, "enam bingkai, satu di antaranya dipakai dua kali")
  assert.equal(spinnerFrame(6), spinnerFrame(0), "berulang setelah satu siklus")
  assert.equal(spinnerFrame(2), spinnerFrame(4), "naik lalu turun, tidak melompat di ujung")
  assert.ok([...frames].every((frame) => [...frame].length === 1), "satu kolom, tidak menggeser teks")
})

test("pemilih agent tidak lagi menawarkan \"(no agent)\"", () => {
  /*
   * Label itu menjanjikan mode yang tidak pernah ada: giliran tanpa agent tetap
   * dijalankan `config.defaultAgent`. `(default)` hanya tersisa untuk jaring
   * pengaman "tidak ada agent sama sekali", yang tidak pernah ditempuh karena
   * DEFAULT_AGENTS selalu menyuntik plan/build/build-auto.
   */
  const config = Config.parse({ agent: { build: { description: "Build Manual" } } })
  const items = agentPickerItems(config, ["build", "plan"])

  assert.equal(
    items.some((item) => item.label.includes("no agent")),
    false,
  )
  assert.deepEqual(
    items.map((item) => item.label),
    ["build", "plan"],
  )
  assert.equal(items[0]?.detail, "Build Manual", "deskripsi agent ikut terbawa")
})

test("jaring pengaman: entri kosong diberi label yang jujur", () => {
  const items = agentPickerItems(Config.parse({}), [undefined])
  assert.equal(items[0]?.label, "(default)")
  assert.equal(items[0]?.value, "")
})

// ---------- kata yang bercahaya ----------

test("kata kerja berganti, dan selalu ada", () => {
  const kata = new Set<string>()
  for (let i = 0; i < 24; i += 1) kata.add(workingWord(i))

  assert.ok(kata.size > 6, "satu-dua kata saja berhenti terasa berganti")
  assert.ok([...kata].every((word) => /^[A-Z][a-z]+$/.test(word)), "Inggris, satu kata, kapital")
  assert.equal(workingWord(-1), workingWord(WORD_COUNT - 1), "indeks negatif tidak menghasilkan undefined")
})

test("cahaya menyapu satu huruf, dengan tetangga setengah terang", () => {
  const glow = shimmer("Pondering", 0)
  assert.equal(glow.map((part) => part.text).join(""), "Pondering", "tidak boleh mengubah katanya")
  assert.equal(glow[0]?.level, 2, "puncaknya di huruf pertama saat detak 0")
  assert.equal(glow[1]?.level, 1, "tetangganya setengah")
  assert.equal(glow[4]?.level, 0, "yang jauh redup")
})

test("cahaya BERBALIK di ujung, tidak melompat ke awal", () => {
  /*
   * Segitiga, bukan gergaji. Lompatan dari huruf terakhir kembali ke huruf
   * pertama terbaca sebagai kedipan di ujung kata — persis cacat yang membuat
   * animasi terasa murah.
   */
  const kata = "abcd"
  const puncak = (tick: number) => shimmer(kata, tick).findIndex((part) => part.level === 2)

  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(puncak), [0, 1, 2, 3, 2, 1, 0])
})

test("kata satu huruf tidak membagi nol", () => {
  // `span` jadi 0, dan sisa bagi terhadap nol menghasilkan NaN — indeks NaN
  // membuat seluruh kata redup tanpa satu pun error.
  assert.deepEqual(shimmer("x", 3), [{ text: "x", level: 1 }])
  assert.deepEqual(shimmer("", 3), [])
})

// ---------- kilatan warna sekali per LANGKAH ----------

test("warnanya menyala saat langkah berganti, lalu PADAM sendiri", () => {
  /*
   * Satu kilatan per langkah, bukan warna yang menyala terus. Yang menyala
   * terus berhenti diperhatikan dalam sepuluh detik — sama persis seperti kata
   * yang tidak pernah berganti, yaitu masalah yang mau diobati.
   */
  assert.equal(workingLine(0, 0).fresh, true, "detak pertama sebuah langkah")

  const kata = workingLine(0, 0).word
  const pulang = ([...kata].length - 1) * 2

  assert.equal(workingLine(0, pulang - 1).fresh, true, "masih menyala sebelum cahaya pulang")
  assert.equal(workingLine(0, pulang).fresh, false, "padam TEPAT saat cahaya kembali ke huruf pertama")
  assert.equal(workingLine(0, pulang + 99).fresh, false, "dan tetap padam selama langkahnya sama")
})

test("padamnya bertepatan dengan cahaya kembali ke huruf pertama", () => {
  // Keduanya lahir dari argumen yang sama, jadi ini bukan kebetulan yang harus
  // dijaga melainkan bentuk fungsinya. Test ini yang menahannya tetap begitu.
  const line = workingLine(0, 0)
  const pulang = ([...line.word].length - 1) * 2

  assert.equal(workingLine(0, pulang).glow[0]?.level, 2, "cahaya memang di huruf pertama")
  assert.equal(workingLine(0, pulang).fresh, false)
})

test("tool baru = kata baru, dan kilatannya mengulang", () => {
  // Inilah pemicunya: `ls` lalu `cat` adalah dua langkah, jadi dua kata.
  const ls = workingLine(3, 40)
  const cat = workingLine(4, 0)

  assert.notEqual(ls.word, cat.word)
  assert.equal(ls.fresh, false, "langkah lama sudah lama padam")
  assert.equal(cat.fresh, true, "langkah baru berkilat")
})

test("langkah yang MACET tidak pernah berganti kata", () => {
  /*
   * Yang membuat perubahan ini benar. Kata yang berganti sendiri sementara
   * pekerjaannya diam memberi kesan ada kemajuan — kesan yang paling tidak
   * boleh dipalsukan oleh indikator kerja.
   */
  const awal = workingLine(2, 0).word
  for (const detak of [50, 500, 5000]) {
    assert.equal(workingLine(2, detak).word, awal, `masih kata yang sama pada detak ${detak}`)
  }
})

test("cahaya dihitung dari SEJAK langkahnya mulai, bukan dari detak absolut", () => {
  /*
   * Kalau dari detak absolut, posisi cahaya saat kata berganti adalah
   * kebetulan — dan "kembali ke posisi awal" berhenti punya arti.
   */
  for (const step of [0, 1, 7]) {
    assert.equal(workingLine(step, 0).glow[0]?.level, 2, `langkah ${step} mulai dari huruf pertama`)
  }
})

test("setiap kata sempat padam dalam jendela yang wajar", () => {
  // Kalau satu kata butuh lebih lama daripada langkah yang khas, kilatan
  // "sekali" berubah jadi warna yang praktis selalu menyala.
  for (let step = 0; step < 12; step += 1) {
    const { word } = workingLine(step, 0)
    const pulang = ([...word].length - 1) * 2
    assert.ok(pulang <= 20, `"${word}" butuh ${pulang} detak — terlalu lama untuk satu kilatan`)
  }
})

test("note mengalahkan kata pilihan, dan tidak pernah berkilat", () => {
  // Ia kabar sungguhan, bukan pergantian yang perlu diumumkan.
  const line = workingLine(0, 0, "compacting")
  assert.equal(line.word, "compacting")
  assert.equal(line.fresh, false)
})

test("detak negatif tidak merusak barisnya", () => {
  const line = workingLine(0, -5)
  assert.ok(line.word.length > 0)
  assert.equal(line.glow.map((part) => part.text).join(""), line.word)
})
