import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  checkEngine,
  extensionDir,
  entryFile,
  ExtensionError,
  loadExtensions,
  parseExtensionSpec,
  parseInstallTarget,
  readManifest,
} from "../src/core/extension.ts"
import { Config } from "../src/core/schema.ts"

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "titah-extension-"))
}

/** Menulis satu extension lokal yang bisa dimuat sungguhan. */
function writeExtension(
  root: string,
  name: string,
  body: string,
  manifest: Record<string, unknown> = {},
): string {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", engines: { titah: "^0.2.0" }, titah: { panel: "./panel.mjs" }, ...manifest }),
  )
  fs.writeFileSync(path.join(directory, "panel.mjs"), body)
  return directory
}

function configWith(extension: Record<string, unknown>) {
  return Config.parse({ extension })
}

test("tiga bentuk spec dikenali, sama seperti plugin", () => {
  assert.deepEqual(parseExtensionSpec("@acme/titah-git"), { kind: "npm", package: "@acme/titah-git" })
  assert.deepEqual(parseExtensionSpec("./ext/notes"), { kind: "file", path: "./ext/notes" })
  assert.deepEqual(parseExtensionSpec("market:git"), { kind: "market", id: "git" })
})

test("extension npm dicari di node_modules, tempat npm sungguh menaruhnya", () => {
  // Menyandikan nama sendiri (mis. `@acme+git`) berarti Titah mencari di tempat
  // yang bukan tempat npm menaruhnya, dan gejalanya adalah "No package.json"
  // untuk paket yang jelas-jelas baru saja terpasang.
  const dir = extensionDir({ kind: "npm", package: "@acme/titah-git" }, "/tmp")
  assert.ok(dir.endsWith(path.join("node_modules", "@acme", "titah-git")), dir)
})

test("extension tanpa engines.titah DITOLAK, bukan diloloskan", () => {
  // Selama API 0.x, paket yang tidak menyatakan versi yang ia targetkan tidak
  // bisa dibedakan dari paket yang ditulis dua rilis lalu.
  assert.throws(() => checkEngine({ name: "x" }, "0.2.1"), ExtensionError)
  assert.throws(() => checkEngine({ name: "x", engines: { titah: "  " } }, "0.2.1"), ExtensionError)
})

test("pesan versi tidak cocok menyebut KEDUA versi", () => {
  // Pesan yang hanya menyebut salah satunya menyuruh orang mencari yang lain.
  try {
    checkEngine({ name: "git-panel", engines: { titah: "^9.0.0" } }, "0.2.1")
    assert.fail("seharusnya melempar")
  } catch (error) {
    const message = (error as Error).message
    assert.ok(message.includes("^9.0.0"), message)
    assert.ok(message.includes("0.2.1"), message)
  }
})

test("manifest tanpa titah.panel gagal dengan sebab yang benar", () => {
  assert.throws(() => entryFile("/tmp/x", { name: "x" }), /does not declare/)
})

test("entry point yang menunjuk keluar direktorinya ditolak", () => {
  /*
   * `"panel": "../../../etc/passwd"` adalah manifest yang sah secara JSON.
   * Tanpa pemeriksaan ini, sebuah paket bisa menyuruh Titah meng-import berkas
   * di luar dirinya — kemampuan yang tidak pernah diberikan ke extension.
   */
  assert.throws(
    () => entryFile("/tmp/ext", { name: "x", titah: { panel: "../../etc/passwd" } }),
    /outside its own directory/,
  )
})

test("manifest yang tidak bisa diurai dilaporkan, bukan dianggap kosong", () => {
  // Manifest kosong lolos pemeriksaan engines dengan diam, dan yang gagal
  // berikutnya adalah import — dengan pesan yang tidak menyebut sebabnya.
  const directory = scratch()
  fs.writeFileSync(path.join(directory, "package.json"), "{ bukan json")
  assert.throws(() => readManifest(directory), /not valid JSON/)
})

test("extension lokal dimuat sungguhan dan panelnya bisa merender", async () => {
  const root = scratch()
  writeExtension(
    root,
    "notes",
    `export default function ({ cwd, options }) {
       return {
         title: "Notes",
         side: "right",
         key: "<leader>o",
         render() { return { kind: "text", text: options.label ?? cwd } }
       }
     }`,
  )

  const result = await loadExtensions({
    config: configWith({ "./notes": { options: { label: "hello" } } }),
    cwd: root,
    version: "0.2.1",
  })

  assert.deepEqual(result.failures, [])
  assert.equal(result.extensions.length, 1)
  const loaded = result.extensions[0]
  assert.equal(loaded?.side, "right")
  assert.equal(loaded?.key, "<leader>o")
  assert.deepEqual(await loaded?.panel.render({ signal: AbortSignal.abort(), width: 16, rows: 8 }), {
    kind: "text",
    text: "hello",
  })
})

test("config user menimpa sisi dan tombol yang diusulkan extension", async () => {
  // Pembuat extension paling tahu panelnya; user paling tahu terminalnya.
  // Keduanya benar, dan yang kedua menang.
  const root = scratch()
  writeExtension(root, "notes", `export default () => ({ title: "N", side: "right", key: "<leader>o", render: () => ({ kind: "text", text: "" }) })`)

  const result = await loadExtensions({
    config: configWith({ "./notes": { side: "left", key: "<leader>k" } }),
    cwd: root,
    version: "0.2.1",
  })
  assert.equal(result.extensions[0]?.side, "left")
  assert.equal(result.extensions[0]?.key, "<leader>k")
})

