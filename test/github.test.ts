import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { githubTool, isReadOnly, refusalFor, subcommandOf } from "../src/core/tool/github.ts"
import { ToolError } from "../src/core/tool/types.ts"

const ctx = {
  cwd: process.cwd(),
  sessionID: "s",
  callID: "c",
  signal: new AbortController().signal,
  config: {} as never,
}

const need = (...args: string[]) => githubTool.permission?.({ args }, ctx as never)

// ---------- klasifikasi ----------

test("sub-perintah dibaca dari DUA kata, bukan satu", () => {
  /*
   * `gh pr` saja tidak berarti apa-apa: `pr view` membaca, `pr merge`
   * menggabungkan. Mengelompokkan per kata pertama akan membuat keduanya
   * mendapat izin yang sama.
   */
  assert.equal(subcommandOf(["pr", "list"]), "pr list")
  assert.equal(subcommandOf(["pr", "merge", "42"]), "pr merge")
  assert.equal(subcommandOf(["--repo", "a/b", "issue", "view", "7"]), "issue view")
})

test("membaca memakai sumbu network; mengubah memakai bash", () => {
  /*
   * Ini keseluruhan alasan tool ini ada alih-alih menyuruh model memakai
   * `bash`. Membaca dari GitHub adalah lalu lintas jaringan dan tidak lebih.
   * Yang mengubah sesuatu bertindak atas nama user di luar mesin ini, dan
   * memaksanya ke `network` akan membuat "boleh mengambil halaman web"
   * diam-diam berarti "boleh menutup issue orang".
   */
  assert.equal(need("pr", "list")?.kind, "network")
  assert.equal(need("issue", "view", "7")?.kind, "network")
  assert.equal(need("run", "view", "9")?.kind, "network")

  assert.equal(need("pr", "merge", "42")?.kind, "bash")
  assert.equal(need("issue", "close", "7")?.kind, "bash")
  assert.equal(need("release", "create", "v1")?.kind, "bash")
})

test("yang tidak dikenal dianggap MENGUBAH, bukan membaca", () => {
  /*
   * Arah tebakannya sengaja tidak simetris. Salah menebak ke arah "mengubah"
   * hanya memunculkan dialog; salah menebak ke arah "membaca" menjalankan
   * sesuatu yang tidak diminta siapa pun.
   */
  assert.equal(isReadOnly(["sesuatu", "yang-baru"]), false)
  assert.equal(need("sesuatu", "yang-baru")?.kind, "bash")
  assert.match(need("sesuatu", "yang-baru")?.detail ?? "", /not on the read-only list/)
})

test("pola izin memakai sub-perintahnya, bukan seluruh baris", () => {
  // "selalu izinkan" harus berarti "gh pr list, kapan pun", bukan "gh pr list
  // dengan --limit 10 persis" — yang berikutnya pasti berbeda argumennya.
  assert.equal(need("pr", "list", "--limit", "10")?.pattern, "github(pr list)")
  assert.equal(need("pr", "list")?.pattern, "github(pr list)")
})

test("dialognya menyebut perintah yang akan dijalankan, utuh", () => {
  // Dialog izin yang tidak menunjukkan perintahnya meminta orang menyetujui
  // sesuatu yang tidak mereka lihat.
  assert.match(need("pr", "merge", "42", "--squash")?.detail ?? "", /gh pr merge 42 --squash/)
})

// ---------- yang ditolak ----------

test("perintah yang ditolak dijelaskan alasannya, bukan sekadar ditolak", () => {
  assert.match(refusalFor(["auth", "token"]) ?? "", /token in plain text/)
  assert.match(refusalFor(["repo", "delete", "a/b"]) ?? "", /no undo/)
  assert.equal(refusalFor(["pr", "list"]), undefined)
})

test("gh auth token tidak pernah dijalankan, walau izinnya diberikan", async () => {
  /*
   * Ini bukan soal izin. Keluarannya adalah token GitHub dalam teks polos, dan
   * ia akan masuk ke transkrip, ke penyimpanan sesi, lalu ke jendela konteks
   * model. Satu-satunya cara menjaminnya tidak terjadi adalah tidak pernah
   * menjalankannya.
   */
  await assert.rejects(
    () => githubTool.execute({ args: ["auth", "token"] }, ctx as never),
    (error: unknown) => error instanceof ToolError && /plain text/.test((error as Error).message),
  )
})

// ---------- terhadap gh yang sungguhan ----------

const ghAda = (() => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

test("gh sungguhan menjawab, dan keluarannya sampai apa adanya", { skip: !ghAda }, async () => {
  // Dijalankan terhadap biner gh yang benar-benar terpasang. Kalau tidak ada,
  // test ini DILEWATI dan bukan dipalsukan — stub yang meniru gh hanya
  // membuktikan stub-nya bekerja.
  const hasil = await githubTool.execute({ args: ["--version"] }, ctx as never)
  assert.match(hasil.output, /gh version/)
  assert.match(hasil.title, /^gh --version/)
})

test("kegagalan gh membawa serta keluarannya, bukan cuma kode keluar", { skip: !ghAda }, async () => {
  /*
   * "Command failed with exit code 1" tidak memberi tahu apa pun. Yang berguna
   * ada di stderr gh — dan itu yang dibutuhkan model untuk memutuskan langkah
   * berikutnya alih-alih mencoba hal yang sama lagi.
   */
  await assert.rejects(
    () => githubTool.execute({ args: ["perintah-yang-tidak-ada"] }, ctx as never),
    (error: unknown) => {
      const message = (error as Error).message
      assert.ok(error instanceof ToolError)
      assert.match(message, /gh exited with an error/)
      assert.ok(message.length > 40, `pesannya kosong: ${message}`)
      return true
    },
  )
})
