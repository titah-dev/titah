import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { ModelMessage } from "ai"
import { Config } from "../src/core/schema.ts"
import { skillCommandMessage } from "../src/core/skill.ts"
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

const SKILL = {
  id: "ns:a",
  namespace: "ns",
  name: "a",
  description: "",
  body: "badan",
  file: "/f/SKILL.md",
}

test("skill yang dimuat lewat command terbaca dari penanda pesannya", () => {
  const session = createSession(process.cwd())
  // Bentuk yang benar-benar ditulis agent.ts untuk `/ns:a`: isi skill BESERTA
  // penanda identitas di providerOptions, bukan sekadar teks yang kebetulan
  // memuat tag-nya.
  appendModelMessages(session.id, [skillCommandMessage(SKILL, "kerjakan X")])
  assert.ok(loadedSkillIds(session.id).has("ns:a"))
})

test("teks biasa yang MEMUAT tag skill tidak pernah dianggap memuat skill itu", () => {
  // Ini bug yang membuat seluruh pagar berbahaya, bukan cuma tidak akurat.
  // `docs/.../skills-active-passive-design.md` di repo ini memuat tag itu
  // sebagai contoh; sekali file itu dibaca `read`, `ns:a` dianggap termuat,
  // tool menolak memuatnya, dan model diberi tahu bahwa instruksi yang tidak
  // pernah dikirim itu berlaku — untuk sisa sesi, tanpa jalan pulang. Repo
  // yang bermusuhan bisa mematikan skill tertentu hanya dengan menuliskannya.
  const session = createSession(process.cwd())
  const contoh = 'Contoh blok yang dihasilkan: <skill name="ns:a" source="/x">…</skill>'
  appendModelMessages(session.id, [
    toolResultMessage("call_read", "read", contoh),
    toolResultMessage("call_grep", "grep", contoh),
    { role: "user", content: contoh },
    { role: "assistant", content: contoh },
  ])

  assert.ok(!loadedSkillIds(session.id).has("ns:a"), "hanya pemuatan yang boleh menandai termuat")
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

  // Ringkasannya sendiri MENYEBUT tag itu — persis yang diminta COMPACT_SYSTEM
  // aturan 2 ("salin identifier apa adanya") dan aturan 5, yang menunjukkan tag
  // itu utuh kepada peringkas. Kalau pagar masih membaca teks, `/compact` justru
  // mengunci skill yang isinya baru saja dibuang dari pandangan model.
  saveCompaction(
    session.id,
    1,
    '<context-summary>Skill <skill name="ns:a"> sempat dimuat.</context-summary>',
  )
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
