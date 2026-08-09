# Active and Passive Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Claude Code and opencode skill already installed on the machine usable from Titah — automatically when the model judges one relevant, and explicitly via `/plugin:skill {message}`.

**Architecture:** Discovery produces `{root, namespace}` sources from three origins (Claude Code's plugin registry, opencode's config, and the user's own paths), then scans each root recursively for `SKILL.md`. Skills are identified as `namespace:name`. A single load operation renders a skill into a `<skill>` block; the user triggers it by typing a command, the model by calling a `skill` tool. Skills listed in `always` are injected whole into the system prompt; the rest appear only as a one-line catalogue.

**Tech Stack:** TypeScript (strict, ESM, Node ≥22.6), Zod v4 for config schema, `node:test` for tests, AI SDK v7 `tool()` for the tool surface.

**Spec:** `docs/superpowers/specs/2026-08-09-skills-active-passive-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Code comments in Indonesian; all user-facing strings in English.** This is the established convention throughout `src/`.
- **Comments explain *why*, never *what*.** Match the density and voice of surrounding code.
- **No test may read the real `~/.claude` or `~/.config/opencode`.** Discovery adapters are tested against a temporary `HOME`. A test depending on whichever plugins happen to be installed passes on one machine and fails on every other.
- **Tests never invoke a real external agent or a real provider.** Use stub models via `setModelResolver`.
- **Every task ends green:** `npm run typecheck && npm run build && npm test` all pass before the task is considered done.
- **Do not run `git commit` without explicit user approval.** The user has a standing instruction not to commit yet, and this repository still has zero commits. Commit steps below are written for when that approval arrives; until then, stage nothing and stop at the verification step.
- **Existing behaviour that must not regress:** the command regex must keep refusing to parse `/home/user/notes.md` as a command; `discoverSkills` must keep tolerating unreadable paths without failing a session.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/skill.ts` | Skill type, frontmatter parsing, recursive scanning, namespace derivation, catalogue, load rendering | Modify (~96 → ~200 lines) |
| `src/core/skill-sources.ts` | Adapters that turn Claude Code's and opencode's registries into `SkillSource[]` | **Create** |
| `src/core/schema.ts` | `Skills` config schema gains `discover`, structured `paths`, `always` | Modify |
| `src/core/prompt.ts` | System prompt assembly: `always` whole, rest catalogued | Modify (lines 95–121) |
| `src/core/command.ts` | Command regex accepts `plugin:skill`; config keys reject `:` | Modify |
| `src/core/agent.ts` | Route `name:skill` commands to a skill turn; pass `config` into `ToolContext` | Modify |
| `src/core/tool/types.ts` | `ToolContext` gains `config` | Modify |
| `src/core/tool/skill.ts` | The `skill` tool | **Create** |
| `src/core/tool/index.ts` | Register `skillTool` | Modify |
| `src/core/compact.ts` | `COMPACT_SYSTEM` instruction for `<skill>` blocks | Modify |
| `src/tui/complete.ts` | Skill suggestions become `/namespace:name` | Modify |
| `src/cli.ts` | `doctor` reports skills | Modify |

Two files rather than one: discovery adapters know the on-disk shape of *other tools'* registries, which is knowledge that changes for reasons unrelated to how Titah renders a skill. Keeping `skill.ts` as the public surface avoids churning imports in `prompt.ts`, `agent.ts`, and `complete.ts`.

---

## Task 1: Namespace derivation and recursive scanning

**Files:**
- Modify: `src/core/skill.ts`
- Test: `test/skill.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface SkillSource { root: string; namespace: string }`
  - `interface Skill { id: string; namespace: string; name: string; description: string; body: string; file: string }`
  - `deriveNamespace(root: string): string`
  - `scanSource(source: SkillSource): Skill[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/skill.test.ts`:

```ts
import { deriveNamespace, scanSource } from "../src/core/skill.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/skill.test.ts`
Expected: FAIL — `deriveNamespace is not a function`

- [ ] **Step 3: Implement in `src/core/skill.ts`**

Replace the `Skill` interface and add the two functions. Keep `parseFrontmatter` and `readSkill` as they are, adding `id`/`namespace` to what `readSkill` returns.

```ts
export interface Skill {
  /** `namespace:name` — satu-satunya bentuk yang dipakai memanggil skill. */
  id: string
  namespace: string
  name: string
  description: string
  body: string
  file: string
}

/** Satu direktori skill beserta namespace yang mewakilinya. */
export interface SkillSource {
  root: string
  namespace: string
}

/**
 * Menentukan namespace sebuah direktori skill.
 *
 * Manifes plugin menang karena ia otoritatif. Kalau tidak ada, nama folder
 * dipakai — kecuali foldernya bernama `skills`, yang tidak memberi tahu apa pun,
 * sehingga induknya yang dipakai. Aturan terakhir itu yang menghasilkan
 * "opencode" untuk ~/.config/opencode/skills.
 */
export function deriveNamespace(root: string): string {
  const resolved = path.resolve(root)

  // Manifes bisa berada di direktori skill atau di akar paket di atasnya.
  for (const candidate of [resolved, path.dirname(resolved)]) {
    try {
      const raw = fs.readFileSync(path.join(candidate, ".claude-plugin", "plugin.json"), "utf8")
      const name = (JSON.parse(raw) as { name?: unknown }).name
      if (typeof name === "string" && name.trim() !== "") return name.trim()
    } catch {
      // Tanpa manifes bukan kesalahan — sebagian besar folder skill memang tidak punya.
    }
  }

  const base = path.basename(resolved)
  return base === "skills" ? path.basename(path.dirname(resolved)) : base
}

/** Semua skill di dalam satu sumber, dipindai sampai ke sub-direktori terdalam. */
export function scanSource(source: SkillSource): Skill[] {
  const out: Skill[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return // pagar terhadap symlink yang berputar

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // path skill yang salah tidak boleh menggagalkan sesi
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const skill = readSkill(path.join(full, "SKILL.md"), entry.name, source.namespace)
        if (skill) out.push(skill)
        // Tetap turun: `skills/productivity/` bukan skill, ia hanya wadah.
        else walk(full, depth + 1)
      } else if (entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        const skill = readSkill(full, entry.name.replace(/\.md$/, ""), source.namespace)
        if (skill) out.push(skill)
      }
    }
  }

  walk(path.resolve(source.root), 0)
  return out
}
```

Update `readSkill` to take the namespace and build the id:

```ts
function readSkill(file: string, fallbackName: string, namespace: string): Skill | undefined {
  let content: string
  try {
    content = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const { fields, body } = parseFrontmatter(content)
  const name = fields["name"] ?? fallbackName
  return {
    id: `${namespace}:${name}`,
    namespace,
    name,
    description: fields["description"] ?? "",
    body: body.trim(),
    file,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/skill.test.ts`
Expected: PASS. Then `npm run typecheck` — expect errors in `prompt.ts` and `agent.ts` about the changed signature; those are fixed in Tasks 4 and 5. Leave them.

- [ ] **Step 5: Commit** *(only with user approval — see Global Constraints)*

```bash
git add src/core/skill.ts test/skill.test.ts
git commit -m "feat(skill): recursive scanning and namespaced skill ids"
```

---

## Task 2: Config schema

**Files:**
- Modify: `src/core/schema.ts` (the `Skills` object, currently lines 117–122)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `config.skills.discover: ("claude" | "opencode")[]`, `config.skills.paths: (string | {path: string, as?: string})[]`, `config.skills.always: string[]`

- [ ] **Step 1: Write the failing tests**

```ts
test("skills.discover menyala untuk claude dan opencode secara default", () => {
  const config = Config.parse({})
  assert.deepEqual(config.skills.discover, ["claude", "opencode"])
  assert.deepEqual(config.skills.always, [])
})

test("path skill boleh string biasa atau objek berlabel", () => {
  const config = Config.parse({
    skills: { paths: ["./skills", { path: "~/lib/skills", as: "punyaku" }] },
  })
  assert.equal(config.skills.paths[0], "./skills")
  assert.deepEqual(config.skills.paths[1], { path: "~/lib/skills", as: "punyaku" })
})

test("auto-deteksi bisa dimatikan seluruhnya", () => {
  assert.deepEqual(Config.parse({ skills: { discover: [] } }).skills.discover, [])
})

test("sumber auto-deteksi yang tidak dikenal ditolak, bukan diabaikan", () => {
  // Salah ketik "openccode" yang diam-diam diabaikan berarti skill hilang tanpa
  // satu pun petunjuk kenapa.
  assert.throws(() => Config.parse({ skills: { discover: ["openccode"] } }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/config.test.ts`
Expected: FAIL — `config.skills.discover` is undefined

- [ ] **Step 3: Implement**

```ts
const SkillPath = z.union([
  z.string(),
  z.object({
    path: z.string(),
    as: z.string().optional().describe("Namespace override; derived from the folder when omitted"),
  }),
])

export const Skills = z.object({
  discover: z
    .array(z.enum(["claude", "opencode"]))
    .default(["claude", "opencode"])
    .describe("Read Claude Code and opencode registries so installed skills work without configuration"),
  paths: z
    .array(SkillPath)
    .default([])
    .describe("Directories containing skills. Supports <dir>/<name>/SKILL.md and <dir>/<name>.md"),
  always: z
    .array(z.string())
    .default([])
    .describe('Skill ids loaded in full every turn, e.g. "superpowers:using-superpowers"'),
})
```

Update the default in the `Config` object (currently `skills: Skills.default({ paths: [] })`) to `skills: Skills.default({ discover: ["claude", "opencode"], paths: [], always: [] })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/config.test.ts` → PASS
Then regenerate the JSON schema: `npm run schema` (check `package.json` for the exact script name; it writes `config.schema.json`).

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/schema.ts config.schema.json test/config.test.ts
git commit -m "feat(config): skills.discover, structured paths, and always list"
```

---

## Task 3: Discovery adapters

**Files:**
- Create: `src/core/skill-sources.ts`
- Test: `test/skill-sources.test.ts`

**Interfaces:**
- Consumes: `SkillSource` from Task 1
- Produces:
  - `claudeSources(home: string): SkillSource[]`
  - `opencodeSources(home: string): SkillSource[]`
  - `configSources(config: Config, cwd: string): SkillSource[]`
  - `allSources(config: Config, cwd: string, home?: string): SkillSource[]`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { allSources, claudeSources, opencodeSources } from "../src/core/skill-sources.ts"
import { Config } from "../src/core/schema.ts"

/** HOME palsu — test TIDAK BOLEH menyentuh ~/.claude milik siapa pun. */
function fakeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-home-"))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(home, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return home
}

test("registry Claude Code diterjemahkan jadi sumber skill", () => {
  const home = fakeHome({})
  const install = path.join(home, "plugins", "superpowers", "6.2.0")
  fs.mkdirSync(path.join(install, "skills"), { recursive: true })
  fs.mkdirSync(path.join(install, ".claude-plugin"), { recursive: true })
  fs.writeFileSync(
    path.join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "superpowers" }),
  )
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "superpowers@official": [{ installPath: install, version: "6.2.0" }] },
    }),
  )

  assert.deepEqual(claudeSources(home), [
    { root: path.join(install, "skills"), namespace: "superpowers" },
  ])
})

test("plugin tanpa folder skills dilewati", () => {
  const home = fakeHome({})
  const install = path.join(home, "plugins", "kosong", "1.0.0")
  fs.mkdirSync(install, { recursive: true })
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "kosong@x": [{ installPath: install }] } }),
  )
  assert.deepEqual(claudeSources(home), [])
})

test("registry yang hilang atau formatnya asing menghasilkan nol sumber, bukan error", () => {
  // Format itu milik Claude Code dan bisa berubah kapan saja tanpa memberi tahu.
  assert.deepEqual(claudeSources(fakeHome({})), [])
  assert.deepEqual(
    claudeSources(fakeHome({ ".claude/plugins/installed_plugins.json": "{ bukan json" })),
    [],
  )
  assert.deepEqual(
    claudeSources(fakeHome({ ".claude/plugins/installed_plugins.json": '{"version":99}' })),
    [],
  )
})

test("skills.paths opencode dibaca dari config-nya", () => {
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({
      skills: { paths: ["/tmp/skill-opencode"] },
    }),
  })
  assert.deepEqual(opencodeSources(home), [
    { root: "/tmp/skill-opencode", namespace: "skill-opencode" },
  ])
})

test("path milik user menang atas hasil auto-deteksi", () => {
  // Konfigurasi yang ditulis sendiri harus mengalahkan apa pun yang disimpulkan.
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["/tmp/auto"] } }),
  })
  const config = Config.parse({ skills: { paths: [{ path: "/tmp/punyaku", as: "punyaku" }] } })
  const sources = allSources(config, "/tmp", home)

  assert.equal(sources[0]?.namespace, "punyaku", "punya user lebih dulu")
})

test("discover kosong mematikan seluruh auto-deteksi", () => {
  const home = fakeHome({
    ".config/opencode/opencode.json": JSON.stringify({ skills: { paths: ["/tmp/auto"] } }),
  })
  const config = Config.parse({ skills: { discover: [], paths: ["./skills"] } })
  const sources = allSources(config, "/proyek", home)

  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.root, path.resolve("/proyek", "./skills"))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/skill-sources.test.ts`
Expected: FAIL — cannot find module `skill-sources.ts`

- [ ] **Step 3: Implement `src/core/skill-sources.ts`**

```ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Config } from "./schema.ts"
import { deriveNamespace, type SkillSource } from "./skill.ts"

/**
 * Menerjemahkan registry milik editor LAIN menjadi sumber skill.
 *
 * Dipisah dari skill.ts karena isinya adalah pengetahuan tentang bentuk file
 * orang lain di disk — sesuatu yang berubah karena alasan yang sama sekali tidak
 * berhubungan dengan cara Titah merender skill.
 *
 * Semua fungsi di sini mengembalikan daftar kosong ketika ada yang tidak beres.
 * Registry ini milik Claude Code dan opencode; mereka boleh mengubah formatnya
 * kapan saja, dan itu tidak boleh membuat Titah gagal menyala.
 */

function readJSON(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Folder yang ada DAN berupa direktori. */
function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function claudeSources(home = os.homedir()): SkillSource[] {
  const registry = readJSON(path.join(home, ".claude", "plugins", "installed_plugins.json"))
  if (registry === null || typeof registry !== "object") return []

  const { version, plugins } = registry as { version?: unknown; plugins?: unknown }
  // Versi asing berarti bentuknya sudah bukan yang kita pahami. Menebak isinya
  // lebih buruk daripada tidak menemukan skill sama sekali.
  if (version !== 2 || plugins === null || typeof plugins !== "object") return []

  const out: SkillSource[] = []
  for (const installs of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown }).installPath
      if (typeof installPath !== "string") continue
      const root = path.join(installPath, "skills")
      if (!directoryExists(root)) continue
      out.push({ root, namespace: deriveNamespace(root) })
    }
  }
  return out
}

export function opencodeSources(home = os.homedir()): SkillSource[] {
  const config = readJSON(path.join(home, ".config", "opencode", "opencode.json"))
  if (config === null || typeof config !== "object") return []

  const paths = (config as { skills?: { paths?: unknown } }).skills?.paths
  if (!Array.isArray(paths)) return []

  return paths
    .filter((entry): entry is string => typeof entry === "string")
    .map((root) => ({ root: path.resolve(root), namespace: deriveNamespace(root) }))
}

export function configSources(config: Config, cwd: string): SkillSource[] {
  return config.skills.paths.map((entry) => {
    const raw = typeof entry === "string" ? entry : entry.path
    const root = path.resolve(cwd, raw.replace(/^~(?=$|\/)/, os.homedir()))
    const override = typeof entry === "string" ? undefined : entry.as
    return { root, namespace: override ?? deriveNamespace(root) }
  })
}

/**
 * Sumber dalam urutan PRIORITAS: milik user lebih dulu.
 *
 * Urutan ini yang menyelesaikan bentrok id nanti — yang pertama menang, jadi
 * konfigurasi yang ditulis sendiri selalu mengalahkan hasil auto-deteksi.
 */
export function allSources(config: Config, cwd: string, home = os.homedir()): SkillSource[] {
  const auto: SkillSource[] = []
  if (config.skills.discover.includes("claude")) auto.push(...claudeSources(home))
  if (config.skills.discover.includes("opencode")) auto.push(...opencodeSources(home))
  return [...configSources(config, cwd), ...auto]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/skill-sources.test.ts` → PASS

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/skill-sources.ts test/skill-sources.test.ts
git commit -m "feat(skill): read Claude Code and opencode registries"
```

---

## Task 4: Wire discovery together and record conflicts

**Files:**
- Modify: `src/core/skill.ts`
- Test: `test/skill.test.ts`

**Interfaces:**
- Consumes: `allSources` (Task 3), `scanSource` (Task 1)
- Produces:
  - `interface SkillIndex { skills: Skill[]; conflicts: { id: string; kept: string; dropped: string }[] }`
  - `buildSkillIndex(config: Config, cwd: string, home?: string): SkillIndex`
  - `discoverSkills(config: Config, cwd: string): Skill[]` — unchanged signature, now returns namespaced skills
  - `skillById(skills: Skill[], id: string): Skill | undefined`
  - `skillCatalog(skills: Skill[]): string` — now prints ids

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/skill.test.ts`
Expected: FAIL — `buildSkillIndex is not a function`

- [ ] **Step 3: Implement**

Replace `discoverSkills`, `skillByName`, and `skillCatalog` in `src/core/skill.ts`:

```ts
export interface SkillConflict {
  id: string
  /** File yang dipakai. */
  kept: string
  /** File yang dikalahkan. */
  dropped: string
}

export interface SkillIndex {
  skills: Skill[]
  conflicts: SkillConflict[]
}

/**
 * Seluruh skill yang terlihat, beserta bentrok yang terjadi saat menyusunnya.
 *
 * Konflik dikembalikan, bukan dibuang, supaya `/skills` dan `titah doctor` bisa
 * menunjukkannya. Bentrok yang senyap berarti skill yang dipanggil user bisa
 * berganti sendiri begitu ada plugin baru terpasang.
 */
export function buildSkillIndex(config: Config, cwd: string, home?: string): SkillIndex {
  const found = new Map<string, Skill>()
  const conflicts: SkillConflict[] = []

  for (const source of allSources(config, cwd, home)) {
    for (const skill of scanSource(source)) {
      const existing = found.get(skill.id)
      if (existing) {
        conflicts.push({ id: skill.id, kept: existing.file, dropped: skill.file })
        continue
      }
      found.set(skill.id, skill)
    }
  }

  return {
    skills: [...found.values()].sort((a, b) => a.id.localeCompare(b.id)),
    conflicts,
  }
}

export function discoverSkills(config: Config, cwd: string): Skill[] {
  return buildSkillIndex(config, cwd).skills
}

export function skillById(skills: Skill[], id: string): Skill | undefined {
  return skills.find((skill) => skill.id === id)
}

/** Katalog satu baris per skill, cukup untuk model tahu apa yang tersedia. */
export function skillCatalog(skills: Skill[]): string {
  return skills
    .map((skill) => `- ${skill.id}${skill.description ? `: ${skill.description}` : ""}`)
    .join("\n")
}
```

Add `import { allSources } from "./skill-sources.ts"` at the top. Delete the now-unused `skillByName`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/skill.test.ts` → PASS

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/skill.ts test/skill.test.ts
git commit -m "feat(skill): build a skill index that records id conflicts"
```

---

## Task 5: System prompt — `always` whole, the rest catalogued

**Files:**
- Modify: `src/core/prompt.ts` (lines 95–121)
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: `buildSkillIndex`, `skillById`, `skillCatalog`
- Produces: `buildSystemPrompt` gains `missingSkills: string[]` in its return value

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/prompt.test.ts`
Expected: FAIL — `missingSkills` is undefined

- [ ] **Step 3: Implement**

Replace lines 95–121 of `src/core/prompt.ts`:

```ts
  const index = buildSkillIndex(config, cwd)
  const agent = agentID ? config.agent[agentID] : undefined

  if (agent?.prompt) {
    sections.push(`--- Instructions for agent "${agentID}" ---\n${agent.prompt.trim()}`)
  }

  // `always` berlaku untuk semua agent; `agent.skills` menambahkan yang khusus
  // agent ini. Keduanya dimuat UTUH — sisanya cukup dikatalogkan, karena memuat
  // semuanya menghabiskan context window sebelum kerja dimulai.
  const wanted = [...config.skills.always, ...(agent?.skills ?? [])]
  const missingSkills: string[] = []
  const full: Skill[] = []

  for (const id of wanted) {
    const skill = skillById(index.skills, id)
    if (skill) {
      if (!full.includes(skill)) full.push(skill)
    } else if (!missingSkills.includes(id)) {
      missingSkills.push(id)
    }
  }

  for (const skill of full) {
    sections.push(`--- Skill: ${skill.id} ---\n${skill.body}`)
  }

  const rest = index.skills.filter((skill) => !full.includes(skill))
  if (rest.length > 0) {
    sections.push(
      [
        "--- Available skills ---",
        'Call skill("<id>") to load one in full when it applies to the task.',
        skillCatalog(rest),
      ].join("\n"),
    )
  }

  return {
    system: sections.join("\n\n"),
    sources: [...files.map((file) => file.path), ...full.map((skill) => skill.file)],
    missingSkills,
    conflicts: index.conflicts,
  }
}
```

Update the import line to:

```ts
import {
  buildSkillIndex,
  skillById,
  skillCatalog,
  type Skill,
  type SkillConflict,
} from "./skill.ts"
```

and widen the function's declared return type to include `missingSkills: string[]` and `conflicts: SkillConflict[]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/prompt.test.ts` → PASS, then `npm run typecheck` → clean.

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/prompt.ts test/prompt.test.ts
git commit -m "feat(prompt): load always-on skills in full, catalogue the rest"
```

