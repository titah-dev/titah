import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildSystemPrompt } from "../src/core/prompt.ts"
import { Config } from "../src/core/schema.ts"

function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-prompt-"))
  for (const [relative, content] of Object.entries(spec)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

test("skill di always dimuat UTUH, sisanya hanya satu baris katalog", () => {
  const root = tree({
    "skills/besar/SKILL.md": "---\nname: besar\ndescription: ringkas\n---\nBADAN LENGKAP BESAR",
    "skills/kecil/SKILL.md": "---\nname: kecil\ndescription: ringkas\n---\nBADAN LENGKAP KECIL",
  })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }], always: ["ns:besar"] },
  })
  const { system } = buildSystemPrompt(config, root)

  assert.match(system, /BADAN LENGKAP BESAR/)
  assert.doesNotMatch(system, /BADAN LENGKAP KECIL/, "56 skill x 5,6 KB tidak muat di context mana pun")
  assert.match(system, /- ns:kecil: ringkas/)
})

test("skill yang sudah dimuat penuh tidak diulang di katalog", () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }], always: ["ns:a"] },
  })
  const { system } = buildSystemPrompt(config, root)
  assert.doesNotMatch(system, /- ns:a: d/)
})

test("nama always yang tidak ketemu DILEWATI, tidak menggagalkan apa pun", () => {
  // Menolak menyala karena satu plugin dicopot membuat Titah tidak bisa dipakai
  // justru saat user sedang membereskan konfigurasinya.
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const config = Config.parse({
    skills: {
      discover: [],
      paths: [{ path: path.join(root, "skills"), as: "ns" }],
      always: ["ns:hilang"],
    },
  })
  const result = buildSystemPrompt(config, root)

  assert.deepEqual(result.missingSkills, ["ns:hilang"])
  assert.match(result.system, /- ns:a/)
})

test("model diberi tahu tool skill ada, kalau memang ada skill", () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  assert.match(buildSystemPrompt(config, root).system, /skill\(/)
})
