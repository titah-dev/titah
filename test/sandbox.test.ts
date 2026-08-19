import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import { spawnSync } from "node:child_process"
import { available, cleanup, seatbeltProfile, wrap, SandboxUnavailable } from "../src/core/sandbox.ts"
import { Config } from "../src/core/schema.ts"

/**
 * Pagar di lapisan PROSES, bukan lapisan tool.
 *
 * Model izin Titah menjaga di lapisan tool. Begitu sebuah perintah `bash`
 * diizinkan, ia berjalan dengan hak penuh milik user: `rm -rf ~`, `curl | sh`,
 * menulis ke `~/.ssh`. Sumbu `delete` mengatur tool `remove`, dan `bash` tidak
 * pernah melewatinya.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-sbx-")))

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const config = (sandbox: Record<string, unknown>) => Config.parse({ sandbox })

// ---------- mati berarti tidak berubah sama sekali ----------

test("sandbox MATI meninggalkan perintahnya apa adanya", () => {
  /*
   * Jalur tanpa sandbox tidak boleh berubah bentuk sedikit pun: perilaku lama
   * harus tetap persis perilaku lama, sampai ke string perintahnya.
   */
  const wrapped = wrap(config({ bash: false }), "echo halo", root)
  assert.equal(wrapped.command, "echo halo")
  assert.equal(wrapped.cleanup, undefined)
})

test("bawaannya mati", () => {
  assert.equal(Config.parse({}).sandbox.bash, false)
})

// ---------- profil ----------

test("profil mengizinkan BACA di mana pun, melarang TULIS", () => {
  /*
   * Baca dibiarkan bebas dengan sengaja. Kompiler membaca `/usr/lib`, Node
   * membaca `node_modules` di tempat lain, `git` membaca config global —
   * mengurung bacaan berarti mengurung pekerjaan yang sah, dan user akan
   * mematikan seluruh fiturnya dalam sehari.
   */
  const profile = seatbeltProfile(root, true)
  assert.match(profile, /\(allow default\)/)
  assert.match(profile, /\(deny file-write\*\)/)
})

test("direktori proyek dan temp boleh ditulis", () => {
  const profile = seatbeltProfile(root, true)
  assert.ok(profile.includes(JSON.stringify(root)), "proyeknya sendiri")
  assert.match(profile, /allow file-write\* \(subpath/)
})

test("jaringan hanya dilarang kalau diminta", () => {
  assert.doesNotMatch(seatbeltProfile(root, true), /deny network/)
  assert.match(seatbeltProfile(root, false), /\(deny network\*\)/)
})

test("path di-escape, bukan ditempel mentah", () => {
  // Direktori dengan tanda kutip atau spasi akan memecah profilnya, dan profil
  // yang rusak ditolak seluruhnya — perintahnya gagal tanpa sebab yang terbaca.
  const aneh = path.join(root, 'ada "kutip" dan spasi')
  fs.mkdirSync(aneh, { recursive: true })
  assert.ok(seatbeltProfile(aneh, true).includes(JSON.stringify(fs.realpathSync(aneh))))
})

// ---------- gagal tertutup ----------

test("platform tanpa sandbox MENOLAK, bukan diam-diam jalan tanpa pagar", () => {
  /*
   * User yang menyalakannya percaya ada pagar di sana. Menjalankannya tanpa
   * pagar sambil diam adalah bentuk kebohongan paling mahal yang bisa dilakukan
   * fitur keamanan.
   */
  if (available() !== "none") return // mesin ini punya sandbox; jalur ini diuji lewat kode
  assert.throws(() => wrap(config({ bash: true }), "echo x", root), SandboxUnavailable)
})

test("ketersediaan diperiksa dari BERKASNYA, bukan dari nama platform", () => {
  // macOS tanpa `sandbox-exec` dan Linux tanpa `bwrap` sama-sama ada.
  const kind = available()
  assert.ok(["seatbelt", "bubblewrap", "none"].includes(kind))
  if (kind === "seatbelt") assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true)
})

// ---------- berkas profil ----------

test("profil ditulis ke BERKAS, bukan diberikan lewat -p", () => {
  /*
   * `-p` menaruh seluruh profil di baris perintah, dan profil ini memuat setiap
   * path yang boleh ditulis — pada proyek dengan path panjang ia menabrak batas
   * panjang argumen, dan kegagalannya muncul hanya di sebagian mesin.
   */
  if (available() !== "seatbelt") return
  const wrapped = wrap(config({ bash: true }), "echo x", root)
  assert.match(wrapped.command, /sandbox-exec -f/)
  assert.ok(wrapped.cleanup)
  assert.equal(fs.existsSync(wrapped.cleanup as string), true)

  cleanup(wrapped)
  assert.equal(fs.existsSync(wrapped.cleanup as string), false)
})

test("membuang profil yang sudah hilang tidak melempar", () => {
  cleanup({ command: "x", cleanup: path.join(root, "tidak-ada.sb") })
  assert.ok(true)
})

// ---------- benar-benar mengurung ----------

test("tulis di DALAM proyek berhasil, di LUAR ditolak sistem", () => {
  /*
   * Diuji dengan menjalankan perintahnya sungguhan, bukan dengan memeriksa
   * string profilnya. Profil yang terlihat benar dan tidak mengurung apa pun
   * adalah persis kegagalan yang fitur ini tidak boleh punya.
   */
  if (available() !== "seatbelt") return

  const inside = path.join(root, "boleh.txt")
  const outside = path.join(os.homedir(), `titah-sbx-${process.pid}.txt`)

  const run = (target: string): number => {
    const wrapped = wrap(config({ bash: true }), `echo x > ${JSON.stringify(target)}`, root)
    const result = spawnSync(wrapped.command, { shell: true, cwd: root })
    cleanup(wrapped)
    return result.status ?? -1
  }

  assert.equal(run(inside), 0, "di dalam proyek harus boleh")
  assert.equal(fs.readFileSync(inside, "utf8").trim(), "x")

  assert.notEqual(run(outside), 0, "di luar proyek harus ditolak")
  assert.equal(fs.existsSync(outside), false, "dan berkasnya tidak pernah ada")
})

test("membaca di luar proyek TETAP boleh", () => {
  // Kalau tidak, `git`, `node`, dan setiap kompiler berhenti bekerja.
  if (available() !== "seatbelt") return
  const wrapped = wrap(config({ bash: true }), "cat /etc/hosts > /dev/null", root)
  const result = spawnSync(wrapped.command, { shell: true, cwd: root })
  cleanup(wrapped)
  assert.equal(result.status, 0)
})