---

## Task 6: Route `/namespace:skill` commands

**Files:**
- Modify: `src/core/command.ts`, `src/core/agent.ts`
- Test: `test/command.test.ts`

**Interfaces:**
- Consumes: `buildSkillIndex`, `skillById`
- Produces: `renderSkill(skill: Skill, args?: string): string` and `isSkillCommand(name: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
test("nama command boleh mengandung titik dua untuk skill", () => {
  const parsed = parseCommand("/superpowers:brainstorming bikin fitur X")
  assert.equal(parsed?.name, "superpowers:brainstorming")
  assert.equal(parsed?.args, "bikin fitur X")
})

test("path absolut TETAP tidak terbaca sebagai command", () => {
  // Perlindungan yang sudah ada: user yang menempel path tidak boleh dapat
  // error command yang tidak masuk akal.
  assert.equal(parseCommand("/home/user/catatan.md"), undefined)
  assert.equal(parseCommand("/etc/hosts baca ini"), undefined)
})

test("isi skill dibungkus supaya bisa dikenali peringkas dan user", () => {
  const skill = {
    id: "ns:a",
    namespace: "ns",
    name: "a",
    description: "",
    body: "LANGKAH SATU",
    file: "/tmp/a/SKILL.md",
  }
  const rendered = renderSkill(skill, "kerjakan X")

  assert.match(rendered, /<skill name="ns:a" source="\/tmp\/a\/SKILL.md">/)
  assert.match(rendered, /LANGKAH SATU/)
  assert.match(rendered, /<\/skill>/)
  assert.ok(rendered.trimEnd().endsWith("kerjakan X"), "argumen user datang setelah skill")
})

test("skill tanpa argumen tetap sah", () => {
  const skill = { id: "ns:a", namespace: "ns", name: "a", description: "", body: "B", file: "f" }
  assert.ok(renderSkill(skill, "").includes("B"))
})

test("kunci command di config tidak boleh mengandung titik dua", () => {
  // `:` adalah ruang nama skill. Kalau config boleh memakainya, dua hal berbeda
  // bisa menjawab nama yang sama dan aturan prioritas jadi perlu diadili —
  // padahal seluruh desain ini dibangun supaya itu tidak pernah terjadi.
  assert.throws(
    () => Config.parse({ command: { "punya:saya": { template: "x" } } }),
    /colon/i,
  )
  assert.doesNotThrow(() => Config.parse({ command: { biasa: { template: "x" } } }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/command.test.ts`
