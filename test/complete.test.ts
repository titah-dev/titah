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
import { spinnerFrame } from "../dist/tui/components.js"
import { Config } from "../src/core/schema.ts"

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
   * Sepuluh bingkai braille, dan detaknya 100ms — jadi tepat SATU putaran
   * penuh per detik.
   *
   * Jumlah bingkai dan laju detak adalah satu keputusan, bukan dua: sepuluh
   * bingkai pada 100ms itulah yang menghasilkan satu putaran per detik. Kalau
   * salah satunya berubah tanpa yang lain, putarannya berhenti sinkron dengan
   * penghitung detik di sebelahnya.
   */
  const frames = new Set<string>()
  for (let i = 0; i < 40; i += 1) frames.add(spinnerFrame(i))

  assert.equal(frames.size, 10, "sepuluh bingkai unik")
  assert.equal(spinnerFrame(0), spinnerFrame(10), "berulang setelah satu putaran")
  assert.ok([...frames].every((frame) => frame.length === 1), "satu kolom, jadi tidak menggeser teks")
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
