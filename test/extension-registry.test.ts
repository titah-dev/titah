import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadRegistry, parseRegistry, REGISTRY_TTL_MS } from "../src/core/extension-registry.ts"
import { installLabel, pickerRows } from "../src/core/extension-picker.ts"
import { buildKeymap } from "../src/tui/keybinds.ts"

function scratch(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "titah-registry-")), "registry.json")
}

const INDEX = JSON.stringify({
  version: 1,
  extension: [
    { id: "git", package: "@titah/extension-git", version: "1.0.0", title: "Branches", description: "git worktrees and branches" },
    { id: "todo", package: "@acme/todo", version: "0.3.0", title: "Todo" },
  ],
})

test("entri yang tidak lengkap dibuang satu-satu, bukan menggagalkan seluruh index", () => {
  /*
   * Satu PR yang salah tulis tidak boleh mematikan picker untuk semua orang
   * sampai seseorang memperbaikinya.
   */
  const entries = parseRegistry(
    JSON.stringify({
      version: 1,
      extension: [
        { id: "ok", package: "@a/b", version: "1.0.0" },
        { id: "no-version", package: "@a/c" },
        { package: "@a/d", version: "1.0.0" },
        { id: "", package: "@a/e", version: "1.0.0" },
      ],
    }),
  )
  assert.deepEqual(entries.map((entry) => entry.id), ["ok"])
})

test("index dengan versi format lain ditolak seluruhnya", () => {
  assert.throws(() => parseRegistry(JSON.stringify({ version: 2, extension: [] })), /version 1/)
})

test("cache yang masih segar dipakai tanpa menyentuh jaringan", async () => {
  const file = scratch()
  let calls = 0
  await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: 1_000 })
  const second = await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: 1_000 + 60_000 })
  assert.equal(calls, 1)
  assert.equal(second.stale, false)
  assert.equal(second.entries.length, 2)
})

test("cache yang kedaluwarsa memicu jaringan", async () => {
  const file = scratch()
  let calls = 0
  await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: 0 })
  await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: REGISTRY_TTL_MS + 1 })
  assert.equal(calls, 2)
})

test("force melewati cache yang masih segar", async () => {
  const file = scratch()
  let calls = 0
  await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: 0 })
  await loadRegistry({ file, fetcher: async () => { calls++; return INDEX }, now: 1, force: true })
  assert.equal(calls, 2)
})

test("jaringan mati menampilkan cache dan MENGATAKAN ia usang", async () => {
  /*
   * Cache yang dibuang saat jaringan mati berarti satu penerbangan tanpa wifi
   * membuat picker kosong — dan orang menyimpulkan tidak ada extension yang ada,
   * yang salah.
   */
  const file = scratch()
  await loadRegistry({ file, fetcher: async () => INDEX, now: 0 })
  const offline = await loadRegistry({
    file,
    fetcher: async () => { throw new Error("getaddrinfo ENOTFOUND") },
    now: REGISTRY_TTL_MS + 1,
  })
  assert.equal(offline.stale, true)
  assert.equal(offline.entries.length, 2)
  assert.match(offline.reason ?? "", /ENOTFOUND/)
})

test("jaringan mati tanpa cache menghasilkan daftar kosong beserta sebabnya", async () => {
  const offline = await loadRegistry({
    file: scratch(),
    fetcher: async () => { throw new Error("503 Service Unavailable") },
  })
  assert.deepEqual(offline.entries, [])
  assert.equal(offline.stale, true)
  assert.match(offline.reason ?? "", /503/)
})

test("index yang tidak bisa diurai jatuh ke cache, bukan meledak", async () => {
  const file = scratch()
  await loadRegistry({ file, fetcher: async () => INDEX, now: 0 })
  const broken = await loadRegistry({ file, fetcher: async () => "{ rusak", now: REGISTRY_TTL_MS + 1 })
  assert.equal(broken.stale, true)
  assert.equal(broken.entries.length, 2)
})

// --- picker ---------------------------------------------------------------

test("tiga keadaan dibedakan, dan I menjanjikan hal yang berbeda pada masing-masing", () => {
  const registry = parseRegistry(INDEX)
  const rows = pickerRows({
    configured: ["@titah/extension-git", "./local-notes"],
    installed: ["@titah/extension-git"],
    registry,
  })

  assert.deepEqual(
    rows.map((row) => [row.spec, row.state]),
    [
      ["@titah/extension-git", "installed"],
      ["./local-notes", "configured"],
      ["@acme/todo", "available"],
    ],
  )
  assert.equal(installLabel(rows[0]!), "already installed")
  assert.equal(installLabel(rows[1]!), "download ./local-notes")
  assert.match(installLabel(rows[2]!), /add @acme\/todo to your config/)
})

test("baris config mendahului registry, dalam urutan config", () => {
  // Urutan config adalah satu-satunya urutan yang user bisa lihat dan ubah;
  // barisnya tidak boleh berpindah saat registry di-update dari jauh.
  const rows = pickerRows({
    configured: ["@acme/todo", "@titah/extension-git"],
    installed: [],
    registry: parseRegistry(INDEX),
  })
  assert.deepEqual(rows.map((row) => row.spec), ["@acme/todo", "@titah/extension-git"])
})

test("spec market: dipetakan ke paketnya, bukan diperlakukan sebagai nama paket", () => {
  const rows = pickerRows({
    configured: ["market:git"],
    installed: ["@titah/extension-git"],
    registry: parseRegistry(INDEX),
  })
  assert.equal(rows[0]?.packageName, "@titah/extension-git")
  assert.equal(rows[0]?.state, "installed")
})

test("pencarian melihat judul dan keterangan, bukan hanya nama paket", () => {
  /*
   * Orang mencari "worktree" untuk menemukan panel yang judulnya "Branches".
   * Pencarian yang hanya melihat nama paket mengembalikan nol untuk kueri yang
   * jelas-jelas cocok.
   */
  const registry = parseRegistry(INDEX)
  assert.equal(pickerRows({ configured: [], installed: [], registry, query: "worktree" }).length, 1)
  assert.equal(pickerRows({ configured: [], installed: [], registry, query: "Branches" }).length, 1)
  assert.equal(pickerRows({ configured: [], installed: [], registry, query: "TODO" }).length, 1)
  assert.equal(pickerRows({ configured: [], installed: [], registry, query: "nihil" }).length, 0)
})

test("tombol yang bertabrakan dilaporkan beserta aksi yang memilikinya", () => {
  // Tabrakan diselesaikan SEKALI di sini, bukan jadi misteri runtime yang
  // pemenangnya ditentukan urutan key di objek config.
  const rows = pickerRows({
    configured: ["@acme/todo"],
    installed: [],
    registry: parseRegistry(INDEX),
    proposedKeys: { "@acme/todo": "<leader>d" },
    keymap: buildKeymap(),
  })
  assert.equal(rows[0]?.key, "<leader>d")
  assert.equal(rows[0]?.keyConflict, "tool_details")
})

test("tombol yang bebas tidak dilaporkan bertabrakan", () => {
  const rows = pickerRows({
    configured: ["@acme/todo"],
    installed: [],
    registry: parseRegistry(INDEX),
    proposedKeys: { "@acme/todo": "<leader>g" },
    keymap: buildKeymap(),
  })
  assert.equal(rows[0]?.key, "<leader>g")
  assert.equal(rows[0]?.keyConflict, undefined)
})