Expected: FAIL — `parsed?.name` is `"superpowers"` (the `:` stops the match)

- [ ] **Step 3: Implement**

In `src/core/command.ts`, change the regex and forbid `:` in config command keys:

```ts
/**
 * Nama command WAJIB diikuti spasi atau akhir baris.
 *
 * Tanpa itu, `/home/user/catatan.md` terbaca sebagai command `/home` — dan user
 * yang menempel path absolut ke dalam prompt akan mendapat error yang tidak
 * masuk akal alih-alih jawaban.
 *
 * Satu titik dua diizinkan untuk memisahkan namespace skill dari namanya.
 * Karena skill SELALU bernama lengkap, kehadiran `:` sudah cukup menentukan
 * bahwa ini skill — tidak ada aturan prioritas yang perlu diadili.
 */
const COMMAND = /^\/([A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?)(?:\s+([\s\S]*))?$/

/** Nama yang mengandung `:` adalah skill, bukan command dari config. */
export function isSkillCommand(name: string): boolean {
  return name.includes(":")
}
```

In `src/core/schema.ts`, forbid `:` in command keys so the two namespaces can never
overlap:

```ts
  command: z
    .record(z.string(), Command)
    .default({})
    .superRefine((commands, ctx) => {
      for (const name of Object.keys(commands)) {
        if (!name.includes(":")) continue
        ctx.addIssue({
          code: "custom",
          // `:` milik ruang nama skill. Membiarkannya di sini berarti dua hal
          // berbeda bisa menjawab nama yang sama.
          message: `Command name "${name}" must not contain a colon — that is reserved for skills (plugin:skill).`,
        })
      }
    }),
```

