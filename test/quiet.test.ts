import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"

/**
 * Peringatan dicetak Node ke stderr saat modulnya dimuat, jadi satu-satunya
 * cara jujur membuktikan ia diam adalah MENJALANKAN biner hasil build dan
 * membaca stderr-nya. Mengimpor `quiet.ts` di dalam test tidak membuktikan apa
 * pun: `node:sqlite` sudah dimuat lebih dulu oleh test lain di proses yang sama.
 */
const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js")

function jalankan(...args: string[]): { stdout: string; stderr: string } {
  const hasil = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" })
  return { stdout: hasil.stdout ?? "", stderr: hasil.stderr ?? "" }
}

test("peringatan eksperimental node:sqlite tidak menyambut user", () => {
  /*
   * `node:sqlite` dimuat di hampir setiap perintah, termasuk `--version`, jadi
   * dua baris peringatan muncul sebelum satu pun keluaran yang diminta. Ia bukan
   * tanda ada yang salah — modul itu dipilih dengan sadar, dan itulah alasan
   * Node ≥22.6 jadi syarat.
   */
  const { stdout, stderr } = jalankan("--version")

  assert.match(stdout, /0\.1\.0/, "versinya tetap tercetak")
  assert.doesNotMatch(stderr, /ExperimentalWarning/, `stderr tidak bersih: ${stderr}`)
  assert.doesNotMatch(stderr, /SQLite/)
})

test("peringatan LAIN tetap diteruskan, lengkap dengan petunjuk trace-nya", () => {
  /*
   * Meredam semua peringatan jauh lebih mudah, dan justru itu bahayanya:
   * deprecation yang seharusnya jadi peringatan dini akan hilang tanpa jejak.
   * Penangan bawaan Node dipanggil kembali apa adanya, bukan ditiru — itu yang
   * membuat `--trace-warnings` tetap bekerja.
   */
  const hasil = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import ${JSON.stringify(path.join(import.meta.dirname, "..", "dist", "quiet.js"))}
       process.emitWarning("halo dari test", "DeprecationWarning")
       process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning")`,
    ],
    { encoding: "utf8" },
  )

  const stderr = hasil.stderr ?? ""
  assert.match(stderr, /DeprecationWarning: halo dari test/, "peringatan lain harus lolos")
  assert.match(stderr, /--trace-deprecation/, "petunjuk bawaan Node ikut lolos")
  assert.doesNotMatch(stderr, /ExperimentalWarning/, "yang SQLite tetap diredam")
})
