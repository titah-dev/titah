import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { before, after } from "node:test"
import {
  expandTemplate,
  isBuiltin,
  listCommands,
  parseCommand,
  resolveCommand,
} from "../src/core/command.ts"
import { discoverSkills, parseFrontmatter, skillCatalog } from "../src/core/skill.ts"
import { buildSystemPrompt } from "../src/core/prompt.ts"
import { Config } from "../src/core/schema.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-cs-")))

before(() => {
  // Tata letak superpowers: <dir>/<nama>/SKILL.md
  fs.mkdirSync(path.join(root, "skills", "debugging"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "skills", "debugging", "SKILL.md"),
    "---\nname: systematic-debugging\ndescription: Cara mendebug secara sistematis\n---\n\nIsi skill debugging.\n",
  )
  // Tata letak satu file: <dir>/<nama>.md
  fs.writeFileSync(
    path.join(root, "skills", "review.md"),
    "---\ndescription: Checklist review\n---\n\nIsi skill review.\n",
  )
  fs.writeFileSync(path.join(root, "skills", "bukan-skill.txt"), "diabaikan")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// ---------- command ----------

test("parseCommand memisahkan nama dan argumen", () => {
  assert.deepEqual(parseCommand("/review src/a.ts"), { name: "review", args: "src/a.ts" })
  assert.deepEqual(parseCommand("  /lint  "), { name: "lint", args: "" })
  assert.deepEqual(parseCommand("/fix bug di\nbaris 2"), { name: "fix", args: "bug di\nbaris 2" })
})

test("parseCommand tidak menyambar path atau teks biasa", () => {
  assert.equal(parseCommand("/home/user/file.ts"), undefined, "path absolut bukan command")
  assert.equal(parseCommand("lihat /etc/hosts"), undefined)
  assert.equal(parseCommand("/1satu"), undefined, "harus diawali huruf")
})

test("template mendukung gaya opencode dan gaya Claude Code", () => {
  assert.equal(expandTemplate("Review {{.Input}} sekarang", "src/a.ts"), "Review src/a.ts sekarang")
  assert.equal(expandTemplate("Perbaiki $ARGUMENTS", "bug X"), "Perbaiki bug X")
  assert.equal(expandTemplate("{{.Input}} dan {{.Input}}", "x"), "x dan x")
})

test("command tanpa placeholder tetap jalan, argumen diabaikan", () => {
  assert.equal(expandTemplate("Jalankan semua test", "apa pun"), "Jalankan semua test")
})

test("resolveCommand mengembalikan prompt beserta override agent dan model", () => {
  const config = Config.parse({
    command: {
      review: { template: "Review {{.Input}}", agent: "qc", model: "p/m" },
      lint: { template: "Lint semua" },
    },
  })

  assert.deepEqual(resolveCommand(config, { name: "review", args: "src/a.ts" }), {
    prompt: "Review src/a.ts",
    agent: "qc",
    model: "p/m",
  })
  assert.deepEqual(resolveCommand(config, { name: "lint", args: "" }), { prompt: "Lint semua" })
  assert.equal(resolveCommand(config, { name: "entah", args: "" }), undefined)
})

test("command bawaan dikenali dan tidak bisa ditimpa config", () => {
  assert.equal(isBuiltin("consensus"), true)
  assert.equal(isBuiltin("agents"), true)
  assert.equal(isBuiltin("review"), false)

  // Meski user mendefinisikan /consensus, yang dipakai tetap yang bawaan —
  // command bawaan mengubah alur, bukan sekadar memperluas prompt.
  const config = Config.parse({ command: { consensus: { template: "bukan ini" } } })
  const names = listCommands(config).map((entry) => entry.name)
  assert.equal(names.filter((name) => name === "consensus").length, 2)
  assert.ok(
    names.indexOf("consensus") < names.lastIndexOf("consensus"),
    "bawaan harus muncul sebelum definisi user",
  )
})

// ---------- skill ----------

test("frontmatter dibaca, body dipisahkan", () => {
  const { fields, body } = parseFrontmatter("---\nname: uji\ndescription: halo\n---\n\nIsi.\n")
  assert.deepEqual(fields, { name: "uji", description: "halo" })
  assert.equal(body.trim(), "Isi.")
})

test("file tanpa frontmatter tetap terbaca utuh", () => {
  const { fields, body } = parseFrontmatter("Hanya isi biasa.\n")
  assert.deepEqual(fields, {})
  assert.equal(body.trim(), "Hanya isi biasa.")
})

test("frontmatter dengan tanda kutip dan nilai berisi titik dua", () => {
  const { fields } = parseFrontmatter('---\nname: "uji"\ndescription: Gunakan saat: X gagal\n---\nisi')
  assert.equal(fields["name"], "uji")
  assert.equal(fields["description"], "Gunakan saat: X gagal")
})

test("discoverSkills menemukan dua tata letak dan melewati file lain", () => {
  const config = Config.parse({ skills: { paths: [path.join(root, "skills")] } })
  const skills = discoverSkills(config, root)

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["review", "systematic-debugging"],
    "nama dari frontmatter menang atas nama direktori/file",
  )
  assert.match(skills[1]?.body ?? "", /Isi skill debugging/)
})

test("path skill yang tidak ada tidak menggagalkan sesi", () => {
  const config = Config.parse({ skills: { paths: ["/tidak/ada/sama/sekali"] } })
  assert.deepEqual(discoverSkills(config, root), [])
})

test("katalog skill ringkas satu baris per skill", () => {
  const config = Config.parse({ skills: { paths: [path.join(root, "skills")] } })
  const catalog = skillCatalog(discoverSkills(config, root))
  assert.match(catalog, /- systematic-debugging: Cara mendebug/)
  assert.equal(catalog.split("\n").length, 2)
})

// ---------- agent + prompt ----------

test("prompt agent dan skill yang ditugaskan dimuat utuh; sisanya cuma dikatalogkan", () => {
  const config = Config.parse({
    skills: { paths: [path.join(root, "skills")] },
    agent: {
      qc: {
        description: "Quality control",
        prompt: "Kamu teliti dan skeptis.",
        skills: ["systematic-debugging"],
      },
    },
  })

  const built = buildSystemPrompt(config, root, "qc")

  assert.match(built.system, /Kamu teliti dan skeptis/)
  assert.match(built.system, /Isi skill debugging/, "skill yang ditugaskan dimuat utuh")
  assert.doesNotMatch(built.system, /Isi skill review/, "skill lain cukup dikatalogkan")
  assert.match(built.system, /- review: Checklist review/)
  assert.ok(built.sources.some((source) => source.endsWith("SKILL.md")))
})

test("tanpa agent, tidak ada instruksi agent yang bocor ke system prompt", () => {
  const config = Config.parse({
    agent: { qc: { prompt: "RAHASIA AGENT QC" } },
  })
  const built = buildSystemPrompt(config, root)
  assert.doesNotMatch(built.system, /RAHASIA AGENT QC/)
})

test("skill yang ditugaskan tapi tidak ada dilewati diam-diam, bukan crash", () => {
  const config = Config.parse({
    skills: { paths: [path.join(root, "skills")] },
    agent: { qc: { skills: ["skill-yang-tidak-ada"] } },
  })
  assert.doesNotThrow(() => buildSystemPrompt(config, root, "qc"))
})
