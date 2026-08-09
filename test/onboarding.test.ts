import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-onb-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")

const { buildConfig, detectFromEnv, isConfigured, writeOnboarding } = await import(
  "../src/core/onboarding.ts"
)
const { globalConfigFile, authFile } = await import("../src/core/paths.ts")
const { readAuth } = await import("../src/core/auth.ts")
const { Config } = await import("../src/core/schema.ts")

const choice = {
  id: "lokal",
  label: "Lokal",
  npm: "@ai-sdk/openai-compatible" as const,
  baseURL: "http://localhost:11434/v1",
  model: "qwen3",
  models: ["qwen3", "qwen2.5-coder"],
}

beforeEach(() => {
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true })
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test("kunci dari environment terdeteksi tanpa bertanya", () => {
  const found = detectFromEnv({ ANTHROPIC_API_KEY: "sk-abc", PATH: "/usr/bin" })
  assert.deepEqual(found.map((p) => p.id), ["anthropic"])
  assert.equal(found[0]?.envVar, "ANTHROPIC_API_KEY")
})

test("env var kosong tidak dianggap terdeteksi", () => {
  assert.deepEqual(detectFromEnv({ ANTHROPIC_API_KEY: "   " }), [])
  assert.deepEqual(detectFromEnv({}), [])
})

test("beberapa kunci sekaligus semuanya ditawarkan", () => {
  const found = detectFromEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" })
  assert.deepEqual(found.map((p) => p.id).sort(), ["anthropic", "openai"])
})

test("config hasil onboarding valid menurut skema", () => {
  const parsed = Config.safeParse(buildConfig(choice))
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  assert.equal(parsed.data?.model, "lokal/qwen3")
  assert.equal(parsed.data?.provider["lokal"]?.options?.baseURL, "http://localhost:11434/v1")
})

test("kunci dari environment DIREFERENSIKAN, tidak disalin ke config", () => {
  const config = buildConfig({
    ...choice,
    envVar: "ANTHROPIC_API_KEY",
  })
  assert.equal(config.provider?.["lokal"]?.options?.apiKey, "${env:ANTHROPIC_API_KEY}")
})

test("kunci yang diketik user TIDAK pernah masuk config", () => {
  const config = buildConfig({ ...choice, apiKey: "sk-sangat-rahasia" })
  assert.doesNotMatch(JSON.stringify(config), /sangat-rahasia/)
})

test("writeOnboarding menulis config dan menyimpan kunci ke auth.json 0600", () => {
  const result = writeOnboarding({ ...choice, apiKey: "sk-rahasia" })

  assert.equal(result.configFile, globalConfigFile())
  assert.equal(result.wroteCredential, true)

  const written = fs.readFileSync(result.configFile, "utf8")
  assert.doesNotMatch(written, /sk-rahasia/, "kunci tidak boleh ada di config")
  assert.equal(readAuth()["lokal"]?.key, "sk-rahasia")

  if (process.platform !== "win32") {
    assert.equal((fs.statSync(authFile()).mode & 0o777).toString(8), "600")
  }
})

test("tanpa kunci, auth.json tidak dibuat sama sekali", () => {
  const result = writeOnboarding(choice)
  assert.equal(result.wroteCredential, false)
  assert.equal(fs.existsSync(authFile()), false)
})

test("onboarding menolak menimpa config yang sudah ada", () => {
  writeOnboarding(choice)
  assert.throws(() => writeOnboarding(choice), /already exists/)
})

test("model yang dipilih selalu masuk daftar models meski tidak ada di probe", () => {
  const config = buildConfig({ ...choice, model: "model-baru", models: ["lama"] })
  assert.ok(config.provider?.["lokal"]?.models?.["model-baru"])
  assert.ok(config.provider["lokal"].models["lama"])
})

test("isConfigured membedakan config kosong dari yang siap pakai", () => {
  assert.equal(isConfigured(Config.parse({})), false)
  assert.equal(isConfigured(Config.parse({ model: "p/m" })), false, "model tanpa provider belum siap")
  assert.equal(isConfigured(Config.parse(buildConfig(choice))), true)
})
