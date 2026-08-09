import assert from "node:assert/strict"
import {
  deriveNamespace,
  scanSource,
  discoverSkills,
  buildSkillIndex,
  skillById,
  skillCatalog,
  renderSkillReport,
} from "../src/core/skill.ts"
import { Config } from "../src/core/schema.ts"
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

test("dokumen .md longgar tanpa frontmatter BUKAN skill", () => {
  // README.md, CHANGELOG.md, dst berbagi folder dengan skill sungguhan.
  // Tanpa aturan ini, banyak README di plugin yang sama semuanya jatuh ke
  // id "<ns>:README" dan bentrok satu sama lain — bukan konflik yang berarti
  // apa-apa, cuma dokumentasi yang salah dikira skill.
  const root = tree({
    "skills/a/SKILL.md": "---\nname: a\n---\nbadan",
    "skills/README.md": "Dokumentasi biasa, bukan skill.",
  })
  const found = scanSource({ root: path.join(root, "skills"), namespace: "ns" })
  assert.deepEqual(found.map((skill) => skill.id), ["ns:a"])
})

test("SKILL.md di dalam foldernya sendiri tetap skill walau tanpa frontmatter", () => {
  // Beda dengan .md longgar: lokasinya (nama folder) sudah menyatakan maksud,
  // jadi SKILL.md tanpa frontmatter TIDAK boleh ikut ditolak oleh aturan di atas.
  const root = tree({ "skills/tanpa-frontmatter/SKILL.md": "isi tanpa header apa pun" })
  const found = scanSource({ root: path.join(root, "skills"), namespace: "ns" })
  assert.equal(found[0]?.id, "ns:tanpa-frontmatter")
})

test("discoverSkills menangani kedua bentuk paths: string dan objek {path, as}", () => {
  // Kedua bentuk harus ditangani dengan benar: string biasa dan object dengan path + as.
  // Test ini mendeteksi jika ternary tertukar atau if-else branch tercampur.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "titah-discover-"))
  try {
    // Buat dua pohon skill terpisah
    const stringPath = path.join(tmpRoot, "stdlib")
    const objectPath = path.join(tmpRoot, "custom-lib")

    fs.mkdirSync(stringPath, { recursive: true })
    fs.mkdirSync(objectPath, { recursive: true })

    // Skill di path pertama (diakses sebagai string): namespace akan "stdlib"
    fs.mkdirSync(path.join(stringPath, "first"), { recursive: true })
    fs.writeFileSync(
      path.join(stringPath, "first", "SKILL.md"),
      "---\nname: first-skill\ndescription: dari path string\n---\nbadan",
    )

    // Skill di path kedua (diakses sebagai object {path, as}): namespace akan override ke "override"
    fs.mkdirSync(path.join(objectPath, "second"), { recursive: true })
    fs.writeFileSync(
      path.join(objectPath, "second", "SKILL.md"),
      "---\nname: second-skill\ndescription: dari path object\n---\nbadan",
    )

    // Config dengan kedua bentuk paths: satu string, satu object dengan as override
    // discover: [] diperlukan agar test tidak membaca ~/.claude atau ~/.config/opencode
    const config: Config = {
      skills: {
        discover: [],
        paths: [
          stringPath, // bentuk string → namespace: "stdlib"
          { path: objectPath, as: "override" }, // bentuk object dengan as → namespace: "override"
        ],
        always: [],
      },
      model: undefined,
      smallModel: undefined,
      provider: {},
      externalAgent: {},
      agent: {},
      command: {},
      defaultAgent: undefined,
      permission: { edit: "ask", write: "ask", bash: "ask", allowlist: [] },
      keybinds: {},
      instructions: [],
      logLevel: "INFO",
    }

    const skills = discoverSkills(config, tmpRoot)

    // Pastikan kedua skill ditemukan dengan id yang benar
    const skillIds = skills.map((s) => s.id).sort()
    assert.deepEqual(skillIds, ["override:second-skill", "stdlib:first-skill"], "Skill dari string path dan object path harus ditemukan keduanya")

    // Verifikasi skill pertama dari string path: namespace dari deriveNamespace
    const firstSkill = skills.find((s) => s.name === "first-skill")
    assert.ok(firstSkill, "Skill dari string path harus ditemukan")
    assert.equal(firstSkill?.id, "stdlib:first-skill")
    assert.equal(firstSkill?.namespace, "stdlib", "Namespace untuk string path harus dari deriveNamespace(path)")
    assert.match(firstSkill?.file ?? "", /stdlib.*first.*SKILL\.md/, "File path harus berasal dari stringPath")

    // Verifikasi skill kedua dari object path dengan namespace override
    const secondSkill = skills.find((s) => s.name === "second-skill")
    assert.ok(secondSkill, "Skill dari object path harus ditemukan")
    assert.equal(secondSkill?.id, "override:second-skill", "Namespace override di object.as harus dipakai daripada deriveNamespace")
    assert.equal(secondSkill?.namespace, "override")
    assert.match(secondSkill?.file ?? "", /custom-lib.*second.*SKILL\.md/, "File path harus berasal dari objectPath")
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test("id kembar: yang pertama menang DAN konfliknya dicatat", () => {
  // Perilaku lama membuang diam-diam. Karena namespace membuat bentrok jadi
  // jarang, bentrok yang tersisa hampir pasti pertanda salah konfigurasi.
  const root = tree({
    "a/skills/sama/SKILL.md": "---\nname: sama\n---\npertama",
    "b/skills/sama/SKILL.md": "---\nname: sama\n---\nkedua",
  })
  const config = Config.parse({
    skills: {
      discover: [],
      paths: [
        { path: path.join(root, "a", "skills"), as: "ns" },
        { path: path.join(root, "b", "skills"), as: "ns" },
      ],
    },
  })
  const index = buildSkillIndex(config, root)

  assert.equal(index.skills.length, 1)
  assert.equal(index.skills[0]?.body, "pertama")
  assert.equal(index.conflicts.length, 1)
  assert.equal(index.conflicts[0]?.id, "ns:sama")
  // kept/dropped adalah yang ditunjukkan ke user di /skills dan titah doctor —
  // kalau tertukar, penjelasan bentroknya jadi salah tanpa test manapun sadar.
  assert.equal(index.conflicts[0]?.kept, path.join(root, "a", "skills", "sama", "SKILL.md"))
  assert.equal(index.conflicts[0]?.dropped, path.join(root, "b", "skills", "sama", "SKILL.md"))
})

test("katalog memakai id lengkap, karena itu yang harus diketik user", () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\ndescription: begini\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  assert.equal(skillCatalog(buildSkillIndex(config, root).skills), "- ns:a: begini")
})

test("skillById menemukan lewat id lengkap saja", () => {
  const skills = [{ id: "ns:a", namespace: "ns", name: "a", description: "", body: "", file: "f" }]
  assert.equal(skillById(skills, "ns:a")?.name, "a")
  assert.equal(skillById(skills, "a"), undefined, "nama telanjang tidak pernah cocok")
})

// ---------- renderSkillReport ----------
// `titah doctor` dan `/skills` memanggil renderSkillReport, bukan CLI-nya
// langsung — ia string builder murni tanpa I/O, jadi diuji di sini bersama
// buildSkillIndex yang menjadi sumber datanya.

test("doctor melaporkan jumlah skill per namespace dan konflik yang terjadi", () => {
  const root = tree({
    "a/skills/sama/SKILL.md": "---\nname: sama\n---\nsatu",
    "b/skills/sama/SKILL.md": "---\nname: sama\n---\ndua",
  })
  const config = Config.parse({
    skills: {
      discover: [],
      paths: [
        { path: path.join(root, "a", "skills"), as: "ns" },
        { path: path.join(root, "b", "skills"), as: "ns" },
      ],
    },
  })
  const laporan = renderSkillReport(config, root)

  assert.match(laporan, /ns\s+1 skill/)
  assert.match(laporan, /1 conflict/)
})

test("always yang menggantung disebut namanya", () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }], always: ["ns:hilang"] },
  })
  const laporan = renderSkillReport(config, root)
  assert.match(laporan, /ns:hilang/)
  assert.match(laporan, /\(always\)/, "user harus tahu DI MANA namanya didaftarkan")
})