test("satu extension yang gagal tidak menjatuhkan yang lain", async () => {
  /*
   * Aturan yang sama dengan plugin dan dengan server MCP yang mati. Sesi yang
   * menolak dimulai karena satu panel rusak menghukum orang atas hal yang tidak
   * ia minta saat itu.
   */
  const root = scratch()
  writeExtension(root, "good", `export default () => ({ title: "G", side: "left", render: () => ({ kind: "text", text: "ok" }) })`)
  writeExtension(root, "bad", `throw new Error("modul ini rusak di level atas")`)

  const result = await loadExtensions({
    config: configWith({ "./bad": {}, "./good": {} }),
    cwd: root,
    version: "0.2.1",
  })

  assert.equal(result.extensions.length, 1)
  assert.equal(result.extensions[0]?.spec, "./good")
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.spec, "./bad")
  assert.match(result.failures[0]?.message ?? "", /rusak di level atas/)
})

test("modul tanpa default export function dilaporkan dengan sebab yang benar", async () => {
  const root = scratch()
  writeExtension(root, "wrong", `export const panel = {}`)
  const result = await loadExtensions({ config: configWith({ "./wrong": {} }), cwd: root, version: "0.2.1" })
  assert.match(result.failures[0]?.message ?? "", /default-export a function/)
})

test("factory yang mengembalikan objek tanpa render dilaporkan", async () => {
  const root = scratch()
  writeExtension(root, "norender", `export default () => ({ title: "X" })`)
  const result = await loadExtensions({ config: configWith({ "./norender": {} }), cwd: root, version: "0.2.1" })
  assert.match(result.failures[0]?.message ?? "", /without a render\(\) function/)
})

test("dua extension yang menginginkan sisi yang sama: yang PERTAMA di config menang", async () => {
  /*
   * Urutan config adalah satu-satunya urutan yang user bisa lihat dan ubah.
   * Memilih berdasarkan apa pun yang lain — abjad, waktu pasang — berarti
   * pemenangnya tidak bisa dijelaskan kepada orang yang membaca config-nya.
   */
  const root = scratch()
  writeExtension(root, "first", `export default () => ({ title: "1", side: "left", render: () => ({ kind: "text", text: "" }) })`)
  writeExtension(root, "second", `export default () => ({ title: "2", side: "left", render: () => ({ kind: "text", text: "" }) })`)

  const result = await loadExtensions({
    config: configWith({ "./first": {}, "./second": {} }),
    cwd: root,
    version: "0.2.1",
  })
  assert.equal(result.extensions.length, 1)
  assert.equal(result.extensions[0]?.spec, "./first")
  assert.match(result.failures[0]?.message ?? "", /already taken/)
})

test("enabled: false tidak meng-import modulnya sama sekali", async () => {
  /*
   * Bukan sekadar tidak dipakai. Kode di level atas modul berjalan saat import,
   * jadi extension yang dimatikan tapi tetap di-import masih melakukan apa pun
   * yang ia lakukan di level atas.
   */
  const root = scratch()
  const marker = path.join(root, "imported.marker")
  writeExtension(
    root,
    "sideeffect",
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x"); export default () => ({ title: "S", render: () => ({ kind: "text", text: "" }) })`,
  )

  const result = await loadExtensions({
    config: configWith({ "./sideeffect": { enabled: false } }),
    cwd: root,
    version: "0.2.1",
  })
  assert.deepEqual(result.extensions, [])
  assert.deepEqual(result.failures, [])
  assert.equal(fs.existsSync(marker), false)
})

test("market: gagal dengan kalimat yang menyebut keadaannya", async () => {
  // Bukan diam-diam diperlakukan sebagai nama paket npm yang berujung "module
  // not found" — pesan yang menunjuk sebab yang salah.
  const result = await loadExtensions({ config: configWith({ "market:git": {} }), cwd: scratch(), version: "0.2.1" })
  assert.match(result.failures[0]?.message ?? "", /registry is not wired yet/)
})

test("nama paket berskop tidak terpotong pada @ di posisi nol", () => {
  /*
   * `@titah/extension-git` yang dipisah pada `@` pertama menghasilkan paket
   * bernama KOSONG pada versi `titah/extension-git`, dan npm lalu gagal dengan
   * pesan tentang nama paket yang tidak pernah user tulis.
   */
  assert.deepEqual(parseInstallTarget("@titah/extension-git"), { packageName: "@titah/extension-git" })
  assert.deepEqual(parseInstallTarget("@titah/extension-git@1.2.3"), {
    packageName: "@titah/extension-git",
    version: "1.2.3",
  })
})

test("paket tanpa skop dipisah seperti biasa", () => {
  assert.deepEqual(parseInstallTarget("git-panel"), { packageName: "git-panel" })
  assert.deepEqual(parseInstallTarget("git-panel@0.1.0"), { packageName: "git-panel", version: "0.1.0" })
})

test("spasi di sekitar spec tidak jadi bagian nama paket", () => {
  // Disalin-tempel dari README orang, spasi ikut terbawa — dan `npm install
  // " git-panel"` gagal dengan pesan yang tidak menyebut spasinya.
  assert.deepEqual(parseInstallTarget("  git-panel@1.0.0  "), { packageName: "git-panel", version: "1.0.0" })
})
