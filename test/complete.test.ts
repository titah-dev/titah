import assert from "node:assert/strict"
import test from "node:test"
import {
  applySuggestion,
  detectTrigger,
  modelSuggestions,
  suggest,
} from "../src/tui/complete.ts"
import { spinnerFrame } from "../dist/tui/components.js"
import { Config } from "../src/core/schema.ts"

const config = Config.parse({
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
  assert.ok(items.every((item) => item.kind === "command"))
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
  const frames = new Set<string>()
  for (let i = 0; i < 40; i += 1) frames.add(spinnerFrame(i))

  assert.equal(frames.size, 10, "sepuluh bingkai unik")
  assert.equal(spinnerFrame(0), spinnerFrame(10), "berulang setelah satu putaran")
  assert.ok([...frames].every((frame) => frame.length === 1))
})
