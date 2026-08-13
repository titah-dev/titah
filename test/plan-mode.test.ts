import assert from "node:assert/strict"
import test from "node:test"
import { decide, parseRule, type Policy } from "../src/core/decide.ts"
import { effectivePermission } from "../src/core/permission.ts"
import { Agent, Config, DEFAULT_AGENTS } from "../src/core/schema.ts"
import { commandSegments } from "../src/core/tool/bash.ts"
import { BUILD_MODES, exitPlanTool, setPlanExiter } from "../src/core/tool/exit-plan.ts"
import { allTools } from "../src/core/tool/index.ts"

/**
 * Mode Plan: bisa MEMBACA sungguhan, tidak bisa mengubah apa pun, dan
 * menawarkan jalan keluar alih-alih gagal diam-diam.
 */

const planPermission = () =>
  effectivePermission(Config.parse({}), "plan", Agent.parse(DEFAULT_AGENTS["plan"]))

/** Menilai satu perintah bash persis seperti `ask()` menilainya. */
const judgeBash = (command: string): Policy => {
  const permission = planPermission()
  return decide({
    kind: "bash",
    classPolicy: permission.bash,
    rules: permission.rules,
    candidates: (commandSegments(command) ?? []).map((value) => ({ value })),
  }).policy
}

const judge = (kind: "edit" | "write" | "delete" | "mcp" | "network", subject?: string): Policy => {
  const permission = planPermission()
  return decide({
    kind,
    classPolicy: permission[kind],
    rules: permission.rules,
    candidates: subject === undefined ? [] : [{ value: subject }],
  }).policy
}

// ---------- membaca ----------

test("tool baca tidak pernah meminta izin, jadi mode Plan bisa menganalisa", () => {
  // Ini yang membuat "analisa project ini" bekerja di mode Plan tanpa satu pun
  // dialog: read/list/glob/grep memang tidak punya `permission` sama sekali.
  const free = allTools()
    .filter((tool) => tool.permission === undefined)
    .map((tool) => tool.name)
  for (const name of ["read", "list", "glob", "grep"]) {
    assert.ok(free.includes(name), `${name} harus bebas izin`)
  }
})

test("shell TERBUKA di mode Plan — termasuk alat yang tidak akan terpikir didaftar", () => {
  /*
   * Versi sebelumnya memakai daftar putih perintah baca, dan itu benar secara
   * keamanan tapi salah secara kegunaan: `npm run typecheck`, `find`, dan `jq`
   * ikut tertolak, jadi mode Plan tidak bisa menganalisa dengan alat yang
   * benar-benar dipakai orang.
   *
   * Daftar putih untuk perintah shell harus memperkirakan setiap alat yang
   * berguna — daftar yang tidak akan pernah selesai.
   */
  for (const command of [
    "git log --oneline -20",
    "npm run typecheck",
    "find . -name '*.ts'",
    "jq '.version' package.json",
    "wc -l src/core/agent.ts",
  ]) {
    assert.equal(judgeBash(command), "allow", command)
  }
})

test("shell yang terbuka berarti mode Plan TIDAK lagi menjamin nol perubahan", () => {
  // Dipaku sebagai kenyataan, bukan disembunyikan. Yang dijamin sekarang hanya
  // bahwa TOOL berkas menolak; sisanya bersandar pada prompt.
  assert.equal(judgeBash("rm -rf build"), "allow")
  assert.equal(judgeBash("sed -i s/a/b/ f"), "allow")
})

// ---------- tidak mengubah ----------

test("edit, write, delete, dan mcp ditolak keras — tanpa aturan yang membukanya", () => {
  assert.equal(judge("edit", "src/a.ts"), "deny")
  assert.equal(judge("write", "src/a.ts"), "deny")
  assert.equal(judge("delete", "src/a.ts"), "deny")
  assert.equal(judge("mcp", "github/create_issue"), "deny")
})

test("network TIDAK ditolak: membaca dokumentasi adalah pekerjaan mode ini", () => {
  assert.notEqual(judge("network", "https://docs.python.org/3/"), "deny")
})

// ---------- deny kelas sekarang bisa dipersempit ----------

