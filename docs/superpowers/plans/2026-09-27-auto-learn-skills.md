# Auto-learn skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a substantial, successful turn, one small-model call decides whether the work is a reusable procedure and, if so, Titah writes `~/.config/titah/skills/learned/<name>/SKILL.md` on its own.

**Architecture:** A new module `src/core/learn.ts` holds everything: a pure gate, a digest builder, decision parsing, validation, an atomic writer, and a detached `startReflection()` that `agent.ts` calls from the turn's `finally`. Discovery adds the learned directory as a skill source with namespace `learned`. No permission dialog — like `memory`, it is Titah writing to its own directory.

**Tech Stack:** TypeScript (Node ≥ 22.6, run directly with type stripping), zod schemas, AI SDK `streamText`, `node:test`, `MockLanguageModelV4` from `ai/test`.

**Spec:** `docs/superpowers/specs/2026-09-27-auto-learn-skills-design.md`

## Global Constraints

- `skills.learn.enabled` defaults to `false`; `minTools` defaults to `8`; `max` defaults to `30`.
- Learned skills live at `path.join(configDir(), "skills", "learned", <name>, "SKILL.md")`; namespace `learned`.
- Name rule: `^[a-z0-9][a-z0-9-]{1,48}$`. Description 1–160 chars, single line. Body 1 byte – 8 KiB (8192 bytes UTF-8).
- Digest cap: 24,000 characters. User request cap 2,000 chars; final answer cap 2,000 chars; each tool input summary cap 200 chars.
- Frontmatter marker: `source: titah-learn`. Only files carrying it may be updated.
- Model: `summariserModelFor(config, turnModel)` (= `smallModel ?? turnModel ?? model`), called with `streamText`, never `generateText`.
- Log file: `path.join(configDir(), "learn.log")`, one line per reflection: ISO timestamp, session id, outcome, reason, `in=<n> out=<n>`.
- Notice text: `Learned a skill: learned:<name> → <file>` / `Updated learned skill: learned:<name> → <file>`.
- Tests isolate `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `TITAH_DB`, `HOME` in a temp dir **before** importing anything from `src/`.
- Comments in `src/` are written in Indonesian, like the surrounding code. Test names are Indonesian sentences.
- Run a single test file with `node --test test/<file>.test.ts`; the full suite with `npm test`; types with `npm run typecheck`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/schema.ts` (modify) | `skills.learn` config |
| `src/core/paths.ts` (modify) | `learnedSkillsDir()`, `learnLogFile()` |
| `src/core/skill.ts` (modify) | `Skill.source`; `scanSource` skips excluded roots; `buildSkillIndex` passes other roots |
| `src/core/skill-sources.ts` (modify) | learned directory as a source when enabled |
| `src/core/learn.ts` (create) | gate, digest, decision, validation, write, reflection runner |
| `src/core/agent.ts` (modify) | cancel on new turn; start reflection in `finally` |
| `src/cli.ts` (modify) | `doctor` line |
| `config.schema.json` (regenerate) | `npm run schema` |
| `test/learn.test.ts` (create) | unit tests for `learn.ts` |
| `test/skill.test.ts` (modify) | nested-root and `source` tests |
| `test/agent-learn.test.ts` (create) | end-to-end through `prompt()` |
| `docs/skills-learn.md` (create), `CHANGELOG.md` (modify) | user docs |

---

### Task 1: Config and paths

**Files:**
- Modify: `src/core/schema.ts:303-316` (the `Skills` object)
- Modify: `src/core/paths.ts` (after `globalConfigFile`)
- Regenerate: `config.schema.json`
- Test: `test/learn.test.ts` (create)

**Interfaces:**
- Produces: `config.skills.learn: { enabled: boolean; minTools: number; max: number }`; `learnedSkillsDir(): string`; `learnLogFile(): string`.

- [ ] **Step 1: Write the failing test**

Create `test/learn.test.ts`:

```ts
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

/**
 * HOME diisolasi SEBELUM impor apa pun dari src/: modul ini menulis ke
 * configDir(), dan tanpa isolasi test-nya menaruh skill di mesin siapa pun
 * yang menjalankannya.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-learn-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.TITAH_DB = path.join(root, "learn.db")
process.env.HOME = path.join(root, "home")

const { Config } = await import("../src/core/schema.ts")
const { learnedSkillsDir, learnLogFile } = await import("../src/core/paths.ts")

beforeEach(() => {
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

// ---------- config ----------

test("belajar skill MATI secara bawaan, dengan ambang 8 tool dan plafon 30", () => {
  assert.deepEqual(Config.parse({}).skills.learn, { enabled: false, minTools: 8, max: 30 })
})

test("skill yang dipelajari tinggal di folder config, bukan di repo", () => {
  assert.equal(learnedSkillsDir(), path.join(root, "config", "titah", "skills", "learned"))
  assert.equal(learnLogFile(), path.join(root, "config", "titah", "learn.log"))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/learn.test.ts`
Expected: FAIL — `learnedSkillsDir` is not exported / `skills.learn` is `undefined`.

- [ ] **Step 3: Implement**

In `src/core/schema.ts`, add a `learn` field to `Skills` after `always`:

```ts
  always: z
    .array(z.string())
    .default([])
    .describe('Skill ids loaded in full every turn, e.g. "superpowers:using-superpowers"'),
  /*
   * Titah menulis skill sendiri sesudah giliran yang substansial.
   *
   * # Kenapa bawaannya MATI
   *
   * Setiap giliran yang lolos saringan membayar satu panggilan model tanpa
   * ditanya. Aturan yang sama dengan `continueTurns` dan `tracking.sync`: sumbu
   * yang membelanjakan uang tidak menyala sendiri.
   */
  learn: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe("Write reusable skills automatically after substantial turns"),
      minTools: z
        .number()
        .int()
        .min(1)
        .default(8)
        .describe("Tool calls a turn needs before it is considered for a skill"),
      max: z
        .number()
        .int()
        .min(1)
        .default(30)
        .describe("Cap on learned skills; at the cap existing ones are still updated"),
    })
    .default({ enabled: false, minTools: 8, max: 30 })
    .describe("Automatic skills, written to ~/.config/titah/skills/learned/"),
```

In `src/core/paths.ts`, after `globalConfigFile`:

