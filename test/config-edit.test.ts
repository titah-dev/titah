import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ConfigUnparsable, editConfigFile, editJsonc } from "../src/core/config-edit.ts"

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "titah-config-edit-"))
}

test("komentar user bertahan melewati penyuntingan", () => {
  /*
   * Ini alasan seluruh modul ini ada. `JSON.parse` lalu `JSON.stringify`
   * menghasilkan berkas yang setara secara data dan menghapus setiap komentar —
   * kerusakan yang tidak bisa dibatalkan, pada berkas yang dirawat tangan.
   */
  const before = `{
  // Model default, jangan diubah tanpa mengukur dulu.
  "model": "anthropic/claude-opus-4",

  /* Panel: lebar dipilih untuk terminal 100 kolom. */
  "panel": { "floor": 40 }
}
`
  const after = editJsonc(before, ["extension", "@titah/extension-git"], { side: "left" })
  assert.ok(after.includes("// Model default, jangan diubah tanpa mengukur dulu."))
  assert.ok(after.includes("/* Panel: lebar dipilih untuk terminal 100 kolom. */"))
  assert.ok(after.includes('"@titah/extension-git"'))
})

test("key yang tidak disentuh tidak berubah bentuknya", () => {
  const before = '{\n  "model":    "a/b",\n  "panel": { "floor": 40 }\n}\n'
  const after = editJsonc(before, ["extension"], {})
  // Spasi ganjil di `"model":    "a/b"` adalah pilihan user. Formatter yang
  // merapikan seluruh berkas mengubah baris yang tidak diminta siapa pun.
  assert.ok(after.includes('"model":    "a/b"'))
})

test("jalur bersarang dibuat kalau induknya belum ada", () => {
  const after = editJsonc("{}\n", ["extension", "@acme/x", "key"], "<leader>g")
  const parsed = JSON.parse(after) as { extension: Record<string, { key: string }> }
  assert.equal(parsed.extension["@acme/x"]?.key, "<leader>g")
})

test("undefined menghapus jalurnya, bukan menuliskan null", () => {
  // Mencabut extension harus membuang entrinya. `null` di sana meninggalkan
  // entri yang tetap dimuat lalu gagal dengan sebab yang tidak jelas.
  const before = '{\n  "extension": {\n    "a": {},\n    "b": {}\n  }\n}\n'
  const after = editJsonc(before, ["extension", "a"], undefined)
  const parsed = JSON.parse(after) as { extension: Record<string, unknown> }
  assert.deepEqual(Object.keys(parsed.extension), ["b"])
  assert.ok(!after.includes("null"))
})

test("trailing comma diterima, bukan dianggap berkas rusak", () => {
  // Config Titah adalah JSONC dan `config.ts` mengurainya dengan
  // allowTrailingComma. Penulis yang lebih ketat dari pembaca akan menolak
  // berkas yang sedang dipakai Titah dengan baik.
  const directory = scratch()
  const file = path.join(directory, "titah.json")
  fs.writeFileSync(file, '{\n  "model": "a/b",\n}\n')
  assert.equal(editConfigFile(file, ["panel", "floor"], 50), true)
  const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/,(\s*[}\]])/g, "$1")) as {
    panel: { floor: number }
  }
  assert.equal(parsed.panel.floor, 50)
})

test("config yang tidak bisa diurai DITOLAK, dan berkasnya tidak tersentuh", () => {
  /*
   * Satu koma salah masih membawa seluruh pilihan user. Menggantinya dengan
   * berkas yang hanya berisi apa yang kita tahu berarti menghukum satu salah
   * tulis dengan kehilangan segalanya — jadi yang benar adalah menolak.
   */
  const directory = scratch()
  const file = path.join(directory, "titah.json")
  const broken = '{\n  "model": "a/b"\n  "panel": {}\n}\n'
  fs.writeFileSync(file, broken)
  assert.throws(() => editConfigFile(file, ["panel", "floor"], 50), ConfigUnparsable)
  assert.equal(fs.readFileSync(file, "utf8"), broken)
})

test("berkas yang belum ada dibuat beserta direktori induknya", () => {
  const directory = scratch()
  const file = path.join(directory, "nested", "deep", "titah.json")
  assert.equal(editConfigFile(file, ["panel", "floor"], 50), true)
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { panel: { floor: number } }
  assert.equal(parsed.panel.floor, 50)
})

test("berkas kosong diperlakukan sebagai objek kosong, bukan sebagai kerusakan", () => {
  const directory = scratch()
  const file = path.join(directory, "titah.json")
  fs.writeFileSync(file, "\n   \n")
  assert.equal(editConfigFile(file, ["panel", "floor"], 50), true)
})

test("menulis nilai yang sudah sama tidak menyentuh berkas", () => {
  // Pemanggil memakai nilai kembaliannya untuk memutuskan apakah perlu memberi
  // tahu user. Selalu mengembalikan true berarti setiap pemasangan mengaku
  // mengubah config, termasuk yang tidak mengubah apa pun.
  const directory = scratch()
  const file = path.join(directory, "titah.json")
  fs.writeFileSync(file, '{\n  "panel": {\n    "floor": 50\n  }\n}\n')
  const before = fs.statSync(file).mtimeMs
  assert.equal(editConfigFile(file, ["panel", "floor"], 50), false)
  assert.equal(fs.statSync(file).mtimeMs, before)
})

test("tidak ada berkas .tmp yang tertinggal sesudah penulisan berhasil", () => {
  // Penulisan lewat temp + rename adalah yang membuatnya atomik. Temp yang
  // tertinggal berarti rename-nya tidak terjadi, dan config yang dibaca sesi
  // berikutnya bukan yang baru saja ditulis.
  const directory = scratch()
  const file = path.join(directory, "titah.json")
  editConfigFile(file, ["panel", "floor"], 50)
  assert.deepEqual(fs.readdirSync(directory), ["titah.json"])
})