In `src/core/skill.ts`, add the shared renderer — the single place both entry points use:

```ts
/**
 * Isi skill sebagaimana dilihat model.
 *
 * Pembungkus `<skill>` bukan hiasan: peringkas `/compact` memakainya untuk
 * mencatat "skill X dimuat" alih-alih menyalin ulang seluruh isinya ke ringkasan.
 */
export function renderSkill(skill: Skill, args = ""): string {
  const block = `<skill name="${skill.id}" source="${skill.file}">\n${skill.body}\n</skill>`
  return args.trim() === "" ? block : `${block}\n\n${args.trim()}`
}
```

In `src/core/agent.ts`, inside `prompt()` right after the builtin check (currently line 107–109):

```ts
    // Skill dipanggil langsung: `/superpowers:brainstorming pesan`. Isinya masuk
    // ke pesan yang DIKIRIM, sementara transkrip tetap menampilkan yang diketik.
    if (isSkillCommand(command.name)) {
      const skills = discoverSkills(config, session.directory)
      const skill = skillById(skills, command.name)
      if (!skill) {
        const sameNamespace = skills
          .filter((entry) => entry.namespace === command.name.split(":")[0])
          .map((entry) => `  /${entry.id}`)
        return infoTurn(
          session,
          input.text,
          sameNamespace.length > 0
            ? `Unknown skill "${command.name}". Available in that namespace:\n${sameNamespace.join("\n")}`
            : `Unknown skill "${command.name}". Run /skills to see what is available.`,
          true,
        )
      }
      text = renderSkill(skill, command.args)
    } else if (isBuiltin(command.name)) {
```

