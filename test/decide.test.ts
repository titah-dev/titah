import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { decide, parseRule, specificity, type Policy } from "../src/core/decide.ts"
import { clearLoopWindow, noteCall } from "../src/core/loop.ts"
import { effectivePermission } from "../src/core/permission.ts"
import { Config } from "../src/core/schema.ts"
import { resolveInside, setExternalRoots, ToolError } from "../src/core/tool/types.ts"

/**
 * Tabel keputusan untuk model izin tiga dimensi.
 *
 * Ini berkas test terpenting dari perubahan itu, dan alasannya tercatat: bug
 * allowlist (#12) terjadi karena logika pencocokan hidup terpisah dari apa yang
 * ia klaim cocokkan, dan gejalanya DIAM. Tiga dimensi berarti tiga kesempatan
 * mengulang kesalahan itu, jadi aturan penggabungannya dipaku baris demi baris
 * alih-alih dipercaya dari komentar.
 */

const rules = (entries: Record<string, Policy>) =>
  Object.entries(entries).map(([source, policy]) => parseRule(source, policy))

const verdict = (
  kind: string,
  classPolicy: Policy,
  entries: Record<string, Policy>,
  values: string[] = [],
) => decide({ kind, classPolicy, rules: rules(entries), candidates: values.map((value) => ({ value })) })

// ---------- penguraian dan spesifisitas ----------

test("aturan diurai jadi sumbu dan pola", () => {
  assert.deepEqual(parseRule("bash(git *)", "allow"), {
    kind: "bash",
    pattern: "git *",
    policy: "allow",
    source: "bash(git *)",
  })
  // Tanpa kurung = setingkat kelas, dan itu sah: `permission.rules` bisa
  // menyatakan hal yang sama dengan blok `permission`, lewat jalur yang sama.
  assert.equal(parseRule("bash", "deny").pattern, undefined)
})

test("spesifisitas dihitung dari karakter yang BUKAN wildcard", () => {
  // "git push " = 9, "git " = 4 — spasinya ikut dihitung, dan itu benar:
  // ia bagian dari yang dicocokkan.
  assert.equal(specificity(parseRule("bash(git push *)", "allow")), 9)
  assert.equal(specificity(parseRule("bash(git *)", "allow")), 4)
  assert.equal(specificity(parseRule("bash", "allow")), 0)
})

// ---------- aturan 1: deny adalah tembok ----------

test("deny setingkat KELAS adalah default deny — aturan allow mempersempitnya", () => {
  /*
   * DIBALIK dari versi pertama, dan sengaja.
   *
   * Versi pertama memperlakukan kelas-deny sebagai tembok juga, dengan alasan
   * "tidak ada apa pun yang keluar dari mesin ini harus tetap jadi jaminan".
   * Alasan itu benar tapi obatnya salah, karena ia merusak dua hal:
   *
   *   - "tolak semuanya KECUALI ini" — pola daftar-putih yang dipakai setiap
   *     firewall — jadi tidak bisa diungkapkan sama sekali.
   *   - setiap aturan allow di bawah kelas yang deny jadi MATI TANPA SUARA,
   *     persis kelas kegagalan #12.
   *
   * Temboknya tetap ada, dan sekarang bentuknya eksplisit — lihat test di bawah.
   */
  const result = verdict("network", "deny", { "network(https://docs.*)": "allow" }, [
    "https://docs.python.org/x",
  ])
  assert.equal(result.policy, "allow")
})

test("tembok mutlak dinyatakan lewat aturan, dan tidak bisa dibuka apa pun", () => {
  const result = verdict(
    "network",
    "ask",
    { "network(*)": "deny", "network(https://docs.*)": "allow" },
    ["https://docs.python.org/x"],
  )
  assert.equal(result.policy, "deny")
})

test("kelas deny tanpa satu pun aturan yang mengizinkan tetap menolak", () => {
  const result = verdict("network", "deny", { "network(https://docs.*)": "allow" }, [
    "https://evil.example/x",
  ])
  assert.equal(result.policy, "deny")
  assert.match(result.reason, /no rule allows it/)
})

test("deny setingkat ARGUMEN menang atas allow setingkat kelas", () => {
  const result = verdict("bash", "allow", { "bash(git push *)": "deny" }, ["git push origin main"])
  assert.equal(result.policy, "deny")
  assert.match(result.reason, /bash\(git push \*\)/)
})

