import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

/**
 * Menjalankan uji plugin Neovim dari gate yang sama dengan sisa Titah.
 *
 * Tanpa ini, `editor/nvim/test/titah_spec.lua` adalah berkas yang hanya
 * berjalan kalau ada yang ingat menjalankannya — dan test yang bergantung pada
 * ingatan orang adalah test yang berhenti dijalankan setelah minggu kedua.
 *
 * Kalau Neovim tidak terpasang, test ini DILEWATI dan bukan dipalsukan:
 * meniru API Neovim hanya membuktikan tiruannya bekerja.
 */

const ROOT = path.join(import.meta.dirname, "..", "editor", "nvim")

const nvimAda = (() => {
  try {
    execFileSync("nvim", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test("plugin Neovim: berkasnya ada di tempat yang dicari Neovim", () => {
  // Tata letaknya bukan selera: Neovim memuat `plugin/*.lua` otomatis dan
  // mencari modul di `lua/`. Salah menaruhnya membuat plugin diam tanpa error.
  assert.ok(fs.existsSync(path.join(ROOT, "lua", "titah", "init.lua")))
  assert.ok(fs.existsSync(path.join(ROOT, "plugin", "titah.lua")))
})

test("plugin Neovim: uji Lua-nya lulus", { skip: !nvimAda }, () => {
  const hasil = spawnSync(
    "nvim",
    ["--headless", "--clean", "--cmd", `set rtp+=${ROOT}`, "-l", "test/titah_spec.lua"],
    { cwd: ROOT, encoding: "utf8" },
  )

  const keluaran = `${hasil.stdout ?? ""}${hasil.stderr ?? ""}`
  assert.equal(hasil.status, 0, `uji Lua gagal:\n${keluaran}`)
  assert.match(keluaran, /SEMUA LULUS/)
})

test("plugin Neovim: perintahnya benar-benar terdaftar", { skip: !nvimAda }, () => {
  /*
   * Memeriksa berkasnya termuat tidak cukup. Yang menentukan adalah apakah
   * `:Titah` dan `:TitahAsk` ada setelah Neovim selesai memuat — kesalahan
   * sintaks di `plugin/titah.lua` membuat plugin gagal diam-diam, dan gejalanya
   * hanyalah perintah yang tidak dikenal.
   */
  const hasil = spawnSync(
    "nvim",
    [
      "--headless",
      "--clean",
      "--cmd",
      `set rtp+=${ROOT}`,
      "-c",
      'lua io.write(table.concat(vim.tbl_keys(vim.api.nvim_get_commands({})), " "))',
      "-c",
      "qall!",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )

  const keluaran = `${hasil.stdout ?? ""}${hasil.stderr ?? ""}`
  for (const perintah of ["Titah", "TitahAsk", "TitahStop"]) {
    assert.match(keluaran, new RegExp(`\\b${perintah}\\b`), `:${perintah} tidak terdaftar`)
  }
})

test("plugin Neovim: modulnya dimuat MALAS", () => {
  /*
   * `require("titah")` di level atas `plugin/titah.lua` akan menambah waktu
   * start Neovim untuk setiap orang yang memasangnya, termasuk yang hari itu
   * tidak menyentuh Titah sama sekali. Ia harus berada di dalam handler
   * perintahnya.
   */
  const source = fs.readFileSync(path.join(ROOT, "plugin", "titah.lua"), "utf8")
  const topLevel = source
    .split("\n")
    .filter((line) => /^\s*(local\s+\w+\s*=\s*)?require\(/.test(line))

  assert.deepEqual(topLevel, [], `require di level atas: ${topLevel.join(" | ")}`)
})