Restructure the existing `if (isBuiltin(...))` into the `else if` chain shown, keeping the rest of the command handling intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/command.test.ts` → PASS, then `npm test` → all green.

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/command.ts src/core/skill.ts src/core/agent.ts test/command.test.ts
git commit -m "feat(agent): invoke skills as /namespace:name commands"
```

---

## Task 7: The `skill` tool and the reload guard

**Files:**
- Create: `src/core/tool/skill.ts`
- Modify: `src/core/tool/types.ts`, `src/core/tool/index.ts`, `src/core/agent.ts`
- Test: `test/tool-skill.test.ts`

**Interfaces:**
- Consumes: `renderSkill`, `discoverSkills`, `skillById`, `listModelMessages`
- Produces: `skillTool: TitahTool`, `loadedSkillIds(sessionID: string): Set<string>`

- [ ] **Step 1: Write the failing tests**

```ts
process.env["TITAH_DB"] = ":memory:"

const { appendModelMessages, createSession, saveCompaction } = await import(
  "../src/core/storage/session.ts"
)
const { loadedSkillIds } = await import("../src/core/tool/skill.ts")

test("skill yang sudah dimuat terbaca dari riwayat", () => {
  const session = createSession(process.cwd())
  appendModelMessages(session.id, [
    { role: "user", content: '<skill name="ns:a" source="/f">badan</skill>' },
  ])
  assert.ok(loadedSkillIds(session.id).has("ns:a"))
})

test("SETELAH /compact skill boleh dimuat ulang", () => {
  // Ini bug yang paling mudah luput. Kalau daftar "sudah dimuat" dihitung dari
  // baris MENTAH, skill yang isinya sudah lenyap dari pandangan model tetap
  // dianggap termuat — dan model kehilangan skill itu selamanya tanpa tahu kenapa.
  const session = createSession(process.cwd())
  appendModelMessages(session.id, [
    { role: "user", content: '<skill name="ns:a" source="/f">badan</skill>' },
    { role: "assistant", content: "oke" },
    { role: "user", content: "lanjut" },
    { role: "assistant", content: "siap" },
  ])
  assert.ok(loadedSkillIds(session.id).has("ns:a"), "sebelum dipadatkan: termuat")

  saveCompaction(session.id, 1, "<context-summary>ringkasan</context-summary>")
  assert.ok(!loadedSkillIds(session.id).has("ns:a"), "sesudah dipadatkan: boleh dimuat lagi")
})
```

