import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { allSources, claudeSources, opencodeSources } from "../src/core/skill-sources.ts"
import { Config } from "../src/core/schema.ts"

// opencodeSources sekarang membaca XDG_CONFIG_HOME (bukan cuma <home>/.config
// yang dikasih ke fungsinya), jadi semua test di file ini harus tidak
// terpengaruh oleh env ambient — kalau tidak, lulus/gagalnya tergantung mesin
// yang menjalankan, bukan pada kode.
delete process.env["XDG_CONFIG_HOME"]

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

test("config opencode yang hilang atau formatnya asing menghasilkan nol sumber, bukan error", () => {
  // Format itu milik opencode dan bisa berubah kapan saja tanpa memberi tahu —
  // aturan yang sama seperti claudeSources, dicek di sini supaya regresi pada
  // guard opencodeSources tidak lolos tanpa terdeteksi.
  assert.deepEqual(opencodeSources(fakeHome({})), [])
  assert.deepEqual(
    opencodeSources(fakeHome({ ".config/opencode/opencode.json": "{ bukan json" })),
    [],
  )
  assert.deepEqual(
    opencodeSources(fakeHome({ ".config/opencode/opencode.json": '{"skills":"bukan objek"}' })),
    [],
  )
  assert.deepEqual(
    opencodeSources(
      fakeHome({
        ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: "bukan array" } }),
      }),
    ),
    [],
  )
})

test("path milik user menang atas hasil auto-deteksi", () => {
  // Konfigurasi yang ditulis sendiri harus mengalahkan apa pun yang disimpulkan.
  // Urutan LENGKAP dicek, bukan cuma elemen pertama — kalau auto-deteksi
  // diam-diam hilang (mis. `...auto` di allSources terlepas), sources[0]
  // tetap "punyaku" tapi panjangnya jadi 1, dan itu harus tertangkap di sini.
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["/tmp/auto"] } }),
  })
  const config = Config.parse({ skills: { paths: [{ path: "/tmp/punyaku", as: "punyaku" }] } })
  const sources = allSources(config, "/tmp", home)

  assert.deepEqual(
    sources.map((source) => source.namespace),
    ["punyaku", "auto"],
    "punya user lebih dulu, auto-deteksi tetap ada di belakangnya",
  )
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

test("opencodeSources menghormati XDG_CONFIG_HOME, bukan cuma <home>/.config", () => {
  // Bug produksi (bukan cuma soal test): sebelumnya opencodeSources selalu
  // membaca <home>/.config, mengabaikan XDG_CONFIG_HOME sepenuhnya. User yang
  // mengatur XDG_CONFIG_HOME ke tempat lain kehilangan skill opencode-nya
  // diam-diam — sama seperti bug isolasi yang ditemukan di test lain, tapi
  // ini terjadi bahkan di mesin user sungguhan, bukan cuma di test.
  const home = fakeHome({}) // <home>/.config sengaja dibiarkan kosong
  const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "titah-xdgconfig-"))
  fs.mkdirSync(path.join(xdgConfig, "opencode"), { recursive: true })
  fs.writeFileSync(
    path.join(xdgConfig, "opencode", "opencode.json"),
    JSON.stringify({ skills: { paths: ["/tmp/dari-xdg"] } }),
  )

  const original = process.env["XDG_CONFIG_HOME"]
  process.env["XDG_CONFIG_HOME"] = xdgConfig
  try {
    assert.deepEqual(opencodeSources(home), [{ root: "/tmp/dari-xdg", namespace: "dari-xdg" }])
  } finally {
    if (original === undefined) delete process.env["XDG_CONFIG_HOME"]
    else process.env["XDG_CONFIG_HOME"] = original
  }
})

test("home yang diisolasi sungguhan dibuktikan dua arah, bukan cuma kosong", () => {
  // Fake home yang KOSONG tidak bisa membedakan "benar terisolasi" dari "diam-diam
  // bocor ke $HOME asli yang kebetulan juga tidak punya skill itu" — keduanya
  // menghasilkan nol sumber. Jadi taruh skill BERSUNGGUHAN di fake home, lalu
  // buktikan dua arah: discover default menemukannya (membuktikan os.homedir()
  // benar-benar membaca $HOME yang diisolasi), dan discover: [] tidak menemukannya
  // (membuktikan opt-out sungguhan mematikan, bukan cuma kebetulan tidak ada apa-apa).
  const home = fakeHome({})
  const install = path.join(home, "plugins", "canary-plugin", "1.0.0")
  fs.mkdirSync(path.join(install, "skills", "canary-skill-jangan-bocor"), { recursive: true })
  fs.writeFileSync(
    path.join(install, "skills", "canary-skill-jangan-bocor", "SKILL.md"),
    "---\nname: canary-skill-jangan-bocor\n---\nisi",
  )
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "canary@test": [{ installPath: install, version: "1.0.0" }] },
    }),
  )

  const originalHome = process.env["HOME"]
  process.env["HOME"] = home
  try {
    const withDiscovery = allSources(Config.parse({}), "/proyek")
    assert.ok(
      withDiscovery.some((source) => source.root.includes("canary-plugin")),
      "discover default (tanpa override home) harus menemukan skill di $HOME yang diisolasi",
    )

    const withoutDiscovery = allSources(Config.parse({ skills: { discover: [] } }), "/proyek")
    assert.ok(
      !withoutDiscovery.some((source) => source.root.includes("canary-plugin")),
      "discover: [] harus benar-benar mematikannya, bukan kebetulan tidak ada apa-apa yang bisa ditemukan",
    )
  } finally {
    if (originalHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = originalHome
  }
})