```ts
/** Skill yang Titah tulis sendiri — lihat `src/core/learn.ts`. */
export const learnedSkillsDir = (): string => path.join(configDir(), "skills", "learned")

/** Satu baris per refleksi: hasil, alasan, dan token yang dipakai. */
export const learnLogFile = (): string => path.join(configDir(), "learn.log")
```

- [ ] **Step 4: Regenerate the JSON schema and run the test**

Run: `npm run schema && node --test test/learn.test.ts`
Expected: PASS (2 tests). `git diff --stat config.schema.json` shows it changed.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts src/core/paths.ts config.schema.json test/learn.test.ts
git commit -m "feat(learn): skills.learn config and paths"
```

---

### Task 2: Discovery — `source` field, nested roots, learned source

**Files:**
- Modify: `src/core/skill.ts` (`Skill`, `readSkill`, `scanSource`, `buildSkillIndex`)
- Modify: `src/core/skill-sources.ts` (`allSources`)
- Test: `test/skill.test.ts` (append)

**Interfaces:**
- Consumes: `config.skills.learn.enabled`, `learnedSkillsDir()` (Task 1).
- Produces: `Skill.source?: string`; `scanSource(source: SkillSource, exclude?: ReadonlySet<string>): Skill[]`; `LEARNED_NAMESPACE = "learned"` exported from `skill-sources.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/skill.test.ts`:

```ts
test("frontmatter `source` ikut terbaca ke Skill", () => {
  const root = tree({ "a/SKILL.md": "---\nname: a\ndescription: d\nsource: titah-learn\n---\nisi" })
  const [skill] = scanSource({ root, namespace: "x" })
  assert.equal(skill?.source, "titah-learn")
})

test("sumber tidak memindai masuk ke root milik sumber lain", () => {
  /*
   * ~/.config/titah/skills terdaftar sebagai "titah" DAN learned/ di dalamnya
   * terdaftar sebagai "learned". Tanpa pengecualian, setiap skill yang dipelajari
   * muncul dua kali: titah:x dan learned:x.
   */
  const root = tree({
    "mine/SKILL.md": "---\nname: mine\n---\nisi",
    "learned/x/SKILL.md": "---\nname: x\n---\nisi",
  })
  const config = Config.parse({
    skills: {
      discover: [],
      paths: [
        { path: root, as: "titah" },
        { path: path.join(root, "learned"), as: "learned" },
      ],
    },
  })
  const ids = buildSkillIndex(config, root, root).skills.map((s) => s.id)
  assert.deepEqual(ids, ["learned:x", "titah:mine"])
})