Plus a behaviour test for the tool itself:

```ts
test("memuat skill dua kali mengembalikan catatan, bukan isinya lagi", async () => {
  const root = tree({ "skills/a/SKILL.md": "---\nname: a\n---\nBADAN PANJANG" })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  const session = createSession(root)
  const ctx = { cwd: root, sessionID: session.id, callID: "c1", signal: new AbortController().signal, config }

  const first = await skillTool.execute({ name: "ns:a" }, ctx)
  assert.match(first.output, /BADAN PANJANG/)

  appendModelMessages(session.id, [{ role: "user", content: first.output }])

  const second = await skillTool.execute({ name: "ns:a" }, ctx)
  assert.doesNotMatch(second.output, /BADAN PANJANG/)
  assert.match(second.output, /already loaded/i)
})

test("isi yang melewati batas dipotong DENGAN pemberitahuan", async () => {
  // Dipotong diam-diam berarti model bekerja dari instruksi setengah tanpa tahu
  // ada bagian yang hilang.
  const root = tree({ "skills/besar/SKILL.md": `---\nname: besar\n---\n${"x".repeat(70 * 1024)}` })
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: path.join(root, "skills"), as: "ns" }] },
  })
  const session = createSession(root)
  const ctx = { cwd: root, sessionID: session.id, callID: "c", signal: new AbortController().signal, config }

  const result = await skillTool.execute({ name: "ns:besar" }, ctx)
  assert.match(result.output, /truncated/)
  assert.equal(result.metadata?.["truncated"], true)
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
  const ctx = { cwd: root, sessionID: session.id, callID: "c", signal: new AbortController().signal, config }

  const result = await skillTool.execute({ name: "ns:tidakada" }, ctx)
  assert.match(result.output, /ns:ada/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/tool-skill.test.ts`
Expected: FAIL — cannot find module `tool/skill.ts`

- [ ] **Step 3: Implement**

First widen `ToolContext` in `src/core/tool/types.ts`:

```ts
export interface ToolContext {
  /** Direktori kerja sesi. Semua path tool dibatasi di dalamnya. */
  cwd: string
  sessionID: string
  callID: string
  signal: AbortSignal
  /** Dibutuhkan tool yang membaca konfigurasi, mis. `skill`. */
  config: Config
}
```