test("deny menang tanpa memandang spesifisitas — pola pendek pun cukup", () => {
  const result = verdict(
    "bash",
    "ask",
    { "bash(curl *)": "deny", "bash(curl https://internal.example/very/long/path*)": "allow" },
    ["curl https://internal.example/very/long/path/x"],
  )
  assert.equal(result.policy, "deny", "yang lebih spesifik TIDAK boleh membuka deny")
})

// ---------- aturan 2: yang paling spesifik menang di antara ask dan allow ----------

test("allow yang lebih spesifik mengalahkan ask setingkat kelas", () => {
  // Tanpa ini, dimensi argumen tidak berguna sama sekali.
  const result = verdict("bash", "ask", { "bash(git *)": "allow" }, ["git status"])
  assert.equal(result.policy, "allow")
})

test("ask yang lebih spesifik mengalahkan allow yang lebih umum", () => {
  const result = verdict("bash", "allow", { "bash(*)": "allow", "bash(npm publish *)": "ask" }, [
    "npm publish --tag next",
  ])
  assert.equal(result.policy, "ask")
})

test("seri spesifisitas dimenangkan ask, bukan allow", () => {
  // Dua aturan yang sama spesifiknya dan bertentangan adalah config AMBIGU,
  // dan menebak ke arah longgar pada yang ambigu adalah cara membuat izin yang
  // tidak pernah user maksud.
  //
  // Keduanya di bawah berspesifisitas 4 dan sama-sama cocok dengan "npm test":
  // "npm *" → "npm " (4), "*test" → "test" (4).
  const allow = parseRule("bash(npm *)", "allow")
  const ask = parseRule("bash(*test)", "ask")
  assert.equal(specificity(allow), specificity(ask), "prasyarat: keduanya memang seri")

  const result = decide({
    kind: "bash",
    classPolicy: "ask",
    rules: [allow, ask],
    candidates: [{ value: "npm test" }],
  })
  assert.equal(result.policy, "ask")
})

test("tanpa aturan yang cocok, kebijakan kelas yang berlaku", () => {
  const result = verdict("bash", "ask", { "bash(git *)": "allow" }, ["rm -rf /"])
  assert.equal(result.policy, "ask")
  assert.match(result.reason, /no rule matched/)
})

// ---------- bash: setiap segmen harus lolos ----------

test("satu segmen tanpa izin membuat SELURUH perintah ditanyakan", () => {
  const result = verdict("bash", "ask", { "bash(git *)": "allow" }, ["git status", "rm -rf ~"])
  assert.equal(result.policy, "ask")
  assert.match(result.reason, /one part of the command decides the whole/)
})

test("semua segmen berizin berarti seluruhnya lolos", () => {
  const result = verdict("bash", "ask", { "bash(git *)": "allow", "bash(ls*)": "allow" }, [
    "git status",
    "ls -la",
  ])
  assert.equal(result.policy, "allow")
})

test("satu segmen yang DITOLAK menolak seluruh perintah", () => {
  const result = verdict("bash", "allow", { "bash(curl *)": "deny" }, ["ls", "curl evil.example"])
  assert.equal(result.policy, "deny")
})

test("daftar segmen KOSONG tidak pernah lolos sebagai kebenaran hampa", () => {
  // `[].every(...)` bernilai true. Aturan yang sama dengan #12, sekarang di
  // dalam decide() alih-alih di pemanggilnya.
  const result = verdict("bash", "ask", { "bash(*)": "allow" }, [])
  assert.notEqual(result.policy, "allow")
})

// ---------- sumbu non-bash memakai subject ----------

test("network dinilai per URL", () => {
  const entries = { "network(https://docs.*)": "allow" } as Record<string, Policy>
  assert.equal(verdict("network", "ask", entries, ["https://docs.rs/x"]).policy, "allow")
  assert.equal(verdict("network", "ask", entries, ["https://evil.example/x"]).policy, "ask")
})

test("delete bisa dibuka hanya untuk satu pohon direktori", () => {
  const entries = { "delete(build/*)": "allow" } as Record<string, Policy>
  assert.equal(verdict("delete", "ask", entries, ["build/out.js"]).policy, "allow")
  assert.equal(verdict("delete", "ask", entries, ["src/main.ts"]).policy, "ask")
})

