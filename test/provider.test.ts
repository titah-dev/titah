import assert from "node:assert/strict"
import test from "node:test"
import { parseModelId, resolveCredential, resolveModel, ProviderError } from "../src/core/provider.ts"
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