Add `import type { Config } from "../schema.ts"`. Then in `src/core/agent.ts`, line 849, change `const ctx = { cwd, sessionID, callID, signal }` to `const ctx = { cwd, sessionID, callID, signal, config: options.config }`.

Create `src/core/tool/skill.ts`:

```ts
import { z } from "zod"
import { discoverSkills, renderSkill, skillById } from "../skill.ts"
import { listModelMessages } from "../storage/session.ts"
import type { TitahTool } from "./types.ts"

/** Isi skill terbesar hari ini 9 KB; batas ini longgar dengan sengaja. */
const MAX_BODY = 64 * 1024

const LOADED = /<skill name="([^"]+)"/g

/**
 * Skill yang sudah terlihat oleh model di sesi ini.
 *
 * Dihitung dari riwayat yang DILIHAT MODEL, bukan dari baris mentah. Setelah
 * `/compact`, isi skill sudah lenyap dari pandangan model walau barisnya masih
 * ada di disk; kalau dihitung dari baris mentah, model dianggap masih memilikinya
 * dan kehilangan skill itu selamanya tanpa cara memuatnya ulang.
 */
export function loadedSkillIds(sessionID: string): Set<string> {
  const ids = new Set<string>()
  for (const message of listModelMessages(sessionID)) {
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    for (const match of text.matchAll(LOADED)) ids.add(match[1] as string)
  }
  return ids
}

const inputSchema = z.object({
  name: z.string().describe('Fully qualified skill id, e.g. "superpowers:brainstorming"'),
})

export const skillTool: TitahTool<typeof inputSchema> = {
  name: "skill",
  description:
    "Load a skill's full instructions into the conversation. Use it when the catalogue entry " +
    "suggests a skill applies to the current task. Ids are fully qualified, e.g. " +
    '"superpowers:brainstorming".',
  inputSchema,

  // Tanpa `permission`: memuat skill membaca file dari path yang user sendiri
  // daftarkan dan menaruhnya di konteks — setara system prompt. Dialog di sini
  // hanya melatih orang menekan "y" tanpa membaca.

  async execute(input, ctx) {
    const skills = discoverSkills(ctx.config, ctx.cwd)
    const skill = skillById(skills, input.name)

    if (!skill) {
      const namespace = input.name.split(":")[0]
      const nearby = skills.filter((entry) => entry.namespace === namespace)
      const list = (nearby.length > 0 ? nearby : skills).slice(0, 20).map((entry) => entry.id)
      return {
        title: `skill ${input.name} (not found)`,
        output: `No skill with id "${input.name}". Available:\n${list.join("\n")}`,
      }
    }

    if (loadedSkillIds(ctx.sessionID).has(skill.id)) {
      return {
        title: `skill ${skill.id} (already loaded)`,
        output: `The "${skill.id}" skill was already loaded earlier in this session. Its instructions still apply — scroll back rather than loading it again.`,
      }
    }

    const truncated = skill.body.length > MAX_BODY
    const body = truncated
      ? `${skill.body.slice(0, MAX_BODY)}\n\n[truncated: skill body exceeds ${MAX_BODY} bytes]`
      : skill.body

    return {
      title: `skill ${skill.id}`,
      output: renderSkill({ ...skill, body }),
      metadata: { file: skill.file, truncated },
    }
  },
}
```

Register it in `src/core/tool/index.ts`: add the import, add `skillTool` to the `TOOLS` array, and add it to the re-export list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/tool-skill.test.ts` → PASS, then `npm test` → all green.

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/tool/skill.ts src/core/tool/types.ts src/core/tool/index.ts src/core/agent.ts test/tool-skill.test.ts
git commit -m "feat(tool): add the skill tool with a compaction-aware reload guard"
```

---

## Task 8: Teach `/compact` about skill blocks

**Files:**
- Modify: `src/core/compact.ts`
- Test: `test/compact.test.ts`

**Interfaces:**
- Consumes: the `<skill>` wrapper from Task 6
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```ts
test("peringkas diminta mencatat skill, bukan menyalin ulang isinya", () => {
  // Sebuah skill 9 KB yang disalin utuh ke ringkasan membatalkan seluruh gunanya
  // memadatkan konteks.
  assert.match(COMPACT_SYSTEM, /<skill/)
  assert.match(COMPACT_SYSTEM, /which skills were loaded/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/compact.test.ts`
Expected: FAIL — `COMPACT_SYSTEM` does not mention skills

- [ ] **Step 3: Implement**

In `src/core/compact.ts`, add one rule to `COMPACT_SYSTEM` between the current rules 4 and 5, and renumber:

```ts
  "5. A <skill name=\"…\"> block is loaded instructions, not conversation. Record which skills were loaded and any decision made because of them — never copy the skill text itself.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/compact.test.ts` → PASS

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/core/compact.ts test/compact.test.ts
git commit -m "feat(compact): record loaded skills instead of copying their text"
```

---

## Task 9: TUI — skill picker and autocomplete

**Files:**
- Modify: `src/tui/complete.ts` (`skillSuggestions`, around line 155)
- Test: `test/complete.test.ts`

**Interfaces:**
- Consumes: `discoverSkills` returning namespaced skills
- Produces: skill suggestions whose `value` is `/id `

- [ ] **Step 1: Write the failing tests**

```ts
test("memilih skill menyisipkan commandnya, bukan kalimat tentang skill itu", () => {
  // Sebelumnya menyisipkan: Use the "X" skill. — kalimat yang harus dipahami
  // model, bukan perintah yang pasti dijalankan.
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: skillDir, as: "ns" }] },
  })
  const [item] = skillSuggestions(config, cwd, "")

  assert.equal(item?.label, "/ns:a")
  assert.equal(item?.value, "/ns:a ")
})