test("folder learned jadi sumber hanya kalau skills.learn menyala", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-skill-home-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = path.join(home, "config")
  try {
    const dir = path.join(home, "config", "titah", "skills", "learned", "deploy")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: deploy\ndescription: d\n---\nisi")

    const off = Config.parse({ skills: { discover: [] } })
    const on = Config.parse({ skills: { discover: [], learn: { enabled: true } } })
    assert.deepEqual(buildSkillIndex(off, home, home).skills.map((s) => s.id), [])
    assert.deepEqual(buildSkillIndex(on, home, home).skills.map((s) => s.id), ["learned:deploy"])
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/skill.test.ts`
Expected: the three new tests FAIL (`source` undefined; `titah:x` present; `learned:deploy` missing).

- [ ] **Step 3: Implement**

`src/core/skill.ts` — add to `Skill`:

```ts
  file: string
  /**
   * Siapa yang menulis berkasnya, dari frontmatter `source:`. Hanya dipakai
   * untuk satu keputusan: `learn.ts` boleh menimpa skill yang `source`-nya
   * `titah-learn`, dan tidak boleh menyentuh yang lain.
   */
  source?: string
```

In `readSkill`, return `source` when present:

```ts
  return {
    id: `${namespace}:${name}`,
    namespace,
    name,
    description: fields["description"] ?? "",
    body: body.trim(),
    file,
    ...(fields["source"] ? { source: fields["source"] } : {}),
  }
```

Change `scanSource` to take an exclusion set and skip those directories:

```ts
/**
 * Semua skill di dalam satu sumber, dipindai sampai ke sub-direktori terdalam.
 *
 * `exclude` berisi root sumber LAIN. Pemindaian rekursif tidak boleh masuk ke
 * sana: direktori itu milik sumber lain dengan namespace-nya sendiri, dan
 * memindainya dua kali membuat setiap skill di dalamnya terdaftar dua kali.
 */
export function scanSource(source: SkillSource, exclude: ReadonlySet<string> = new Set()): Skill[] {
```

and inside `walk`, at the top of the `if (entry.isDirectory())` branch:

```ts
      if (entry.isDirectory()) {
        if (exclude.has(path.resolve(full))) continue
```

In `buildSkillIndex`, compute the roots once and pass the others:

```ts
  const sources = allSources(config, cwd, home)
  const roots = sources.map((source) => path.resolve(source.root))

  for (const source of sources) {
    const own = path.resolve(source.root)
    const skills = scanSource(source, new Set(roots.filter((root) => root !== own)))
```

(replacing `for (const source of allSources(config, cwd, home)) {` and `const skills = scanSource(source)`).

`src/core/skill-sources.ts` — add import and constant, and include the learned source:

```ts
import { learnedSkillsDir } from "./paths.ts"

/** Namespace skill yang ditulis `learn.ts`. */
export const LEARNED_NAMESPACE = "learned"
```

In `allSources`:

```ts
  // Sesudah milik user (yang selalu menang), sebelum hasil auto-deteksi.
  const learned: SkillSource[] = config.skills.learn.enabled
    ? [{ root: learnedSkillsDir(), namespace: LEARNED_NAMESPACE }]
    : []
  const combined = [...configSources(config, cwd), ...learned, ...auto]
```

- [ ] **Step 4: Run tests**

Run: `node --test test/skill.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/skill.ts src/core/skill-sources.ts test/skill.test.ts
git commit -m "feat(learn): learned skills as a source; sources never scan into each other"
```

---

### Task 3: Gate and digest

**Files:**
- Create: `src/core/learn.ts`
- Test: `test/learn.test.ts` (append)

**Interfaces:**
- Consumes: `Part` from `src/core/message.ts`.
- Produces:
  ```ts
  export interface GateInput { enabled: boolean; isChild: boolean; aborted: boolean; failed: boolean; stoppedAtLimit: boolean; willContinue: boolean; toolCalls: number; minTools: number }
  export function shouldReflect(input: GateInput): boolean
  export function countToolCalls(parts: readonly Part[]): number
  export interface LearnedSummary { name: string; description: string }
  export function buildDigest(input: { request: string; parts: readonly Part[]; learned: readonly LearnedSummary[] }): string
  export const DIGEST_CAP = 24_000
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/learn.test.ts` (add the import next to the others at the top):

```ts
const { buildDigest, countToolCalls, DIGEST_CAP, shouldReflect } = await import("../src/core/learn.ts")
```

```ts
// ---------- saringan ----------

const PASSING = {
  enabled: true,
  isChild: false,
  aborted: false,
  failed: false,
  stoppedAtLimit: false,
  willContinue: false,
  toolCalls: 8,
  minTools: 8,
}

test("giliran yang lolos semua syarat memicu refleksi", () => {
  assert.equal(shouldReflect(PASSING), true)
})

test("setiap syarat yang gagal, sendirian, mencegah refleksi", () => {
  const failing: Partial<typeof PASSING>[] = [
    { enabled: false },
    { isChild: true },
    { aborted: true },
    { failed: true },
    { stoppedAtLimit: true },
    { willContinue: true },
    { toolCalls: 7 },
  ]
  for (const change of failing) {
    assert.equal(shouldReflect({ ...PASSING, ...change }), false, JSON.stringify(change))
  }
})

function toolPart(tool: string, input: unknown, status: "done" | "error" = "done") {
  const state =
    status === "done"
      ? { status, input, output: "ok", truncated: false, started: 0, ended: 1 }
      : { status, input, error: "boom", started: 0, ended: 1 }
  return { type: "tool" as const, callID: `c-${tool}`, tool, state }
}

test("hanya part tool yang dihitung sebagai tool call", () => {
  const parts = [{ type: "text" as const, text: "x" }, toolPart("bash", {}), toolPart("read", {})]
  assert.equal(countToolCalls(parts as never), 2)
})

// ---------- digest ----------

test("digest memuat permintaan, urutan tool, jawaban akhir, dan skill yang ada", () => {
  const digest = buildDigest({
    request: "deploy ke staging",
    parts: [
      toolPart("bash", { command: "npm run build" }),
      toolPart("bash", { command: "rsync dist/ staging:" }, "error"),
      { type: "text", text: "Sudah terdeploy." },
    ] as never,
    learned: [{ name: "deploy-prod", description: "Use when deploying to prod" }],
  })
  assert.match(digest, /deploy ke staging/)
  assert.match(digest, /1\. bash \{"command":"npm run build"\} → ok/)
  assert.match(digest, /2\. bash \{"command":"rsync dist\/ staging:"\} → error/)
  assert.match(digest, /Sudah terdeploy\./)
  assert.match(digest, /deploy-prod: Use when deploying to prod/)
})

test("digest dibatasi, dan yang dibuang adalah tool di TENGAH", () => {
  const parts = Array.from({ length: 400 }, (_, i) => toolPart("bash", { command: `step-${i} ${"x".repeat(150)}` }))
  const digest = buildDigest({ request: "r", parts: parts as never, learned: [] })
  assert.ok(digest.length <= DIGEST_CAP, `${digest.length}`)
  assert.match(digest, /step-0 /)
  assert.match(digest, /step-399 /)
  assert.match(digest, /tool calls omitted/)
})

test("permintaan dan jawaban panjang dipotong di 2.000 karakter", () => {
  const digest = buildDigest({
    request: "a".repeat(5000),
    parts: [{ type: "text", text: "b".repeat(5000) }] as never,
    learned: [],
  })
  assert.ok(!digest.includes("a".repeat(2001)))
  assert.ok(!digest.includes("b".repeat(2001)))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/learn.test.ts`
Expected: FAIL — cannot find module `../src/core/learn.ts`.

- [ ] **Step 3: Implement**

Create `src/core/learn.ts`:

```ts
import type { Part } from "./message.ts"

/**
 * Titah menulis skill sendiri sesudah giliran yang substansial.
 *
 * Alurnya: saringan murni (`shouldReflect`) → digest ringkas (`buildDigest`) →
 * satu panggilan model kecil → validasi → tulis atomik. Semua keputusan yang
 * bisa diuji tanpa model ada di fungsi murni di berkas ini; `startReflection`
 * hanya merangkainya.
 *
 * # Kenapa digest, bukan transkrip
 *
 * Transkrip giliran yang lolos saringan (≥ 8 tool call) bisa ratusan ribu
 * token — persis biaya yang fitur ini tidak boleh tambahkan. Yang dibutuhkan
 * untuk menilai "apakah ini prosedur" adalah urutan langkahnya, bukan isi
 * setiap keluaran tool.
 */

export interface GateInput {
  enabled: boolean
  isChild: boolean
  aborted: boolean
  failed: boolean
  stoppedAtLimit: boolean
  willContinue: boolean
  toolCalls: number
  minTools: number
}

/**
 * Semua syarat harus terpenuhi. Prosedur yang gagal, terpotong batas, atau
 * belum selesai bukan prosedur yang layak diulang; sub-agent melapor ke induk
 * yang bisa belajar sendiri; dan giliran pendek tidak boleh membayar apa pun.
 */
export function shouldReflect(input: GateInput): boolean {
  return (
    input.enabled &&
    !input.isChild &&
    !input.aborted &&
    !input.failed &&
    !input.stoppedAtLimit &&
    !input.willContinue &&
    input.toolCalls >= input.minTools
  )
}

export function countToolCalls(parts: readonly Part[]): number {
  return parts.filter((part) => part.type === "tool").length
}

export interface LearnedSummary {
  name: string
  description: string
}

export const DIGEST_CAP = 24_000
const REQUEST_CAP = 2_000
const ANSWER_CAP = 2_000
const TOOL_INPUT_CAP = 200

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`
}

function toolLine(index: number, part: Extract<Part, { type: "tool" }>): string {
  const input = clip(JSON.stringify(part.state.input ?? {}) ?? "{}", TOOL_INPUT_CAP)
  const outcome = part.state.status === "done" ? "ok" : part.state.status
  return `${index + 1}. ${part.tool} ${input} → ${outcome}`
}

/**
 * Ringkasan giliran untuk model penilai.
 *
 * Kalau melebihi batas, tool di TENGAH yang dibuang dan diganti satu baris:
 * awal dan akhir sebuah prosedur memuat informasi terbanyak — persiapan dan
 * verifikasi — sementara bagian tengahnya paling sering berupa pengulangan.
 */
export function buildDigest(input: {
  request: string
  parts: readonly Part[]
  learned: readonly LearnedSummary[]
}): string {
  const tools = input.parts.filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
  const answer = input.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  const learned = input.learned.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")

  const head = `## User request\n${clip(input.request.trim(), REQUEST_CAP)}\n\n## Tool calls\n`
  const tail =
    `\n\n## Final answer\n${clip(answer, ANSWER_CAP) || "(none)"}` +
    `\n\n## Existing learned skills\n${learned || "(none)"}\n`

  const lines = tools.map((part, index) => toolLine(index, part))
  const room = DIGEST_CAP - head.length - tail.length
  const joined = lines.join("\n")
  if (joined.length <= room) return head + joined + tail

  // Ambil dari kedua ujung bergantian sampai ruangnya habis.
  const kept = { start: [] as string[], end: [] as string[] }
  let used = 0
  const marker = (omitted: number) => `… ${omitted} tool calls omitted …`
  const reserve = marker(lines.length).length + 2
  for (let i = 0, j = lines.length - 1; i <= j; ) {
    const next = kept.start.length <= kept.end.length ? lines[i] : lines[j]
    if (next === undefined || used + next.length + 1 > room - reserve) break
    if (kept.start.length <= kept.end.length) {
      kept.start.push(next)
      i += 1
    } else {
      kept.end.unshift(next)
      j -= 1
    }
    used += next.length + 1
  }
  const omitted = lines.length - kept.start.length - kept.end.length
  return head + [...kept.start, marker(omitted), ...kept.end].join("\n") + tail
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/learn.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/learn.ts test/learn.test.ts
git commit -m "feat(learn): gate and digest"
```

---

### Task 4: Decision parsing, validation, and the atomic writer

**Files:**
- Modify: `src/core/learn.ts`
- Test: `test/learn.test.ts` (append)

**Interfaces:**
- Consumes: `parseStructured` (`src/core/output.ts`), `parseFrontmatter`, `scanSource` (`src/core/skill.ts`), `learnedSkillsDir` (Task 1).
- Produces:
  ```ts
  export type Decision = { action: "none" } | { action: "create" | "update"; name: string; description: string; body: string }
  export function parseDecision(text: string): Decision
  export interface LearnedSkill { name: string; description: string; file: string; source?: string }
  export function listLearned(dir?: string): LearnedSkill[]
  export function validateLearned(decision: Exclude<Decision, { action: "none" }>, existing: readonly LearnedSkill[], max: number): string | undefined   // reason, or undefined when valid
  export function writeLearned(decision: Exclude<Decision, { action: "none" }>, sessionID: string, dir?: string, now?: Date): string   // returns the file written
  export const LEARN_SOURCE = "titah-learn"
  ```

- [ ] **Step 1: Write the failing tests**

Add to the import at the top of `test/learn.test.ts`:

```ts
const { LEARN_SOURCE, listLearned, parseDecision, validateLearned, writeLearned } = await import("../src/core/learn.ts")
```

Append:

```ts
// ---------- keputusan ----------

test("JSON berpagar diurai; sampah dibaca sebagai none", () => {
  const fenced = '```json\n{"action":"create","name":"a-b","description":"d","body":"b"}\n```'
  assert.deepEqual(parseDecision(fenced), { action: "create", name: "a-b", description: "d", body: "b" })
  assert.deepEqual(parseDecision("bukan json"), { action: "none" })
  assert.deepEqual(parseDecision('{"action":"delete"}'), { action: "none" })
  assert.deepEqual(parseDecision('{"action":"create","name":1}'), { action: "none" })
})

// ---------- validasi ----------

const GOOD = { action: "create" as const, name: "deploy-sims", description: "Use when deploying SIMS", body: "1. build\n2. ship" }

test("keputusan yang baik lolos validasi", () => {
  assert.equal(validateLearned(GOOD, [], 30), undefined)
})

test("nama, deskripsi, dan body yang berbahaya ditolak", () => {
  const bad: Partial<typeof GOOD>[] = [
    { name: "../evil" },
    { name: "a/b" },
    { name: "Deploy" },
    { name: "a.b" },
    { name: "a" },
    { name: "x".repeat(50) },
    { description: "" },
    { description: "x".repeat(161) },
    { description: "dua\nbaris" },
    { body: "" },
    { body: "x".repeat(8193) },
  ]
  for (const change of bad) {
    assert.equal(typeof validateLearned({ ...GOOD, ...change }, [], 30), "string", JSON.stringify(change))
  }
})

test("bentuk rahasia yang umum ditolak", () => {
  const secrets = [
    "export KEY=sk-ant-api03-abcdefghijklmnopqrstuv",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "password=hunter2",
    "token: 9f8e7d6c5b4a",
  ]
  for (const secret of secrets) {
    assert.match(validateLearned({ ...GOOD, body: `langkah\n${secret}` }, [], 30) ?? "", /secret/, secret)
  }
})

test("plafon menolak create, tapi update tetap boleh", () => {
  const existing = [{ name: "deploy-sims", description: "d", file: "/x", source: LEARN_SOURCE }]
  assert.match(validateLearned({ ...GOOD, name: "lain" }, existing, 1) ?? "", /cap/)
  assert.equal(validateLearned({ ...GOOD, action: "update" }, existing, 1), undefined)
})

test("update hanya untuk skill milik Titah yang sudah ada", () => {
  const userWritten = [{ name: "deploy-sims", description: "d", file: "/x" }]
  assert.match(validateLearned({ ...GOOD, action: "update" }, userWritten, 30) ?? "", /not written by Titah/)
  assert.match(validateLearned({ ...GOOD, action: "update" }, [], 30) ?? "", /does not exist/)
  const mine = [{ name: "deploy-sims", description: "d", file: "/x", source: LEARN_SOURCE }]
  assert.match(validateLearned(GOOD, mine, 30) ?? "", /already exists/)
})

// ---------- menulis ----------

test("tulis atomik dengan frontmatter lengkap, lalu terbaca lagi", () => {
  const file = writeLearned(GOOD, "ses_1", undefined, new Date("2026-09-27T10:00:00Z"))
  assert.equal(file, path.join(learnedSkillsDir(), "deploy-sims", "SKILL.md"))
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /^---\nname: deploy-sims\ndescription: Use when deploying SIMS\nsource: titah-learn\n/)
  assert.match(text, /created: 2026-09-27T10:00:00.000Z\nupdated: 2026-09-27T10:00:00.000Z\nsession: ses_1\n---\n/)
  assert.match(text, /1\. build\n2\. ship\n$/)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["SKILL.md"], "tidak ada berkas .tmp tertinggal")
  assert.deepEqual(listLearned().map((s) => [s.name, s.source]), [["deploy-sims", LEARN_SOURCE]])
})

test("update mempertahankan created dan menaikkan updated", () => {
  writeLearned(GOOD, "ses_1", undefined, new Date("2026-09-27T10:00:00Z"))
  const file = writeLearned({ ...GOOD, action: "update", body: "baru" }, "ses_2", undefined, new Date("2026-09-28T10:00:00Z"))
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /created: 2026-09-27T10:00:00.000Z/)
  assert.match(text, /updated: 2026-09-28T10:00:00.000Z/)
  assert.match(text, /session: ses_2/)
  assert.match(text, /baru\n$/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/learn.test.ts`
Expected: FAIL — `parseDecision` is not a function.

- [ ] **Step 3: Implement**

Append to `src/core/learn.ts` (and merge the imports at the top):

```ts
import fs from "node:fs"
import path from "node:path"
import { parseStructured } from "./output.ts"
import { learnedSkillsDir } from "./paths.ts"
import { parseFrontmatter, scanSource } from "./skill.ts"
```

```ts
/** Penanda frontmatter: satu-satunya izin untuk menimpa sebuah skill. */
export const LEARN_SOURCE = "titah-learn"

export type Decision =
  | { action: "none" }
  | { action: "create" | "update"; name: string; description: string; body: string }

type Write = Exclude<Decision, { action: "none" }>

/** Apa pun yang tidak berbentuk keputusan yang sah dibaca sebagai "none" — diam adalah jawaban aman. */
export function parseDecision(text: string): Decision {
  const { value } = parseStructured(text)
  if (typeof value !== "object" || value === null) return { action: "none" }
  const v = value as Record<string, unknown>
  if (v.action !== "create" && v.action !== "update") return { action: "none" }
  if (typeof v.name !== "string" || typeof v.description !== "string" || typeof v.body !== "string") {
    return { action: "none" }
  }
  return { action: v.action, name: v.name, description: v.description, body: v.body }
}

export interface LearnedSkill {
  name: string
  description: string
  file: string
  source?: string
}

export function listLearned(dir = learnedSkillsDir()): LearnedSkill[] {
  return scanSource({ root: dir, namespace: "learned" }).map((skill) => ({
    name: skill.name,
    description: skill.description,
    file: skill.file,
    ...(skill.source ? { source: skill.source } : {}),
  }))
}

const NAME = /^[a-z0-9][a-z0-9-]{1,48}$/
const MAX_BODY_BYTES = 8 * 1024

/**
 * Bentuk rahasia yang paling umum. Bukan pemindai lengkap — tujuannya menangkap
 * kecelakaan yang paling mungkin: model menyalin baris `export KEY=...` dari
 * keluaran tool ke dalam langkah-langkah skill.
 */
const SECRETS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"<>{}]{4,}/i,
]

/** Alasan penolakan, atau `undefined` kalau keputusannya boleh ditulis. */
export function validateLearned(decision: Write, existing: readonly LearnedSkill[], max: number): string | undefined {
  if (!NAME.test(decision.name)) return `invalid name "${decision.name}"`
  const description = decision.description.trim()
  if (description === "" || description.length > 160 || /[\r\n]/.test(description)) {
    return "description must be one line of 1–160 characters"
  }
  const bytes = Buffer.byteLength(decision.body, "utf8")
  if (decision.body.trim() === "" || bytes > MAX_BODY_BYTES) return `body is ${bytes} bytes (limit ${MAX_BODY_BYTES})`
  const text = `${decision.description}\n${decision.body}`
  if (SECRETS.some((pattern) => pattern.test(text))) return "looks like it contains a secret"

  const current = existing.find((skill) => skill.name === decision.name)
  if (decision.action === "create") {
    if (current) return `"${decision.name}" already exists; use update`
    if (existing.length >= max) return `at the cap of ${max} learned skills`
    return undefined
  }
  if (!current) return `"${decision.name}" does not exist`
  if (current.source !== LEARN_SOURCE) return `"${decision.name}" was not written by Titah`
  return undefined
}

/**
 * Menulis SKILL.md secara atomik. Pemanggil WAJIB sudah memvalidasi keputusannya.
 *
 * Tulis-lalu-rename: Titah yang membaca indeks skill di tengah penulisan tidak
 * pernah melihat berkas setengah jadi.
 */
export function writeLearned(decision: Write, sessionID: string, dir = learnedSkillsDir(), now = new Date()): string {
  const folder = path.join(dir, decision.name)
  const file = path.join(folder, "SKILL.md")

  let created = now.toISOString()
  if (decision.action === "update") {
    try {
      created = parseFrontmatter(fs.readFileSync(file, "utf8")).fields["created"] ?? created
    } catch {
      // Berkas hilang di antara validasi dan tulis: tulis sebagai baru.
    }
  }

  const content =
    "---\n" +
    `name: ${decision.name}\n` +
    `description: ${decision.description.trim()}\n` +
    `source: ${LEARN_SOURCE}\n` +
    `created: ${created}\n` +
    `updated: ${now.toISOString()}\n` +
    `session: ${sessionID}\n` +
    "---\n\n" +
    `${decision.body.trim()}\n`

  fs.mkdirSync(folder, { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, "utf8")
  fs.renameSync(temporary, file)
  return file
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/learn.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/learn.ts test/learn.test.ts
git commit -m "feat(learn): decision parsing, validation, atomic writer"
```

---

### Task 5: The reflection runner

**Files:**
- Modify: `src/core/learn.ts`
- Test: `test/learn.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 3–4; `bus` (`src/core/event.ts`); `learnLogFile` (Task 1); `streamText` and `LanguageModel` from `ai`.
- Produces:
  ```ts
  export const LEARN_SYSTEM: string
  export interface ReflectionInput { sessionID: string; streamSessionID: string; request: string; parts: readonly Part[]; model: LanguageModel; max: number }
  export function startReflection(input: ReflectionInput): void
  export function cancelReflection(sessionID: string): void
  export function reflectionDone(sessionID: string): Promise<void>   // resolves immediately when none is running
  ```

- [ ] **Step 1: Write the failing tests**

Add imports at the top of `test/learn.test.ts`:

```ts
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
const { bus } = await import("../src/core/event.ts")
const { cancelReflection, LEARN_SYSTEM, reflectionDone, startReflection } = await import("../src/core/learn.ts")
```

Append:

```ts
// ---------- refleksi ----------

const USAGE = {
  inputTokens: { total: 1200, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 80, text: undefined, reasoning: undefined },
}

function answering(text: string): { model: MockLanguageModelV4; systems: string[] } {
  const systems: string[] = []
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt.find((m) => m.role === "system")
      if (system && typeof system.content === "string") systems.push(system.content)
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ],
        }),
      }
    },
  })
  return { model, systems }
}

/**
 * `bus.subscribe` mengembalikan AsyncIterable. Event didorong sinkron ke
 * buffer, tapi loop `for await` baru membacanya di mikrotugas berikutnya —
 * jadi `stop()` memberi satu putaran event loop sebelum berhenti.
 */
function notices(sessionID: string): { messages: string[]; stop: () => Promise<void> } {
  const messages: string[] = []
  const controller = new AbortController()
  void (async () => {
    for await (const event of bus.subscribe({ sessionID, signal: controller.signal, client: false })) {
      if (event.type === "session.notice") messages.push(event.message)
    }
  })()
  return {
    messages,
    stop: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort()
    },
  }
}

const PARTS = [toolPart("bash", { command: "make deploy" }), { type: "text", text: "done" }] as never

test("create menulis skill, memberi satu notice, dan mencatat token di log", async () => {
  const { model, systems } = answering(JSON.stringify(GOOD))
  const seen = notices("ses_r1")
  startReflection({ sessionID: "ses_r1", streamSessionID: "ses_r1", request: "deploy", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r1")
  await seen.stop()

  assert.equal(systems[0], LEARN_SYSTEM)
  assert.ok(fs.existsSync(path.join(learnedSkillsDir(), "deploy-sims", "SKILL.md")))
  assert.equal(seen.messages.length, 1)
  assert.match(seen.messages[0] ?? "", /^Learned a skill: learned:deploy-sims → /)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r1 created deploy-sims .*in=1200 out=80/)
})

test("none tidak menulis apa pun dan tidak memberi notice", async () => {
  const { model } = answering('{"action":"none"}')
  const seen = notices("ses_r2")
  startReflection({ sessionID: "ses_r2", streamSessionID: "ses_r2", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r2")
  await seen.stop()

  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.deepEqual(seen.messages, [])
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r2 none/)
})

test("keputusan yang ditolak validasi dicatat, tidak ditulis", async () => {
  const { model } = answering(JSON.stringify({ ...GOOD, body: "password=hunter2" }))
  startReflection({ sessionID: "ses_r3", streamSessionID: "ses_r3", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r3")
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r3 rejected .*secret/)
})

test("model yang melempar tidak bocor keluar — hanya dicatat", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("provider down")
    },
  })
  startReflection({ sessionID: "ses_r4", streamSessionID: "ses_r4", request: "r", parts: PARTS, model, max: 30 })
  await reflectionDone("ses_r4")
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r4 error .*provider down/)
})

test("refleksi kedua untuk sesi yang sama dilewati selama yang pertama berjalan", async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1
      await gate
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: '{"action":"none"}' },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ],
        }),
      }
    },
  })
  startReflection({ sessionID: "ses_r5", streamSessionID: "ses_r5", request: "r", parts: PARTS, model, max: 30 })
  startReflection({ sessionID: "ses_r5", streamSessionID: "ses_r5", request: "r", parts: PARTS, model, max: 30 })
  release()
  await reflectionDone("ses_r5")
  assert.equal(calls, 1)
})

test("cancelReflection menghentikan refleksi yang sedang berjalan tanpa menulis", async () => {
  const model = new MockLanguageModelV4({
    doStream: async (options) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")))
      }),
  })
  startReflection({ sessionID: "ses_r6", streamSessionID: "ses_r6", request: "r", parts: PARTS, model, max: 30 })
  cancelReflection("ses_r6")
  await reflectionDone("ses_r6")
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
  assert.match(fs.readFileSync(learnLogFile(), "utf8"), /ses_r6 cancelled/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/learn.test.ts`
Expected: FAIL — `startReflection` is not a function.

- [ ] **Step 3: Implement**

Add imports to `src/core/learn.ts`, and extend the existing `./paths.ts` import from Task 4 to `import { learnLogFile, learnedSkillsDir } from "./paths.ts"`:

```ts
import { streamText, type LanguageModel } from "ai"
import { bus } from "./event.ts"
```

Append:

```ts
/**
 * Prompt penilai. Ditulis supaya "none" adalah jawaban yang paling sering:
 * skill yang buruk lebih mahal daripada skill yang tidak ada, karena ia ikut
 * terkirim di katalog setiap langkah sesudahnya.
 */
export const LEARN_SYSTEM = [
  "You decide whether a finished coding-agent turn contains a reusable procedure worth saving as a skill.",
  "Most turns do not. Answer with ONE JSON object and nothing else.",
  "",
  'Save only a multi-step procedure that is likely to recur and is not obvious (a deploy sequence, a project-specific build or test routine, a debugging recipe that worked). Never a single fact — that belongs in memory. Never a one-off task.',
  "Never include secrets, tokens, passwords, private keys, or URLs with credentials.",
  'Use "update" only when an existing learned skill covers the same procedure and this turn improved it; "name" must then be that skill\'s name exactly.',
  "",
  'Shape: {"action":"none"} or {"action":"create"|"update","name":"kebab-case","description":"Use when ... (one line, max 160 chars)","body":"markdown: when to use, numbered steps, pitfalls seen"}',
].join("\n")

interface Running {
  controller: AbortController
  done: Promise<void>
}

const running = new Map<string, Running>()

function log(sessionID: string, outcome: string, detail: string, usage?: { input?: number; output?: number }): void {
  try {
    fs.mkdirSync(path.dirname(learnLogFile()), { recursive: true })
    const tokens = usage ? ` in=${usage.input ?? "?"} out=${usage.output ?? "?"}` : ""
    fs.appendFileSync(learnLogFile(), `${new Date().toISOString()} ${sessionID} ${outcome} ${detail}${tokens}\n`)
  } catch {
    // Log yang gagal ditulis tidak boleh jadi masalah kedua.
  }
}

export interface ReflectionInput {
  sessionID: string
  /** Sesi yang benar-benar didengarkan klien — sama dengan `streamSessionID` di agent.ts. */
  streamSessionID: string
  request: string
  parts: readonly Part[]
  model: LanguageModel
  max: number
}

async function reflect(input: ReflectionInput, signal: AbortSignal): Promise<void> {
  const learned = listLearned()
  const digest = buildDigest({ request: input.request, parts: input.parts, learned })

  // `streamText`, bukan `generateText` — lihat src/core/consensus.ts:152.
  const result = streamText({ model: input.model, system: LEARN_SYSTEM, prompt: digest, abortSignal: signal })
  let text = ""
  for await (const chunk of result.textStream) text += chunk
  const usage = await result.usage
  const tokens = { input: usage.inputTokens, output: usage.outputTokens }

  const decision = parseDecision(text)
  if (decision.action === "none") return log(input.sessionID, "none", "-", tokens)

  const reason = validateLearned(decision, learned, input.max)
  if (reason !== undefined) return log(input.sessionID, "rejected", `${decision.name}: ${reason}`, tokens)

  const file = writeLearned(decision, input.sessionID)
  const verb = decision.action === "create" ? "created" : "updated"
  log(input.sessionID, verb, decision.name, tokens)
  bus.publish({
    type: "session.notice",
    sessionID: input.streamSessionID,
    message:
      decision.action === "create"
        ? `Learned a skill: learned:${decision.name} → ${file}`
        : `Updated learned skill: learned:${decision.name} → ${file}`,
  })
}

/**
 * Menjalankan refleksi TERLEPAS dari giliran: jawaban sudah tampil, dan janji
 * giliran tidak menunggu ini. Tidak pernah melempar.
 */
export function startReflection(input: ReflectionInput): void {
  if (running.has(input.sessionID)) return
  const controller = new AbortController()
  const done = reflect(input, controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted) log(input.sessionID, "cancelled", "-")
      else log(input.sessionID, "error", error instanceof Error ? error.message : String(error))
    })
    .finally(() => running.delete(input.sessionID))
  running.set(input.sessionID, { controller, done })
}

/** Giliran baru di sesi yang sama menang atas refleksi giliran sebelumnya. */
export function cancelReflection(sessionID: string): void {
  running.get(sessionID)?.controller.abort()
}

export function reflectionDone(sessionID: string): Promise<void> {
  return running.get(sessionID)?.done ?? Promise.resolve()
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/learn.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/learn.ts test/learn.test.ts
git commit -m "feat(learn): detached reflection runner with log and notice"
```

---

### Task 6: Wire into the turn

**Files:**
- Modify: `src/core/agent.ts` (imports; start of `prompt()` near line 445; the `finally` near line 1417)
- Test: `test/agent-learn.test.ts` (create)

**Interfaces:**
- Consumes: `shouldReflect`, `countToolCalls`, `startReflection`, `cancelReflection` (Tasks 3, 5); `summariserModelFor` (`src/core/provider.ts`); module-private `resolver` in `agent.ts`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `test/agent-learn.test.ts`:

```ts
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { afterEach, after, beforeEach } from "node:test"
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-agent-learn-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "learn.db")
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession } = await import("../src/core/storage/session.ts")
const { LEARN_SYSTEM, reflectionDone } = await import("../src/core/learn.ts")
const { learnedSkillsDir } = await import("../src/core/paths.ts")

const project = path.join(root, "proyek")
let restore: (() => void) | undefined

const USAGE = {
  inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
}

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "a.txt"), "isi\n")
})

afterEach(() => {
  restore?.()
  restore = undefined
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

function configWith(learn: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(project, "titah.json"),
    JSON.stringify({
      skills: { discover: [], paths: [], learn },
      scaffold: false,
      permission: { bash: "allow", edit: "allow", write: "allow" },
    }),
  )
}

/** Giliran yang membaca `a.txt` sebanyak `reads` kali lalu menjawab; refleksi menjawab `decision`. */
function model(reads: number, decision: string): { reflections: number } {
  const seen = { reflections: 0 }
  let step = 0
  const mock = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      const system = options.prompt.find((m) => m.role === "system")
      const isReflection = system !== undefined && system.content === LEARN_SYSTEM
      let chunks: LanguageModelV4StreamPart[]
      if (isReflection) {
        seen.reflections += 1
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: decision },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ]
      } else if (step < reads) {
        step += 1
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `c${step}`, toolName: "read", input: JSON.stringify({ path: "a.txt" }) },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ]
      } else {
        chunks = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "selesai" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ]
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  restore?.()
  restore = setModelResolver(() => mock)
  return seen
}

const CREATE = JSON.stringify({
  action: "create",
  name: "baca-berkas",
  description: "Use when reading a.txt repeatedly",
  body: "1. read a.txt",
})

test("giliran dengan 8 tool call memicu refleksi dan skill tertulis", async () => {
  configWith({ enabled: true })
  const seen = model(8, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 1)
  assert.ok(fs.existsSync(path.join(learnedSkillsDir(), "baca-berkas", "SKILL.md")))
})

test("7 tool call: model penilai tidak dipanggil sama sekali", async () => {
  configWith({ enabled: true })
  const seen = model(7, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 0)
  assert.equal(fs.existsSync(learnedSkillsDir()), false)
})

test("learn mati: tidak ada refleksi walau giliran panjang", async () => {
  configWith({ enabled: false })
  const seen = model(12, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  assert.equal(seen.reflections, 0)
})

test("skill yang dipelajari muncul di katalog giliran berikutnya", async () => {
  configWith({ enabled: true })
  model(8, CREATE)
  const session = createSession(project)
  await prompt({ sessionID: session.id, text: "baca berulang" })
  await reflectionDone(session.id)

  const { buildSkillIndex } = await import("../src/core/skill.ts")
  const { loadConfig } = await import("../src/core/config.ts")
  const ids = buildSkillIndex(loadConfig(project).config, project).skills.map((s) => s.id)
  assert.ok(ids.includes("learned:baca-berkas"), ids.join(","))
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/agent-learn.test.ts`
Expected: first and fourth tests FAIL (no reflection call, no file); the other two PASS.

- [ ] **Step 3: Implement**

In `src/core/agent.ts`, add imports next to the other `./` imports:

```ts
import { cancelReflection, countToolCalls, shouldReflect, startReflection } from "./learn.ts"
```

(`summariserModelFor` is already imported from `./provider.ts`; if not, add it to that import.)

At the start of `prompt()`, directly after the `running.has(session.id)` check (around line 447):

```ts
  // Giliran baru menang atas refleksi giliran sebelumnya: ia memakai model yang
  // sama, dan user yang sudah mengetik lagi tidak sedang menunggu skill.
  cancelReflection(session.id)
```

In the turn's `finally`, replace

```ts
    if (!willContinue) bus.publish({ type: "session.idle", sessionID: session.id })
```

with

```ts
    if (!willContinue) bus.publish({ type: "session.idle", sessionID: session.id })

    /*
     * Refleksi dimulai SESUDAH idle: jawabannya sudah di layar, dan giliran
     * tidak menunggu ini. Semua syarat ada di `shouldReflect` supaya bisa diuji
     * tanpa menjalankan giliran; resolusi model ditunda sampai syaratnya lolos,
     * alasan yang sama dengan peringkas pemadatan di atas.
     */
    const learn = config.skills.learn
    if (
      shouldReflect({
        enabled: learn.enabled,
        isChild,
        aborted: controller.signal.aborted,
        failed: assistant.error !== undefined,
        stoppedAtLimit,
        willContinue,
        toolCalls: countToolCalls(assistant.parts),
        minTools: learn.minTools,
      })
    ) {
      try {
        startReflection({
          sessionID: session.id,
          streamSessionID,
          request: input.text,
          parts: structuredClone(assistant.parts),
          model: resolver(config, summariserModelFor(config, turnModel)),
          max: learn.max,
        })
      } catch {
        // Model peringkas yang tidak bisa di-resolve bukan alasan menggagalkan
        // giliran yang sudah selesai.
      }
    }
```

If `streamSessionID`, `turnModel`, `stoppedAtLimit`, `controller`, or `assistant` is not in scope at that `finally` (they are declared at lines ~463, ~601, ~707, ~711, ~690 of the same function as of `main` @ 686cfac), stop and report which one is missing rather than restructuring the function.

- [ ] **Step 4: Run tests**

Run: `node --test test/agent-learn.test.ts && npm run typecheck && npm test`
Expected: all PASS; the full suite has no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts test/agent-learn.test.ts
git commit -m "feat(learn): reflect after substantial turns"
```

---

### Task 7: Doctor line, docs, changelog

**Files:**
- Modify: `src/cli.ts` (`cmdDoctor`, the skills section — find it with `grep -n "Skills" src/cli.ts`)
- Create: `docs/skills-learn.md`
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Test: `test/cli-doctor.test.ts` (append)

**Interfaces:**
- Consumes: `listLearned` (Task 4), `learnedSkillsDir` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `test/cli-doctor.test.ts` (it already defines `isolatedProject()` and `runDoctor()`, and runs `dist/cli.js`, which `npm test` builds first):

```ts
test("titah doctor menyebut apakah Titah belajar skill, berapa, dan di mana", () => {
  const off = runDoctor(isolatedProject({ skills: { discover: [], paths: [] } }, {}))
  assert.match(off, /learning: off — set skills\.learn\.enabled/)

  const on = runDoctor(isolatedProject({ skills: { discover: [], paths: [], learn: { enabled: true } } }, {}))
  assert.match(on, /learning: on — 0 learned skills in .*skills[\/]learned \(cap 30\)/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build --silent && node --test test/cli-doctor.test.ts`
Expected: the new test FAILS (line missing).

- [ ] **Step 3: Implement**

In `cmdDoctor`, directly after the `renderSkillReport(...)` loop under `out("Skills")` (around `src/cli.ts:1458`), add:

```ts
  const learn = loaded.config.skills.learn
  out(
    learn.enabled
      ? `  learning: on — ${listLearned().length} learned skills in ${learnedSkillsDir()} (cap ${learn.max})`
      : "  learning: off — set skills.learn.enabled to let Titah write skills after long turns",
  )
```

with imports `import { listLearned } from "./core/learn.ts"` and `learnedSkillsDir` added to the `./core/paths.ts` import.

Create `docs/skills-learn.md`:

```markdown
# Learned skills

Titah can write skills on its own. After a turn that finished normally and used
at least `minTools` tool calls, one call to `smallModel` reads a short digest of
the turn — the request, the sequence of tool calls, the final answer — and
decides whether it was a procedure worth keeping. Most turns are not.

    { "skills": { "learn": { "enabled": true, "minTools": 8, "max": 30 } } }

Off by default: every qualifying turn pays for one small-model call without
asking.

- Files: `~/.config/titah/skills/learned/<name>/SKILL.md`, namespace `learned:`.
- Titah only ever updates files whose frontmatter says `source: titah-learn`.
  Remove that line and the skill is yours: Titah will not touch it again.
- Delete a folder to forget a skill.
- Every decision, including "none", is one line in `~/.config/titah/learn.log`
  with the tokens it used.
- Never from sub-agents, failed or cancelled turns, turns stopped at a limit,
  or turns that auto-continue.
```

Add to `CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Titah bisa menulis skill sendiri — `skills.learn`, mati secara bawaan

- Sesudah giliran yang selesai normal dan memakai ≥ `minTools` tool call (bawaan
  8), satu panggilan `smallModel` membaca digest ringkas giliran itu — bukan
  transkripnya — dan memutuskan apakah ada prosedur yang layak disimpan.
- Skill ditulis ke `~/.config/titah/skills/learned/<nama>/SKILL.md` dengan
  namespace `learned:`, dan langsung terlihat di giliran berikutnya.
- Titah hanya menimpa berkas bertanda `source: titah-learn`. Nama, ukuran, dan
  bentuk rahasia yang umum divalidasi sebelum apa pun ditulis.
- Setiap keputusan tercatat satu baris di `~/.config/titah/learn.log`, beserta
  token yang dipakai. `titah doctor` menampilkan status dan jumlahnya.
- Sumber skill tidak lagi memindai masuk ke root sumber lain, sehingga
  `~/.config/titah/skills` di `skills.paths` tidak mendaftarkan skill yang
  dipelajari dua kali.
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli-doctor.test.ts docs/skills-learn.md CHANGELOG.md
git commit -m "docs(learn): doctor line, user docs, changelog"
```
