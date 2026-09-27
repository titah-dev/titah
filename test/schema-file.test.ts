import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { beforeEach, after } from "node:test"

/**
 * HOME diisolasi lewat XDG sebelum impor: `userSchemaFile()` dan
 * `globalConfigFile()` membaca env saat dipanggil, dan test ini MENULIS ke
 * keduanya. Tanpa isolasi ia akan menyunting titah.json milik siapa pun yang
 * menjalankannya.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-schema-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")

const { bundledSchemaFile, migrateSchemaRef, readSchemaRef, syncSchemaFile } = await import(
  "../src/core/schema-file.ts"
)
const { globalConfigFile, userSchemaFile } = await import("../src/core/paths.ts")
const { buildConfig } = await import("../src/core/onboarding.ts")

const bundled = path.join(root, "bundled.schema.json")

beforeEach(() => {
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
  fs.writeFileSync(bundled, '{"title":"v1"}\n')
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

function writeConfig(text: string): void {
  fs.mkdirSync(path.dirname(globalConfigFile()), { recursive: true })
  fs.writeFileSync(globalConfigFile(), text)
}

test("salinan schema berada di folder config, bukan di paket", () => {
  assert.equal(userSchemaFile(), path.join(root, "config", "titah", "config.schema.json"))
})

test("paket membawa schema di tempat yang dicari bundledSchemaFile", () => {
  // Kalau path relatifnya salah, setiap instalasi diam-diam jadi "unavailable".
  assert.ok(fs.existsSync(bundledSchemaFile()), bundledSchemaFile())
})

test("schema disalin kalau belum ada, lalu tidak ditulis ulang kalau sama", () => {
  assert.equal(syncSchemaFile(bundled), "created")
  assert.equal(fs.readFileSync(userSchemaFile(), "utf8"), '{"title":"v1"}\n')

  const before = fs.statSync(userSchemaFile()).mtimeMs
  assert.equal(syncSchemaFile(bundled), "current")
  assert.equal(fs.statSync(userSchemaFile()).mtimeMs, before)
})

test("upgrade: isi yang berbeda menimpa salinan lama", () => {
  syncSchemaFile(bundled)
  fs.writeFileSync(bundled, '{"title":"v2"}\n')
  assert.equal(syncSchemaFile(bundled), "updated")
  assert.equal(fs.readFileSync(userSchemaFile(), "utf8"), '{"title":"v2"}\n')
  assert.deepEqual(
    fs.readdirSync(path.dirname(userSchemaFile())).filter((f) => f.endsWith(".tmp")),
    [],
    "berkas sementara tidak tertinggal",
  )
})

test("paket tanpa schema tidak menulis apa pun", () => {
  assert.equal(syncSchemaFile(path.join(root, "nope.json")), "unavailable")
  assert.equal(fs.existsSync(userSchemaFile()), false)
})

test("$schema lama dari paket dipindah, komentar user tetap utuh", () => {
  writeConfig(`{
  // path lama yang ditulis titah init 0.9.0
  "$schema": "/opt/homebrew/lib/node_modules/titah-code/config.schema.json",
  "model": "anthropic/claude", // model harian
}
`)
  assert.equal(readSchemaRef().state, "stale")
  assert.equal(migrateSchemaRef(), true)

  const text = fs.readFileSync(globalConfigFile(), "utf8")
  assert.ok(text.includes(`"$schema": "${userSchemaFile()}"`), text)
  assert.ok(text.includes("// path lama yang ditulis titah init 0.9.0"))
  assert.ok(text.includes("// model harian"))
  assert.equal(readSchemaRef().state, "current")
  assert.equal(migrateSchemaRef(), false, "kedua kalinya tidak ada yang berubah")
})

test("$schema yang menunjuk ke checkout repo juga dipindah", () => {
  writeConfig('{ "$schema": "/Users/ada/src/titah/config.schema.json" }\n')
  assert.equal(migrateSchemaRef(), true)
  assert.equal(readSchemaRef().state, "current")
})

test("URL dan nama berkas lain adalah pilihan user dan tidak disentuh", () => {
  for (const value of ["https://titah.dev/config.schema.json", "/Users/ada/my-schema.json"]) {
    const text = `{ "$schema": "${value}" }\n`
    writeConfig(text)
    assert.equal(readSchemaRef().state, "custom")
    assert.equal(migrateSchemaRef(), false)
    assert.equal(fs.readFileSync(globalConfigFile(), "utf8"), text)
  }
})

test("config tanpa $schema tidak ditambahi", () => {
  const text = '{ "model": "a/b" }\n'
  writeConfig(text)
  assert.equal(readSchemaRef().state, "absent")
  assert.equal(migrateSchemaRef(), false)
  assert.equal(fs.readFileSync(globalConfigFile(), "utf8"), text)
})

test("config yang tidak bisa diurai dibiarkan", () => {
  const text = '{ "$schema": "/old/config.schema.json", oops }\n'
  writeConfig(text)
  assert.equal(readSchemaRef().state, "unparsable")
  assert.equal(migrateSchemaRef(), false)
  assert.equal(fs.readFileSync(globalConfigFile(), "utf8"), text)
})

test("tanpa config sama sekali tidak ada yang dibuat", () => {
  assert.equal(readSchemaRef().state, "no-config")
  assert.equal(migrateSchemaRef(), false)
  assert.equal(fs.existsSync(globalConfigFile()), false)
})

test("init menulis $schema ke salinan di folder config", () => {
  const config = buildConfig(
    { id: "lokal", label: "Lokal", npm: "@ai-sdk/openai-compatible", model: "q", models: ["q"] },
    userSchemaFile(),
  ) as { $schema?: string }
  assert.equal(config.$schema, userSchemaFile())
})