test("mengetik namespace mempersempit ke plugin itu saja", () => {
  const config = Config.parse({
    skills: { discover: [], paths: [{ path: skillDir, as: "ns" }, { path: lainDir, as: "lain" }] },
  })
  const hasil = skillSuggestions(config, cwd, "ns:")
  assert.ok(hasil.every((item) => item.label.startsWith("/ns:")))
  assert.ok(hasil.length > 0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/complete.test.ts`
Expected: FAIL — label is `a`, not `/ns:a`

- [ ] **Step 3: Implement**

In `src/tui/complete.ts`, change `skillSuggestions` so each entry becomes:

```ts
  return discoverSkills(config, cwd)
    .filter((skill) => skill.id.toLowerCase().includes(query.toLowerCase()))
    .map((skill) => ({
      kind: "skill" as const,
      // Yang disisipkan adalah COMMAND-nya. Kalimat "Use the X skill" harus
      // ditafsirkan model dan bisa diabaikan; command selalu dijalankan.
      value: `/${skill.id} `,
      label: `/${skill.id}`,
      detail: skill.description,
    }))
```

Then in `src/tui/app.tsx`, the `item.kind === "skill"` branch of `runSuggestion` currently builds `Use the "${item.value}" skill. ` — replace its body with the same insertion the file-completion path uses: set the draft to `item.value` and place the cursor at its end.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/complete.test.ts` → PASS, then `npm test` → all green.

- [ ] **Step 5: Commit** *(only with user approval)*

```bash
git add src/tui/complete.ts src/tui/app.tsx test/complete.test.ts
git commit -m "feat(tui): skill picker inserts the skill command"
```

---

## Task 10: Report skills in `doctor` and `/skills`

**Files:**
- Modify: `src/cli.ts` (the `doctor` command), `src/core/agent.ts` (`renderSkills`)
- Test: `test/cli-doctor.test.ts`

**Interfaces:**
- Consumes: `buildSkillIndex`, `skillById`
- Produces: `renderSkillReport(config: Config, cwd: string, home?: string): string` exported from `src/core/skill.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
  assert.match(renderSkillReport(config, root), /ns:hilang/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-doctor.test.ts`
Expected: FAIL — `renderSkillReport is not a function`

- [ ] **Step 3: Implement**

Add to `src/core/skill.ts`:

```ts
/**
 * Ringkasan keadaan skill untuk `titah doctor` dan `/skills`.
 *
 * Konflik dan `always` yang menggantung ditampilkan di sini karena keduanya
 * dilewati diam-diam saat sesi berjalan — kalau tidak pernah muncul di mana pun,
 * user tidak punya cara menemukan konfigurasinya salah.
 */
export function renderSkillReport(config: Config, cwd: string, home?: string): string {
  const index = buildSkillIndex(config, cwd, home)
  const perNamespace = new Map<string, number>()
  for (const skill of index.skills) {
    perNamespace.set(skill.namespace, (perNamespace.get(skill.namespace) ?? 0) + 1)
  }

  const lines = [`Skills: ${index.skills.length} from ${perNamespace.size} namespaces`]
  for (const [namespace, count] of [...perNamespace].sort()) {
    lines.push(`  ${namespace.padEnd(24)} ${count} skill${count === 1 ? "" : "s"}`)
  }

  if (index.conflicts.length > 0) {
    lines.push(`  ${index.conflicts.length} conflict${index.conflicts.length === 1 ? "" : "s"}:`)
    for (const conflict of index.conflicts) {
      lines.push(`    ${conflict.id}: kept ${conflict.kept}, ignored ${conflict.dropped}`)
    }
  }

  const missing = config.skills.always.filter((id) => !skillById(index.skills, id))
  if (missing.length > 0) {
    lines.push(`  always, not found: ${missing.join(", ")}`)
  }

  return lines.join("\n")
}
```

Call it from `doctor` in `src/cli.ts` (append its output to the existing report), and from `renderSkills` in `src/core/agent.ts` so `/skills` shows the same information above the skill list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/cli-doctor.test.ts` → PASS, then the full suite: `npm run typecheck && npm run build && npm test` → all green.

- [ ] **Step 5: Update the README**

Add a "Skills" section documenting `discover`, `paths`, `always`, the `plugin:skill` naming rule, the folder-name namespace rule, and the two corrections from the spec (opencode plugins are JavaScript and are not supported; a skill cannot open a browser).

- [ ] **Step 6: Commit** *(only with user approval)*

```bash
git add src/core/skill.ts src/cli.ts src/core/agent.ts README.md test/cli-doctor.test.ts
git commit -m "feat(doctor): report skill namespaces, conflicts, and dangling always entries"
```

---

## Manual verification

After Task 10, with the real plugin cache present:

```bash
npm run build
node dist/cli.js doctor
```

Expected: `superpowers` 14 skills, `mattpocock-skills` 35, `opencode` 7, 0 conflicts.

```bash
node dist/cli.js
# then, in the TUI:
/skills                          # all 56 listed with fully qualified ids
/superpowers:brainstorming halo  # transcript shows the command; model receives the body
```

The transcript should show the `┌─ command` block containing what was typed, **not** the 9 KB body.
