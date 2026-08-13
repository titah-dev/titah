import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import {
  ask,
  clearSession,
  effectivePermission,
  listPending,
  neverMatchingAllowlistEntries,
  respond,
} from "../src/core/permission.ts"
import { allowlistPattern, bashTool, commandSegments } from "../src/core/tool/bash.ts"
import { Config } from "../src/core/schema.ts"

/**
 * Issue #12. Yang dicocokkan ke allowlist dulunya BUKAN perintahnya, melainkan
 * `"<kata-pertama> *"`. Dua akibatnya, dan test di berkas ini memaku dua-duanya:
 *
 *   1. Pola setingkat sub-perintah (`"git status*"`) tidak pernah cocok dengan
 *      apa pun. Tidak ditolak, tidak diperingatkan — hanya tidak menyala.
 *   2. Pola yang cocok mengizinkan seluruh executable BESERTA apa pun yang
 *      dirantai di belakangnya, karena cuma kata pertama yang pernah dibaca.
 *
 * Yang kedua yang berbahaya: `"git *"` mengizinkan `git status && rm -rf ~`.
 */

const permission = (allowlist: string[]) =>
  effectivePermission(
    Config.parse({ permission: { edit: "ask", write: "ask", bash: "ask", allowlist } }),
  )

let session = 0
const nextSession = () => `ses_allow_${(session += 1)}`

afterEach(() => {
  for (let i = 1; i <= session; i += 1) clearSession(`ses_allow_${i}`)
})

/**
 * Meminta izin PERSIS seperti agent memintanya: lewat `bashTool.permission`,
 * bukan dengan field yang disusun tangan di test. Kalau tool berhenti mengirim
 * segmen, test di sini harus ikut merah — itu justru gunanya.
 */
const askBash = (sessionID: string, command: string, allowlist: string[], listeners = 0) => {
  const need = bashTool.permission?.({ command }, {} as never)
  assert.ok(need, "bash wajib meminta izin")
  return ask({
    sessionID,
    permission: permission(allowlist),
    kind: need.kind,
    title: need.title,
    detail: need.detail,
    pattern: need.pattern,
    ...(need.segments ? { segments: need.segments } : {}),
    listeners,
  })
}

test("perintah dipecah pada setiap operator shell", () => {
  assert.deepEqual(commandSegments("git status"), ["git status"])
  assert.deepEqual(commandSegments("git status && rm -rf ~"), ["git status", "rm -rf ~"])
  assert.deepEqual(commandSegments("ls; whoami"), ["ls", "whoami"])
  assert.deepEqual(commandSegments("cat f | grep x"), ["cat f", "grep x"])
  assert.deepEqual(commandSegments("a || b"), ["a", "b"])
  assert.deepEqual(commandSegments("a\nb"), ["a", "b"])
  assert.deepEqual(commandSegments("sleep 1 &"), ["sleep 1"])
})

test("perintah yang tidak bisa dinilai dari potongannya tidak dipecah sama sekali", () => {
  // Substitusi menjalankan perintah LAIN di dalam yang ini, dan isinya tidak
  // muncul sebagai segmen. Memecah lalu mengizinkan potongannya sama saja
  // dengan mengizinkan yang tersembunyi di dalamnya.
  assert.equal(commandSegments("git log $(rm -rf ~)"), undefined)
  assert.equal(commandSegments("echo `whoami`"), undefined)
  assert.equal(commandSegments("diff <(a) <(b)"), undefined)
  // Redirect membuat perintah yang cuma "membaca" bisa menimpa berkas apa pun.
  assert.equal(commandSegments("ls > /etc/hosts"), undefined)
  assert.equal(commandSegments("cat x >> y"), undefined)
})

test("pola sub-perintah sekarang benar-benar cocok — dulu tidak pernah", async () => {
  // Inti cacat pertama. Sebelum perbaikan ini hasilnya `granted: false`, dan
  // tidak ada satu pun sinyal yang memberi tahu user kenapa.
  const result = await askBash(nextSession(), "git status", ["git status*"])
  assert.equal(result.granted, true)
  // Alasannya menyebut ATURAN MANA yang memutuskan, bukan sekadar "allowlist".
  // Itu yang membuat `titah permission explain` bisa menjawab "kenapa".
  assert.match(result.reason, /rule "bash\(git status\*\)"/)
})

