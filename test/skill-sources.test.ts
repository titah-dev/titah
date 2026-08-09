import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { allSources, claudeSources, opencodeSources } from "../src/core/skill-sources.ts"
import { Config } from "../src/core/schema.ts"

/** HOME palsu — test TIDAK BOLEH menyentuh ~/.claude milik siapa pun. */
function fakeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-home-"))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(home, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return home
}

test("registry Claude Code diterjemahkan jadi sumber skill", () => {
  const home = fakeHome({})
  const install = path.join(home, "plugins", "superpowers", "6.2.0")
  fs.mkdirSync(path.join(install, "skills"), { recursive: true })
  fs.mkdirSync(path.join(install, ".claude-plugin"), { recursive: true })
  fs.writeFileSync(
    path.join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "superpowers" }),
  )
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "superpowers@official": [{ installPath: install, version: "6.2.0" }] },
    }),
  )

  assert.deepEqual(claudeSources(home), [
    { root: path.join(install, "skills"), namespace: "superpowers" },
  ])
})

test("plugin tanpa folder skills dilewati", () => {
  const home = fakeHome({})
  const install = path.join(home, "plugins", "kosong", "1.0.0")
  fs.mkdirSync(install, { recursive: true })
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "kosong@x": [{ installPath: install }] } }),
  )
  assert.deepEqual(claudeSources(home), [])
})

test("registry yang hilang atau formatnya asing menghasilkan nol sumber, bukan error", () => {
  // Format itu milik Claude Code dan bisa berubah kapan saja tanpa memberi tahu.
  assert.deepEqual(claudeSources(fakeHome({})), [])
  assert.deepEqual(
    claudeSources(fakeHome({ ".claude/plugins/installed_plugins.json": "{ bukan json" })),
    [],
  )
  assert.deepEqual(
    claudeSources(fakeHome({ ".claude/plugins/installed_plugins.json": '{"version":99}' })),
    [],
  )
})

test("skills.paths opencode dibaca dari config-nya", () => {
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({
      skills: { paths: ["/tmp/skill-opencode"] },
    }),
  })
  assert.deepEqual(opencodeSources(home), [
    { root: "/tmp/skill-opencode", namespace: "skill-opencode" },
  ])
})

test("path milik user menang atas hasil auto-deteksi", () => {
  // Konfigurasi yang ditulis sendiri harus mengalahkan apa pun yang disimpulkan.
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["/tmp/auto"] } }),
  })
  const config = Config.parse({ skills: { paths: [{ path: "/tmp/punyaku", as: "punyaku" }] } })
  const sources = allSources(config, "/tmp", home)

  assert.equal(sources[0]?.namespace, "punyaku", "punya user lebih dulu")
})

test("discover kosong mematikan seluruh auto-deteksi", () => {
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["/tmp/auto"] } }),
  })
  const config = Config.parse({ skills: { discover: [], paths: ["./skills"] } })
  const sources = allSources(config, "/proyek", home)

  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.root, path.resolve("/proyek", "./skills"))
})