test("skill agent yang menggantung ikut dilaporkan, dengan nama agentnya", () => {
  // Spec: "Name in `always` or `agent.skills` not found → recorded, shown in
  // doctor, noted in /skills". Separuh per-agent-nya dulu dihitung
  // buildSystemPrompt lalu dikembalikan ke pemanggil yang tidak pernah
  // membacanya — jadi config yang berhenti bekerja setelah upgrade (nama
  // telanjang tidak lagi cocok) tidak pernah muncul di mana pun.
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
    agent: { qc: { skills: ["project-analyzer"] } },
  })
  const laporan = renderSkillReport(config, root)

  assert.match(laporan, /project-analyzer/)
  assert.match(laporan, /\(agent qc\)/)
})

test("setup bersih tidak melaporkan apa-apa selain hitungan", () => {
  // Baris konflik, sumber nihil, dan `always` yang menggantung hanya tampil
  // kalau ada isinya — kalau selalu tampil (misalnya "0 conflicts"), user
  // berhenti membacanya.
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }], always: ["ns:a"] },
  })
  const laporan = renderSkillReport(config, root)

  assert.doesNotMatch(laporan, /conflict/)
  assert.doesNotMatch(laporan, /not found/)
  assert.doesNotMatch(laporan, /sources with no skills/)
})

test("skills.paths yang tidak menghasilkan skill apa pun dilaporkan dengan path-nya", () => {
  // scanSource sengaja menelan direktori yang salah ketik atau tidak
  // terbaca (path skill yang salah tidak boleh menggagalkan sesi) — tapi itu
  // berarti dari dalam buildSkillIndex saja, path yang tidak ada tidak
  // dibedakan dari path yang sungguh kosong. renderSkillReport harus
  // menyebutnya, karena ini persis jenis salah-ketik yang tidak punya cara
  // lain untuk ditemukan user.
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nbadan" })
  const typo = path.join(root, "skilsl-salah-ketik")
  const config = Config.parse({
    skills: {
      discover: [],
      paths: [
        { path: path.join(root, "skills"), as: "ns" },
        { path: typo, as: "typo" },
      ],
    },
  })
  const laporan = renderSkillReport(config, root)

  assert.match(laporan, /sources with no skills/)
  assert.ok(laporan.includes(typo), "path yang nihil harus disebut apa adanya")
})
