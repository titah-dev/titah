import assert from "node:assert/strict"
import test from "node:test"
import {
  parseModelId,
  resolveCredential,
  resolveModel,
  ProviderError,
  contextWindowFor,
  undeclaredContextWindows,
} from "../src/core/provider.ts"
import { Config, Provider } from "../src/core/schema.ts"

const compatible = (overrides: Record<string, unknown> = {}) =>
  Provider.parse({
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "http://x/v1" },
    models: { m: {} },
    ...overrides,
  })

test("parseModelId memisah pada slash pertama saja", () => {
  assert.deepEqual(parseModelId("ollama/qwen3.5:27b"), {
    providerId: "ollama",
    modelId: "qwen3.5:27b",
  })
  // Id model sering mengandung slash — ini yang membuat split naif salah.
  assert.deepEqual(parseModelId("9router/cx/gpt-5.4"), {
    providerId: "9router",
    modelId: "cx/gpt-5.4",
  })
})

test("parseModelId menolak bentuk yang bukan provider/model", () => {
  for (const bad of ["telanjang", "/awalan", "akhiran/", ""]) {
    assert.throws(() => parseModelId(bad), ProviderError, `seharusnya menolak: "${bad}"`)
  }
})

test("kredensial dari config menang atas env", () => {
  process.env.TITAH_P_API_KEY = "dari-env"
  try {
    const result = resolveCredential("p", compatible({ options: { baseURL: "http://x/v1", apiKey: "dari-config" } }))
    assert.equal(result.key, "dari-config")
    assert.equal(result.source, "config")
  } finally {
    delete process.env.TITAH_P_API_KEY
  }
})

test("tanpa config, kredensial jatuh ke env var konvensional", () => {
  process.env.TITAH_P_API_KEY = "dari-env"
  try {
    const result = resolveCredential("p", compatible())
    assert.equal(result.key, "dari-env")
    assert.equal(result.source, "env")
  } finally {
    delete process.env.TITAH_P_API_KEY
  }
})

test("tanpa kredensial sama sekali, source = none", () => {
  delete process.env.TITAH_P_API_KEY
  const result = resolveCredential("p", compatible())
  assert.equal(result.key, undefined)
  assert.equal(result.source, "none")
})

test("tanpa model default, resolveModel menolak alih-alih menebak", () => {
  const config = Config.parse({})
  assert.throws(() => resolveModel(config), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.match(error.message, /does not guess/)
    return true
  })
})

test("provider yang tidak dikenal menyebutkan yang tersedia", () => {
  const config = Config.parse({ model: "hilang/m", provider: { ada: compatible() } })
  assert.throws(() => resolveModel(config), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.match(error.message, /ada/)
    return true
  })
})

test("openai-compatible tanpa baseURL adalah error, bukan default diam-diam", () => {
  const config = Config.parse({
    model: "p/m",
    provider: { p: { npm: "@ai-sdk/openai-compatible", models: { m: {} } } },
  })
  assert.throws(() => resolveModel(config), /baseURL/)
})

test("openai-compatible tanpa apiKey tetap boleh — endpoint lokal tidak butuh kunci", () => {
  delete process.env.TITAH_OLLAMA_API_KEY
  const config = Config.parse({
    model: "ollama/m",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://localhost:11434/v1" },
        models: { m: {} },
      },
    },
  })
  assert.doesNotThrow(() => resolveModel(config))
})

test("anthropic tanpa apiKey menolak dengan instruksi yang bisa dijalankan", () => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.TITAH_ANT_API_KEY
  const config = Config.parse({
    model: "ant/claude-x",
    provider: { ant: { npm: "@ai-sdk/anthropic", models: { "claude-x": {} } } },
  })
  assert.throws(() => resolveModel(config), /titah auth set ant/)
})

test("contextWindowFor membaca angka yang dideklarasikan config", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: {
      ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } },
    },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), 32768)
})

test("contextWindowFor memakai config.model saat argumennya kosong", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } } },
  })
  assert.equal(contextWindowFor(config), 32768)
})

test("contextWindowFor memenangkan argumen `full` di atas config.model, bukan sebaliknya", () => {
  // Tugas berikutnya memanggil contextWindowFor(config, agentDef?.model ?? modelOverride)
  // di jalur panas — kalau precedence-nya terbalik, override model sub-agent
  // akan diam-diam memakai jendela konteks model DEFAULT, salah tanpa terlihat.
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: {
      ollama: {
        models: {
          "qwen3:14b": { contextWindow: 32768 },
          "llama3:8b": { contextWindow: 8192 },
        },
      },
    },
  })
  assert.equal(contextWindowFor(config, "ollama/llama3:8b"), 8192)
})

test("model tanpa contextWindow mengembalikan undefined, BUKAN angka tebakan", () => {
  // Angka yang salah lebih berbahaya daripada tidak ada angka: memadatkan
  // terlalu telat tidak bisa dibedakan dari tidak memadatkan sama sekali,
  // kecuali user sudah telanjur percaya masalahnya tertangani.
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": {} } } },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), undefined)
})

test("id model yang tidak berbentuk provider/model tidak melempar, cuma undefined", () => {
  // contextWindowFor dipanggil di jalur panas tiap langkah. Melempar di sini
  // akan mematikan giliran gara-gara metadata yang hilang.
  //
  // Ketiga bentuk cacat diuji, bukan cuma yang tanpa garis miring. Penjaganya
  // satu baris dengan tiga syarat (`slash <= 0 || slash === panjang - 1`), dan
  // melonggarkannya jadi `slash < 0` tetap lolos pada config biasa — dua
  // pertiga penjaganya lalu tidak terjaga apa pun.
  //
  // Karena itu config di sini SENGAJA punya kunci kosong. Kunci kosong adalah
  // salah ketik yang sungguh terjadi (`"": { ... }` di titah.json), dan
  // pertanyaannya persis: apakah id yang cacat gagal dengan aman, atau
  // diam-diam menemukan jendela konteks milik entri yang salah? Jendela yang
  // salah adalah kegagalan paling senyap di seluruh fitur ini — pemadatan yang
  // terlambat tidak bisa dibedakan dari tidak ada pemadatan.
  const config = Config.parse({
    provider: {
      mock: { models: { m: { contextWindow: 4096 }, "": { contextWindow: 222 } } },
      "": { models: { m: { contextWindow: 111 } } },
    },
  })

  // Positif dulu: bentuk yang BENAR memang menemukan angkanya, DAN entri
  // berkunci kosong itu sungguh ada untuk ditemukan — tanpa ini, `undefined`
  // di bawah bisa berarti "tidak ada apa-apa di sana", bukan "ditolak".
  assert.equal(contextWindowFor(config, "mock/m"), 4096)
  assert.equal(config.provider[""]?.models["m"]?.contextWindow, 111)
  assert.equal(config.provider["mock"]?.models[""]?.contextWindow, 222)

  assert.equal(contextWindowFor(config, "tanpa-slash"), undefined)
  assert.equal(contextWindowFor(config, "/m"), undefined, "provider kosong ditolak, bukan dicocokkan")
  assert.equal(contextWindowFor(config, "mock/"), undefined, "model kosong ditolak, bukan dicocokkan")
})

test("undeclaredContextWindows menyebut model yang dikonfigurasi tanpa batas", () => {
  const config = Config.parse({
    provider: {
      ollama: {
        models: { "qwen3:14b": { contextWindow: 32768 }, "llama3:8b": {} },
      },
    },
  })
  assert.deepEqual(undeclaredContextWindows(config), ["ollama/llama3:8b"])
})
