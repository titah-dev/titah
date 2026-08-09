import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { ModelMessage } from "ai"
import { Config } from "../src/core/schema.ts"
import { skillTool } from "../src/core/tool/index.ts"

process.env["TITAH_DB"] = ":memory:"

const { appendModelMessages, createSession, saveCompaction } = await import(
  "../src/core/storage/session.ts"
)
const { loadedSkillIds } = await import("../src/core/tool/skill.ts")

function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-tool-skill-"))
  for (const [relative, content] of Object.entries(spec)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

/**
 * Bentuk pesan SUNGGUHAN yang AI SDK simpan untuk hasil tool call — array
 * bagian `tool-result`, bukan string polos. `appendModelMessages(session.id,
 * [{ role: "user", content: "..." }])` yang dipakai versi sebelumnya dari test
 * ini tidak pernah terjadi di produksi untuk hasil tool; itulah sebabnya bug
 * stringify-lalu-regex lolos dari test itu.
 */
function toolResultMessage(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }],
  }
}

test("skill yang dimuat lewat command (pesan user string polos) terbaca dari riwayat", () => {
  const session = createSession(process.cwd())
  appendModelMessages(session.id, [
    { role: "user", content: '<skill name="ns:a" source="/f">badan</skill>' },
  ])
  assert.ok(loadedSkillIds(session.id).has("ns:a"))
})

test("skill yang dimuat lewat panggilan tool (bentuk tool-result asli) terbaca dari riwayat", () => {
  // Ini bentuk yang sungguhan dipakai AI SDK, BUKAN pesan user string polos.
  // Kalau ekstraksinya kembali meregex `JSON.stringify(content)`, setiap `"`
  // di dalam `value` sudah ter-escape jadi `\"` dan regex `name="` tidak akan
  // pernah cocok dengan `name=\"` — skill dianggap belum pernah dimuat.
  const session = createSession(process.cwd())
  appendModelMessages(session.id, [
    toolResultMessage("call_1", "skill", '<skill name="ns:a" source="/f">badan</skill>'),
  ])
  assert.ok(loadedSkillIds(session.id).has("ns:a"))
})

test("SETELAH /compact skill boleh dimuat ulang", () => {
  // Ini bug yang paling mudah luput. Kalau daftar "sudah dimuat" dihitung dari
  // baris MENTAH, skill yang isinya sudah lenyap dari pandangan model tetap
  // dianggap termuat — dan model kehilangan skill itu selamanya tanpa tahu kenapa.
  const session = createSession(process.cwd())
  appendModelMessages(session.id, [
    toolResultMessage("call_1", "skill", '<skill name="ns:a" source="/f">badan</skill>'),
    { role: "assistant", content: "oke" },
    { role: "user", content: "lanjut" },
    { role: "assistant", content: "siap" },
  ])
  assert.ok(loadedSkillIds(session.id).has("ns:a"), "sebelum dipadatkan: termuat")

  saveCompaction(session.id, 1, "<context-summary>ringkasan</context-summary>")
  assert.ok(!loadedSkillIds(session.id).has("ns:a"), "sesudah dipadatkan: boleh dimuat lagi")
})

test("memuat skill dua kali mengembalikan catatan, bukan isinya lagi", async () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nBADAN PANJANG" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  const session = createSession(root)
  const ctx = {
    cwd: root,
    sessionID: session.id,
    callID: "c1",
    signal: new AbortController().signal,
    config,
  }

  const first = await skillTool.execute({ name: "ns:a" }, ctx)
  assert.match(first.output, /BADAN PANJANG/)

  // Bentuk yang benar-benar disimpan agent.ts untuk hasil tool: pesan "tool"
  // berisi array `tool-result`, bukan pesan "user" berisi string.
  appendModelMessages(session.id, [toolResultMessage(ctx.callID, "skill", first.output)])

  const second = await skillTool.execute({ name: "ns:a" }, ctx)
  assert.doesNotMatch(second.output, /BADAN PANJANG/)
  assert.match(second.output, /already loaded/i)
})

test("skill tool tidak memotong sendiri — itu tugas lapisan storeOutput", async () => {
  // Dulu ada batas 64 KB di sini yang tidak pernah tercapai di produksi karena
  // storeOutput sudah memotong lebih dulu pada 32 KB dengan pemberitahuannya
  // sendiri. Dua batas dengan angka dan kata berbeda berarti flag yang salah
  // satunya pasti bohong. Sekarang tool ini selalu mengembalikan badan penuh.
  const root = tree({ "skills/besar/SKILL.md": `---\nname: besar\n---\n${"x".repeat(70 * 1024)}` })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  const session = createSession(root)
  const ctx = {
    cwd: root,
    sessionID: session.id,
    callID: "c",
    signal: new AbortController().signal,
    config,
  }

  const result = await skillTool.execute({ name: "ns:besar" }, ctx)
  assert.doesNotMatch(result.output, /truncated/)
  assert.equal(result.metadata?.["truncated"], undefined)
  assert.ok(result.output.length > 70 * 1024, "badan penuh, tanpa dipotong di lapisan tool")
})

test("memuat skill TIDAK pernah meminta izin", () => {
  // Ia membaca file dari path yang user sendiri daftarkan dan menaruhnya di
  // konteks — setara system prompt. Dialog di sini hanya melatih orang menekan
  // "y" tanpa membaca, dan itu melemahkan dialog izin yang benar-benar penting.
  assert.equal(skillTool.permission, undefined)
  assert.notEqual(skillTool.mutates, true)
})

test("nama tak dikenal menyebut kandidat di namespace yang sama", async () => {
  const root = tree({ "skills/ada/SKILL.md": "---\nname: ada\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  const session = createSession(root)
  const ctx = {
    cwd: root,
    sessionID: session.id,
    callID: "c",
    signal: new AbortController().signal,
    config,
  }

  const result = await skillTool.execute({ name: "ns:tidakada" }, ctx)
  assert.match(result.output, /ns:ada/)
})
