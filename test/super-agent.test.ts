import assert from "node:assert/strict"
import test from "node:test"
import { Agent, Config, EXAMPLE_EXTERNAL_AGENTS } from "../src/core/schema.ts"
import { teamAgents, teamSkipped } from "../src/core/subagent.ts"
import { buildSystemPrompt } from "../src/core/prompt.ts"

/**
 * Super agent: CLI agent lain yang didaftarkan user, dibagi tugas oleh `/tim`
 * dan bisa dimintai bantuan agent internal lewat `escalate`.
 */

const config = (extra: Record<string, unknown> = {}) =>
  Config.parse({ skills: { discover: [], paths: [] }, ...extra })

const TIGA = {
  claude: { command: "claude", specialist: "arsitektur dan refactor lintas modul" },
  antigravity: { command: "antigravity", specialist: "test dan verifikasi" },
  bisu: { command: "kiro" },
}

// ---------- roster /tim ----------

test("hanya super agent BERSPESIALIS yang ikut /tim", () => {
  /*
   * `/tim` membagi tugas berdasarkan spesialis. Memasukkan yang tidak punya
   * berarti membaginya berdasarkan nama, dan nama tidak memberi tahu apa pun
   * tentang siapa yang paling cocok mengerjakan apa.
   */
  const parsed = config({ externalAgent: TIGA })
  assert.deepEqual(teamAgents(parsed).sort(), ["antigravity", "claude"])
})

test("yang dilewati DISEBUTKAN, beserta sebabnya", () => {
  // Super agent yang terdaftar tapi diam-diam tidak dipakai adalah kegagalan
  // paling membingungkan: namanya ada di config, kerjanya tidak terlihat, dan
  // tidak ada apa pun yang menjelaskan kenapa.
  const skipped = teamSkipped(config({ externalAgent: TIGA }))
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]?.id, "bisu")
  assert.match(skipped[0]?.why ?? "", /specialist/)
})

test("yang dimatikan tidak muncul di kedua daftar", () => {
  const parsed = config({
    externalAgent: { mati: { command: "x", specialist: "apa saja", enabled: false } },
  })
  assert.deepEqual(teamAgents(parsed), [])
  assert.deepEqual(teamSkipped(parsed), [], "yang dimatikan bukan 'dilewati' — ia memang tidak ada")
})

// ---------- registry murni milik user ----------

test("contoh bawaan tetap ada sebagai contoh, dengan spesialisnya", () => {
  // Tidak lagi disuntik ke config siapa pun, tapi argumennya diverifikasi
  // terhadap biner sungguhan dan `titah doctor` menawarkannya apa adanya.
  for (const id of ["claude", "opencode"] as const) {
    const preset = EXAMPLE_EXTERNAL_AGENTS[id]
    assert.ok(preset, `${id} hilang dari contoh`)
    assert.ok((preset.specialist ?? "").length > 10, `${id} butuh spesialis yang berarti`)
  }
})

// ---------- escalate ----------

test("escalate menempel ke prompt agent itu, lengkap dengan kriterianya", () => {
  /*
   * `when` TIDAK diurai Titah. Satu-satunya yang bisa menilai "butuh pemahaman
   * arsitektur dulu" adalah yang sedang mengerjakan pekerjaannya.
   */
  const parsed = config({
    externalAgent: TIGA,
    agent: {
      senior: {
        mode: "all",
        escalate: { to: "claude", when: "perubahan lintas modul" },
      },
    },
  })

  const built = buildSystemPrompt(parsed, process.cwd(), "senior")
  assert.match(built.system, /Escalating to "claude"/)
  assert.match(built.system, /perubahan lintas modul/)
  assert.match(built.system, /arsitektur dan refactor lintas modul/, "spesialis tujuannya ikut")
  assert.match(built.system, /cannot see this conversation/, "briefnya harus mandiri")
})

test("agent tanpa escalate tidak mendapat bagian itu sama sekali", () => {
  const parsed = config({ externalAgent: TIGA, agent: { polos: { mode: "all" } } })
  assert.doesNotMatch(buildSystemPrompt(parsed, process.cwd(), "polos").system, /Escalating to/)
})

test("delegate dan escalate bersamaan ditolak", () => {
  /*
   * `delegate` sudah menyerahkan SETIAP giliran ke CLI eksternal, jadi tidak
   * ada sisa loop Titah di dalamnya yang bisa memutuskan kapan mengeskalasi.
   */
  const hasil = Agent.safeParse({
    delegate: "claude",
    escalate: { to: "antigravity", when: "kapan saja" },
  })
  assert.equal(hasil.success, false)
  assert.match(JSON.stringify(hasil.error?.issues), /nothing left to escalate/)
})

test("escalate tanpa `when` ditolak — kriteria kosong bukan kriteria", () => {
  assert.equal(Agent.safeParse({ escalate: { to: "claude", when: "" } }).success, false)
})
