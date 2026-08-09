import assert from "node:assert/strict"
import { deriveNamespace, scanSource } from "../src/core/skill.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-skill-"))
  for (const [relative, content] of Object.entries(spec)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

test("namespace diambil dari manifes plugin kalau ada", () => {
  const root = tree({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "superpowers" }),
    "skills/a/SKILL.md": "---\nname: a\n---\nisi",
  })
  assert.equal(deriveNamespace(path.join(root, "skills")), "superpowers")
})

test('folder bernama "skills" naik satu tingkat ke induknya', () => {
  // ~/.config/opencode/skills -> "opencode", bukan "skills".
  const root = tree({ "opencode/skills/a/SKILL.md": "---\nname: a\n---\nisi" })
  assert.equal(deriveNamespace(path.join(root, "opencode", "skills")), "opencode")
})

test("folder dengan nama sendiri dipakai apa adanya", () => {
  const root = tree({ "punyaku/a/SKILL.md": "---\nname: a\n---\nisi" })
  assert.equal(deriveNamespace(path.join(root, "punyaku")), "punyaku")
})

test("pemindaian rekursif menemukan skill yang bersarang dua tingkat", () => {
  // mattpocock menaruh skill di skills/productivity/<nama>/SKILL.md; pemindai
  // satu tingkat menemukan NOL dari 35 skill-nya.
  const root = tree({
    "skills/productivity/grill-me/SKILL.md": "---\nname: grill-me\ndescription: menggali\n---\nbadan",
    "skills/atas/SKILL.md": "---\nname: atas\n---\nbadan",
  })
  const found = scanSource({ root: path.join(root, "skills"), namespace: "mp" })

  assert.deepEqual(
    found.map((skill) => skill.id).sort(),
    ["mp:atas", "mp:grill-me"],
  )
  assert.equal(found.find((skill) => skill.name === "grill-me")?.description, "menggali")
})

test("nama diambil dari frontmatter, jatuh ke nama folder kalau kosong", () => {
  const root = tree({ "skills/tanpa-nama/SKILL.md": "tidak ada frontmatter" })
  const [skill] = scanSource({ root: path.join(root, "skills"), namespace: "ns" })
  assert.equal(skill?.name, "tanpa-nama")
  assert.equal(skill?.description, "")
})

test("tata letak satu file per skill tetap didukung", () => {
  const root = tree({ "skills/ringkas.md": "---\nname: ringkas\n---\nbadan" })
  const [skill] = scanSource({ root: path.join(root, "skills"), namespace: "ns" })
  assert.equal(skill?.id, "ns:ringkas")
})
