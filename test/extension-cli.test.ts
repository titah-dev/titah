import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

/**
 * `titah extension disable | enable | remove`, dijalankan sungguhan.
 *
 * Alasannya sama dengan yang tertulis di `cli-doctor.test.ts`: `cmdExtension`
 * hidup di dalam `src/cli.ts` yang memanggil `main()` di top level, jadi tidak
 * ada seam untuk mengimpornya. Yang diuji di sini justru bagian yang tidak bisa
 * dibuktikan tanpa berkas sungguhan — BERKAS MANA yang disunting.
 */

const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js")

interface Sandbox {
  /** cwd perintah; di sinilah `titah.json` proyek berada. */
  project: string
  globalFile: string
  projectFile: string
  run: (...args: string[]) => string
}

function sandbox(global: unknown, project: unknown): Sandbox {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-ext-cli-"))
  const projectDir = path.join(home, "project")
  const configDir = path.join(home, ".config", "titah")
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })

  const globalFile = path.join(configDir, "titah.json")
  const projectFile = path.join(projectDir, "titah.json")
  if (global !== undefined) fs.writeFileSync(globalFile, JSON.stringify(global, null, 2))
  if (project !== undefined) fs.writeFileSync(projectFile, JSON.stringify(project, null, 2))

  return {
    project: projectDir,
    globalFile,
    projectFile,
    run: (...args) =>
      execFileSync(process.execPath, [CLI, "extension", ...args], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
        },
      }),
  }
}

function read(file: string): { extension?: Record<string, { enabled?: boolean }> } {
  return JSON.parse(fs.readFileSync(file, "utf8")) as { extension?: Record<string, { enabled?: boolean }> }
}

test("disable menulis enabled:false ke berkas yang benar-benar menyebutnya", () => {
  const box = sandbox({ extension: { "@acme/x": {} } }, { extension: { "./notes": {} } })
  const output = box.run("disable", "./notes")

  assert.equal(read(box.projectFile).extension?.["./notes"]?.enabled, false)
  // Berkas global tidak boleh ikut tumbuh entri yang tidak pernah ada di sana.
  assert.equal(read(box.globalFile).extension?.["./notes"], undefined)
  assert.match(output, /titah\.json/)
})

test("enable membuang enabled:false, bukan menuliskan true", () => {
  // `enabled: true` adalah bawaan schema. Menuliskannya kembali meninggalkan
  // baris yang tidak menyatakan apa pun di config yang dirawat tangan.
  const box = sandbox(undefined, { extension: { "./notes": { enabled: false } } })
  box.run("enable", "./notes")
  const entry = read(box.projectFile).extension?.["./notes"]
  assert.deepEqual(entry, {})
})

test("remove path lokal benar-benar membuang entrinya dari config proyek", () => {
  /*
   * Ini yang hari ini gagal diam-diam. `install ./x` menulis ke config PROYEK,
   * `remove ./x` menyunting config GLOBAL, lalu mencetak "Removed" untuk entri
   * yang masih utuh — dan panelnya muncul lagi di sesi berikutnya.
   */
  const box = sandbox({ extension: { "@acme/x": {} } }, { extension: { "./notes": {} } })
  box.run("remove", "./notes")
  assert.equal(read(box.projectFile).extension?.["./notes"], undefined)
  assert.ok(read(box.globalFile).extension?.["@acme/x"] !== undefined)
})

test("remove membuang entri dari KEDUA berkas kalau disebut di dua-duanya", () => {
  // Dicabut dari satu saja, entri yang tertinggal menghidupkannya lagi.
  const box = sandbox({ extension: { "./notes": {} } }, { extension: { "./notes": { side: "right" } } })
  box.run("remove", "./notes")
  assert.equal(read(box.globalFile).extension?.["./notes"], undefined)
  assert.equal(read(box.projectFile).extension?.["./notes"], undefined)
})

test("remove spec yang tidak disebut di mana pun mengatakannya, bukan melapor berhasil", () => {
  const box = sandbox({ extension: {} }, { extension: {} })
  const output = box.run("remove", "./tidak-pernah-ada")
  assert.doesNotMatch(output, /^Removed/m)
  assert.match(output, /not in any config file/i)
})

test("remove market: membuang kunci market:, bukan nama paketnya", () => {
  // Kunci config-nya `market:<id>`. Menghapus dengan nama paket berarti
  // menghapus kunci yang tidak pernah ada, lalu melapor berhasil.
  const box = sandbox({ extension: { "market:git": {} } }, undefined)
  box.run("remove", "market:git")
  assert.equal(read(box.globalFile).extension?.["market:git"], undefined)
})

test("list melaporkan extension yang dimatikan, bukan menyembunyikannya", () => {
  /*
   * `loadExtensions()` melewati `enabled: false` sebelum sempat melaporkannya,
   * jadi tanpa baris khusus di sini extension yang sengaja dimatikan user
   * hilang diam-diam dari `list` — dan orang mengira ia terhapus.
   */
  const box = sandbox(undefined, { extension: { "./notes": { enabled: false } } })
  const output = box.run("list")
  assert.match(output, /\.\/notes/)
  assert.match(output, /disabled/i)
})

test("komentar JSONC bertahan melewati disable", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-ext-cli-jsonc-"))
  const projectDir = path.join(home, "project")
  fs.mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, "titah.json")
  fs.writeFileSync(file, '{\n  // panel catatan, jangan dihapus\n  "extension": { "./notes": {} }\n}\n')

  execFileSync(process.execPath, [CLI, "extension", "disable", "./notes"], {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
    },
  })

  const after = fs.readFileSync(file, "utf8")
  assert.ok(after.includes("// panel catatan, jangan dihapus"))
  assert.match(after, /"enabled":\s*false/)
})