test("mcp bisa dibuka per server", () => {
  const entries = { "mcp(github/*)": "allow" } as Record<string, Policy>
  assert.equal(verdict("mcp", "ask", entries, ["github/create_issue"]).policy, "allow")
  assert.equal(verdict("mcp", "ask", entries, ["payments/charge"]).policy, "ask")
})

// ---------- alsoMatched, untuk explain ----------

test("aturan yang ikut cocok tapi kalah tetap dilaporkan", () => {
  // Ini yang membuat `permission explain` bisa menjawab "kenapa", bukan cuma
  // "apa" — dan tanpa itu, presisi yang tidak bisa diaudit hanyalah rasa aman.
  const result = verdict("bash", "ask", { "bash(git *)": "allow", "bash(git push *)": "ask" }, [
    "git push origin main",
  ])
  assert.equal(result.policy, "ask")
  assert.deepEqual(
    result.alsoMatched.map((rule) => rule.source),
    ["bash(git *)"],
  )
})

// ---------- effectivePermission menggabung aturan ----------

test("aturan agent DITAMBAHKAN, tidak menggantikan aturan global", () => {
  // Menggantinya berarti agent yang menambah satu aturan diam-diam membuang
  // seluruh kebijakan argumen milik user.
  const config = Config.parse({
    permission: { rules: { "bash(git *)": "allow" } },
    agent: { riset: { permission: { rules: { "network(https://*)": "allow" } } } },
  })
  const effective = effectivePermission(config, "riset", config.agent["riset"])
  assert.deepEqual(
    effective.rules.map((rule) => rule.source).sort(),
    ["bash(git *)", "network(https://*)"],
  )
})

// ---------- dimensi situasi: deteksi perulangan ----------

test("panggilan identik ketiga dianggap berputar, yang kedua tidak", () => {
  // Dua panggilan identik itu biasa dan sah: baca, sunting, baca lagi untuk
  // memastikan. Yang ketiga sudah pola.
  clearLoopWindow("ses_loop")
  assert.equal(noteCall("ses_loop", "bash", { command: "npm test" }), false)
  assert.equal(noteCall("ses_loop", "bash", { command: "npm test" }), false)
  assert.equal(noteCall("ses_loop", "bash", { command: "npm test" }), true)
})

test("panggilan yang berbeda tidak pernah dianggap berputar", () => {
  clearLoopWindow("ses_loop2")
  for (let i = 0; i < 8; i += 1) {
    assert.equal(noteCall("ses_loop2", "read", { path: `a${i}.ts` }), false)
  }
})

test("jendela perulangan dibersihkan per giliran", () => {
  clearLoopWindow("ses_loop3")
  noteCall("ses_loop3", "bash", { command: "x" })
  noteCall("ses_loop3", "bash", { command: "x" })
  clearLoopWindow("ses_loop3")
  assert.equal(noteCall("ses_loop3", "bash", { command: "x" }), false, "hitungannya harus mulai lagi")
})

// ---------- external_directory ----------

test("tanpa akar tambahan, batas cwd persis seperti sebelumnya", () => {
  setExternalRoots([])
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "titah-perm-"))
  assert.throws(() => resolveInside(cwd, "../keluar.txt"), ToolError)
  assert.doesNotThrow(() => resolveInside(cwd, "di-dalam.txt"))
})

test("akar yang DISEBUT membuka path itu saja, bukan segalanya", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "titah-perm-a-"))
  const lain = fs.mkdtempSync(path.join(os.tmpdir(), "titah-perm-b-"))
  const asing = fs.mkdtempSync(path.join(os.tmpdir(), "titah-perm-c-"))

  setExternalRoots([`${lain}/*`])
  assert.doesNotThrow(() => resolveInside(cwd, path.join(lain, "berkas.ts")))
  assert.throws(() => resolveInside(cwd, path.join(asing, "berkas.ts")), ToolError)
  setExternalRoots([])
})

test("pesan penolakan menunjukkan jalan keluarnya", () => {
  setExternalRoots([])
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "titah-perm-d-"))
  assert.throws(() => resolveInside(cwd, "../x"), /external_directory/)
})