test("deny setingkat KELAS adalah default deny — aturan allow bisa mempersempitnya", () => {
  // Perubahan sadar dari desain kemarin. Tanpa ini, "tolak semuanya KECUALI
  // ini" tidak bisa diungkapkan, dan setiap aturan allow di bawah kelas yang
  // deny mati TANPA SUARA — persis kelas kegagalan #12.
  const result = decide({
    kind: "bash",
    classPolicy: "deny",
    rules: [parseRule("bash(git log*)", "allow")],
    candidates: [{ value: "git log" }],
  })
  assert.equal(result.policy, "allow")
})

test("tembok mutlak tetap bisa dinyatakan, dan bentuknya eksplisit", () => {
  // `deny` setingkat ATURAN tidak bisa dibuka apa pun.
  const result = decide({
    kind: "network",
    classPolicy: "ask",
    rules: [parseRule("network(*)", "deny"), parseRule("network(https://docs.*)", "allow")],
    candidates: [{ value: "https://docs.python.org" }],
  })
  assert.equal(result.policy, "deny")
})

test("kelas deny tanpa aturan yang mengizinkan tetap menolak", () => {
  const result = decide({
    kind: "bash",
    classPolicy: "deny",
    rules: [parseRule("bash(git log*)", "allow")],
    candidates: [{ value: "rm -rf ~" }],
  })
  assert.equal(result.policy, "deny")
  assert.match(result.reason, /no rule allows it/)
})

// ---------- exit_plan ----------

test("exit_plan menawarkan mode yang benar-benar bisa mengubah", () => {
  assert.deepEqual([...BUILD_MODES], ["build", "build-auto"])
})

test("memilih sebuah mode dilaporkan ke model, beserta kapan ia berlaku", async () => {
  setPlanExiter(async () => "build-auto")
  const result = await exitPlanTool.execute({ plan: "ubah a.ts" }, { sessionID: "s" } as never)

  assert.equal((result.metadata as { switched: boolean }).switched, true)
  // Kapan berlakunya PENTING: mode dipilih di tengah giliran, dan giliran ini
  // sudah berjalan dengan izin yang lama. Model yang mengira ia sudah boleh
  // menyunting akan mencoba lalu ditolak.
  assert.match(result.output, /NEXT message, not this turn/)
})

test("memilih tetap di Plan bukan kegagalan, dan modelnya diberi tahu harus apa", async () => {
  setPlanExiter(async () => undefined)
  const result = await exitPlanTool.execute({ plan: "ubah a.ts" }, { sessionID: "s" } as never)

  assert.equal((result.metadata as { switched: boolean }).switched, false)
  assert.match(result.output, /Do not attempt the change/)
  assert.match(result.output, /numbered steps/)
})

test("jawaban yang bukan nama mode diperlakukan sebagai tetap di Plan", async () => {
  // User mengetik teks bebas alih-alih memilih. Menerjemahkannya jadi
  // perpindahan mode akan memindahkan mode berdasarkan tebakan.
  setPlanExiter(async () => "mungkin nanti")
  const result = await exitPlanTool.execute({ plan: "x" }, { sessionID: "s" } as never)
  assert.equal((result.metadata as { switched: boolean }).switched, false)
})

test("exit_plan tidak memakai sumbu izin — ia tidak mengubah apa pun sendiri", () => {
  assert.equal(exitPlanTool.permission, undefined)
})

test("deskripsi dan prompt tidak menjanjikan lebih dari yang ditegakkan", () => {
  const plan = DEFAULT_AGENTS["plan"] as { description: string; prompt: string }

  // Deskripsi lama berbunyi "nothing is changed". Dengan shell terbuka itu
  // tidak lagi ditegakkan Titah, jadi ia tidak boleh dijanjikan.
  assert.doesNotMatch(plan.description, /nothing is changed/)
  assert.match(plan.description, /no file edits/)

  // Prompt HARUS menyebut batas yang sesungguhnya: tool berkas ditolak, shell
  // tidak — dan itu kepercayaan, bukan penjagaan.
  assert.match(plan.prompt, /shell is NOT refused/)
  assert.match(plan.prompt, /would change the repository, do not run it/)
  assert.match(plan.prompt, /exit_plan/)
})