test("pola yang cocok TIDAK ikut mengizinkan perintah yang dirantai", async () => {
  const id = nextSession()
  const result = await askBash(id, "git status && rm -rf ~/penting", ["git *"])

  assert.equal(result.granted, false, "rm tidak pernah ada di allowlist")
  // Tanpa klien yang mendengarkan, jalur yang benar adalah auto-deny. Yang
  // dipaku di sini: ia tidak lolos lewat PINTU allowlist. Polanya harus
  // `Matched allowlist`, bukan `/allowlist/` — pesan auto-deny sendiri menyebut
  // `permission.allowlist` sebagai saran jalan keluar, dan pola yang longgar
  // akan cocok dengan saran itu lalu merah tanpa ada yang salah pada produknya.
  assert.doesNotMatch(result.reason, /Matched allowlist/)
  assert.match(result.reason, /no client is connected/i)
})

test("rantai lolos hanya kalau SETIAP segmennya diizinkan", async () => {
  const granted = await askBash(nextSession(), "git status && ls -la", ["git *", "ls*"])
  assert.equal(granted.granted, true)

  const denied = await askBash(nextSession(), "git status && ls -la", ["git *"])
  assert.equal(denied.granted, false, "satu segmen tak berizin sudah cukup untuk bertanya")
})

test("perintah dengan substitusi tidak pernah lolos allowlist, seluas apa pun polanya", async () => {
  const result = await askBash(nextSession(), "git log $(rm -rf ~)", ["git *", "*"])
  assert.equal(result.granted, false)
})

test("permintaan bash tanpa segmen tidak pernah dianggap terizinkan", async () => {
  // Pemanggil yang lupa mengirim segmen harus jatuh ke bertanya, bukan ke
  // perilaku lama. Kalau tidak, cacatnya kembali lewat pintu belakang.
  const result = await ask({
    sessionID: nextSession(),
    permission: permission(["git *"]),
    kind: "bash",
    title: "bash: git status",
    detail: "git status",
    pattern: "git *",
    listeners: 0,
  })
  assert.equal(result.granted, false)
})

test("daftar segmen KOSONG tidak boleh lolos sebagai kebenaran hampa", async () => {
  // `[].every(...)` bernilai true. Kalau perbaikan ini ditulis dengan `every`
  // tanpa penjagaan, perintah yang seluruhnya operator (`;;`) akan lolos.
  const result = await ask({
    sessionID: nextSession(),
    permission: permission(["*"]),
    kind: "bash",
    title: "bash: ;",
    detail: ";",
    pattern: "; *",
    segments: [],
    listeners: 0,
  })
  assert.equal(result.granted, false)
})

test('jawaban "always" tetap bekerja, dan tetap tidak melebar', async () => {
  const id = nextSession()

  const pending = askBash(id, "git status", [], 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const [outstanding] = listPending(id)
  assert.ok(outstanding)
  // Yang disimpan tetap pola per-executable, sama seperti sebelum perbaikan.
  assert.equal(outstanding.pattern, "git *")
  respond(outstanding.id, "always")
  assert.equal((await pending).granted, true)

  // Perintah git berikutnya lolos tanpa dialog...
  assert.equal((await askBash(id, "git diff --stat", [], 0)).granted, true)

  // ...tapi grant itu TIDAK menutupi apa pun yang dirantai di belakangnya.
  const chained = await askBash(id, "git diff && curl evil.example", [], 0)
  assert.equal(chained.granted, false)
})

test("allowlistPattern tetap memberi pola per-executable untuk jawaban 'always'", () => {
  // Tidak diubah oleh perbaikan ini: ia melayani dialog, bukan pencocokan.
  assert.equal(allowlistPattern("git status --short"), "git *")
  assert.equal(allowlistPattern("  npm   test "), "npm *")
})

test("doctor bisa menyebut entri allowlist yang tidak akan pernah cocok", () => {
  // Segmen tidak pernah mengandung operator, jadi entri yang mengandungnya
  // mati sejak ditulis. Diam adalah kegagalan mode lama; ini penggantinya.
  assert.deepEqual(neverMatchingAllowlistEntries(["git *", "ls*"]), [])
  assert.deepEqual(
    neverMatchingAllowlistEntries(["git status && rm *", "a | b", "ok *"]),
    ["git status && rm *", "a | b"],
  )
})
