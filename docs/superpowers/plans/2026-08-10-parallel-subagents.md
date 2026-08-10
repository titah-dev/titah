# Parallel Sub-agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Titah dispatch several of its own configured agents at once — readers concurrently, writers one at a time — each as a child session the user can watch and stop individually.

**Architecture:** A sub-agent is a Titah session whose `parent_id` points at the turn that spawned it, run in-process through the existing `prompt()` loop. A new `task` tool lets the model dispatch one; parallelism appears when the model emits several `task` calls in one step, and a per-working-directory lock holds writers back. Child progress is republished on the parent's event stream so the TUI's single subscription still sees everything.

**Tech Stack:** TypeScript (strict, ESM, Node ≥22.6), Zod v4, `node:sqlite`, `node:test`, AI SDK v7 `tool()`, Ink 7.

**Spec:** `docs/superpowers/specs/2026-08-10-parallel-subagents-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Code comments in Indonesian; all user-facing strings in English.** Comments explain *why*, never *what*.
- **TypeScript strict; no `any` anywhere in `src/`.** A cast used to dodge a type error is a defect.
- **No test may invoke a real provider or a real external agent.** Use `setModelResolver` for models and `test/fixtures/stub-agent.js` for delegated agents.
- **No test may read the real `~/.claude` or `~/.config/opencode`.** Tests building a Config for skill-level calls set `skills.discover: []`; tests going through `loadConfig()` also isolate `process.env.HOME`, because `os.homedir()` reads `$HOME` directly and bypasses XDG isolation.
- **Every task ends green:** `npm run typecheck && npm run build && npm test`. The suite currently has 448 passing tests; none may break.
- **Every commit leaves the tree green.** No task may knowingly leave typecheck broken for a later task to fix.
- **Commit every task.** Work happens on `feat/parallel-subagents`, branched from
  `feat/skills-active-passive` — **not** from `main`. The `task` tool reads
  `ToolContext.config`, which only exists on the skills branch. The review process
  diffs `BASE..HEAD` per task.
- **Depth is exactly one level.** A sub-agent never receives the `task` tool. This is a hard requirement, not a default.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/schema.ts` | `Agent.mode`, `Agent.delegate`, their validation | Modify |
| `src/core/storage/db.ts` | migration adding `session.parent_id` | Modify |
| `src/core/storage/session.ts` | `createChildSession`, `listChildSessions`, list exclusion | Modify |
| `src/core/subagent.ts` | Reader/writer classification, the write lock, dispatch | **Create** |
| `src/core/event.ts` | `subagent.updated` event | Modify |
| `src/core/tool/task.ts` | The `task` tool | **Create** |
| `src/core/tool/index.ts` | Register `taskTool` | Modify |
| `src/core/agent.ts` | Pass agent identity into tools; withhold `task` from children; `/tim` | Modify |
| `src/core/permission.ts` | `PermissionRequest.agent` | Modify |
| `src/core/command.ts` | Register `/tim` | Modify |
| `src/tui/subagent-panel.tsx` | The panel component | **Create** |
| `src/tui/keybinds.ts` | `subagents_panel: "<leader>down"` | Modify |
| `src/tui/app.tsx` | Panel state, `subagent.updated` handling, cancel | Modify |
| `src/tui/state.ts` | Reduce `subagent.updated` into TUI state | Modify |

`subagent.ts` is its own file because scheduling is a concurrency concern that must be testable without a model, a session, or a filesystem. Mixing it into `agent.ts` — already 900+ lines — would make the lock untestable in isolation.

---

## Task 1: Agent schema gains `mode` and `delegate`

**Files:**
- Modify: `src/core/schema.ts` (the `Agent` object, around line 81)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Agent.mode: "primary" | "subagent" | "all"` (default `"primary"`), `Agent.delegate?: string`

- [ ] **Step 1: Write the failing tests**

```ts
test("mode default-nya primary, bukan all", () => {
  // Keputusan keamanan: `build-auto` yang sudah ada punya permission serba-izinkan.
  // Default "all" akan menyerahkan bawahan yang TIDAK PERNAH bertanya sebelum
  // menulis kepada model, tanpa user menuliskan sebaris pun.
  const config = Config.parse({ agent: { build: {} } })
  assert.equal(config.agent["build"]?.mode, "primary")
})

test("mode subagent dan all keduanya sah", () => {
  const config = Config.parse({
    agent: { explore: { mode: "subagent" }, build: { mode: "all" } },
  })
  assert.equal(config.agent["explore"]?.mode, "subagent")
  assert.equal(config.agent["build"]?.mode, "all")
})

test("mode yang tidak dikenal ditolak, bukan diabaikan", () => {
  assert.throws(() => Config.parse({ agent: { x: { mode: "worker" } } }))
})

test("delegate menunjuk agent eksternal", () => {
  const config = Config.parse({
    agent: { reviewer: { mode: "subagent", delegate: "claude" } },
  })
  assert.equal(config.agent["reviewer"]?.delegate, "claude")
})

test("delegate dan model bersamaan DITOLAK", () => {
  // Satu agent, satu mesin. Menyetel keduanya berarti tidak ada jawaban atas
  // "mana yang dipakai", dan diam-diam memilih salah satunya menyembunyikan
  // kesalahan konfigurasi yang nyata.
  assert.throws(
    () => Config.parse({ agent: { x: { delegate: "claude", model: "9router/ant" } } }),
    /delegate/i,
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/config.test.ts`
Expected: FAIL — `mode` is undefined

- [ ] **Step 3: Implement**

In `src/core/schema.ts`, add the two fields to `Agent` and validate the pair:

```ts
export const Agent = z
  .object({
    description: z.string().optional().describe("Shown in the agent picker"),
    mode: z
      .enum(["primary", "subagent", "all"])
      .default("primary")
      .describe(
        'Where this agent may run. "primary" is selectable with Tab; "subagent" can be ' +
          'dispatched by the coordinator; "all" is both.',
      ),
    delegate: z
      .string()
      .optional()
      .describe(
        'Run this agent by spawning an external CLI from `externalAgent` instead of Titah\'s ' +
          "own loop. Mutually exclusive with `model`.",
      ),
    prompt: z.string().optional().describe("Appended to the system prompt"),
    model: z.string().optional().describe('Model override, in "provider/model" form'),
    // …tools, skills, permission tetap seperti sekarang…
  })
  .superRefine((agent, ctx) => {
    if (agent.delegate !== undefined && agent.model !== undefined) {
      ctx.addIssue({
        code: "custom",
        // Satu agent, satu mesin. Memilih diam-diam menyembunyikan salah konfigurasi.
        message: "An agent cannot set both `delegate` and `model` — it has one engine, not two.",
      })
    }
  })
```

Keep every existing field exactly as it is; only add `mode`, `delegate`, and the `superRefine`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/config.test.ts` → PASS
Then regenerate the JSON schema (see `package.json` for the script name) and commit the regenerated `config.schema.json`.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts config.schema.json test/config.test.ts
git commit -m "feat(config): agent mode and delegate"
```

---

## Task 2: Child sessions in storage

**Files:**
- Modify: `src/core/storage/db.ts` (append to `MIGRATIONS`), `src/core/storage/session.ts`
- Test: `test/storage.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createChildSession(parentID: string, directory: string, title: string): Session`
  - `listChildSessions(parentID: string): Session[]`
  - `listSessions` continues to exclude children

- [ ] **Step 1: Write the failing tests**

```ts
test("sesi anak tertaut ke induknya dan TIDAK muncul di daftar", () => {
  // Daftar /session adalah "percakapan yang bisa kamu lanjutkan". Sesi anak
  // bukan salah satunya — ia milik satu giliran, dan menampilkannya membuat
  // daftar itu penuh entri yang tidak berarti apa-apa bagi user.
  const parent = createSession("/proyek/x", "induk")
  createMessage(parent.id, "user", [{ type: "text", text: "halo" }])

  const child = createChildSession(parent.id, "/proyek/x", "explore")
  createMessage(child.id, "user", [{ type: "text", text: "telusuri" }])

  const listed = listSessions(50, "/proyek/x").map((s) => s.id)
  assert.ok(listed.includes(parent.id))
  assert.ok(!listed.includes(child.id), "anak tidak pernah didaftar")

  assert.deepEqual(
    listChildSessions(parent.id).map((s) => s.id),
    [child.id],
  )
})

test("anak mewarisi direktori kerja induknya", () => {
  const parent = createSession("/proyek/y")
  const child = createChildSession(parent.id, "/proyek/y", "qc")
  assert.equal(child.directory, parent.directory)
})

test("menghapus induk ikut menghapus anaknya", () => {
  // ON DELETE CASCADE: sesi anak tanpa induk tidak punya arti apa pun, dan
  // membiarkannya berarti prune tidak pernah membersihkannya.
  const parent = createSession("/proyek/z")
  createMessage(parent.id, "user", [{ type: "text", text: "a" }])
  const child = createChildSession(parent.id, "/proyek/z", "explore")

  deleteSession(parent.id)
  assert.equal(getSession(child.id), undefined)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/storage.test.ts`
Expected: FAIL — `createChildSession is not a function`

- [ ] **Step 3: Implement**

Append a migration to the `MIGRATIONS` array in `src/core/storage/db.ts`:

```ts
  /*
   * Sesi anak: satu sub-agent, satu sesi, tertaut ke giliran yang melahirkannya.
   *
   * Kolom terpisah, bukan tabel baru: anak ADALAH sesi seutuhnya — ia punya
   * pesan, snapshot, dan pembatalannya sendiri. Memisahkannya ke tabel lain
   * berarti menduplikasi semuanya.
   */
  `ALTER TABLE session ADD COLUMN parent_id TEXT REFERENCES session(id) ON DELETE CASCADE;
   CREATE INDEX session_parent ON session(parent_id);`,
```

In `src/core/storage/session.ts`:

```ts
export function createChildSession(parentID: string, directory: string, title: string): Session {
  const now = Date.now()
  const session: Session = {
    id: `ses_${crypto.randomUUID()}`,
    title,
    directory: projectKey(directory),
    created: now,
    updated: now,
  }
  database()
    .prepare(
      "INSERT INTO session (id, title, directory, created, updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(session.id, session.title, session.directory, session.created, session.updated, parentID)
  return session
}

export function listChildSessions(parentID: string): Session[] {
  return database()
    .prepare("SELECT * FROM session WHERE parent_id = ? ORDER BY created ASC")
    .all(parentID) as unknown as SessionRow[]
}
```

Add `AND s.parent_id IS NULL` to **both** branches of `listSessions`.

Also expose the link on the type, because Task 6 needs to ask "am I a child?":
add `parentID?: string` to `Session` in `src/core/message.ts` and to `SessionRow`
in `session.ts`, mapping the `parent_id` column onto it in `getSession`. Doing it
here rather than later keeps the column and its accessor in one commit.

Note on the CASCADE test: `PRAGMA foreign_keys` must be on for it to fire. Check `database()` in `db.ts`; if the pragma is not already set, add `connection.exec("PRAGMA foreign_keys = ON")` next to the other pragmas and say so in your report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/storage.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/db.ts src/core/storage/session.ts test/storage.test.ts
git commit -m "feat(storage): child sessions linked to the turn that spawned them"
```

---

## Task 3: Classification and the write lock

**Files:**
- Create: `src/core/subagent.ts`
- Test: `test/subagent.test.ts`

**Interfaces:**
- Consumes: `Agent` type from `src/core/schema.ts`
- Produces:
  - `isReader(agent: Agent): boolean`
  - `withWriteLock<T>(cwd: string, run: () => Promise<T>): Promise<T>`
  - `dispatchableAgents(config: Config): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { dispatchableAgents, isReader, withWriteLock } from "../src/core/subagent.ts"
import { Config } from "../src/core/schema.ts"

const agent = (permission: Record<string, string>) =>
  Config.parse({ agent: { a: { mode: "subagent", permission } } }).agent["a"]!

test("pembaca adalah agent yang edit, write, DAN bash-nya deny", () => {
  assert.equal(isReader(agent({ edit: "deny", write: "deny", bash: "deny" })), true)
})

test("bash ikut dihitung — shell bisa menulis berkas juga", () => {
  // `bash` yang diizinkan bisa menjalankan `sed -i`. Menghitungnya sebagai
  // pembaca berarti dua agent bisa menulis bersamaan lewat pintu belakang,
  // tepat yang dicegah oleh serialisasi penulis.
  assert.equal(isReader(agent({ edit: "deny", write: "deny", bash: "ask" })), false)
})

test("izin yang tidak disebut BUKAN deny", () => {
  // Tanpa permission apa pun, agent mewarisi kebijakan global — yang defaultnya
  // "ask", bukan "deny". Menganggapnya pembaca akan melepaskan penulis ke jalur
  // paralel tanpa satu pun deklarasi.
  assert.equal(isReader(agent({})), false)
})

test("penulis diserialkan: yang kedua tidak mulai sebelum yang pertama selesai", async () => {
  const order: string[] = []
  const gate = Promise.withResolvers<void>()

  const first = withWriteLock("/proyek", async () => {
    order.push("mulai-1")
    await gate.promise
    order.push("selesai-1")
  })
  const second = withWriteLock("/proyek", async () => {
    order.push("mulai-2")
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ["mulai-1"], "yang kedua BELUM boleh mulai")

  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ["mulai-1", "selesai-1", "mulai-2"])
})

test("penulis yang gagal tidak mengunci antrean selamanya", async () => {
  // Kalau kegagalan menahan kunci, satu sub-agent yang error membuat setiap
  // penulis berikutnya menggantung tanpa penjelasan sampai sesi ditutup.
  const failed = withWriteLock("/proyek", async () => {
    throw new Error("meledak")
  })
  await assert.rejects(failed, /meledak/)

  const after = await withWriteLock("/proyek", async () => "lolos")
  assert.equal(after, "lolos")
})

test("direktori berbeda tidak saling mengunci", async () => {
  // Kuncinya per direktori kerja karena repo bayangan snapshot memang dikunci
  // di situ — bukan batas yang dikarang.
  const order: string[] = []
  const gate = Promise.withResolvers<void>()

  const a = withWriteLock("/proyek/a", async () => {
    order.push("a")
    await gate.promise
  })
  await withWriteLock("/proyek/b", async () => {
    order.push("b")
  })

  assert.deepEqual(order, ["a", "b"], "b tidak menunggu a")
  gate.resolve()
  await a
})

test("hanya agent ber-mode subagent atau all yang bisa didispatch", () => {
  const config = Config.parse({
    agent: {
      explore: { mode: "subagent" },
      build: { mode: "primary" },
      hybrid: { mode: "all" },
    },
  })
  assert.deepEqual(dispatchableAgents(config).sort(), ["explore", "hybrid"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/subagent.test.ts`
Expected: FAIL — cannot find module `subagent.ts`

- [ ] **Step 3: Implement `src/core/subagent.ts`**

```ts
import path from "node:path"
import type { Agent, Config } from "./schema.ts"

/**
 * Penjadwalan sub-agent.
 *
 * Dipisah dari agent.ts supaya bisa diuji tanpa model, tanpa sesi, dan tanpa
 * filesystem — kunci concurrency yang hanya bisa diuji lewat giliran sungguhan
 * adalah kunci yang tidak pernah benar-benar diuji.
 */

/**
 * Pembaca boleh jalan serentak tanpa batas; selain itu penulis, dan penulis antre.
 *
 * `bash` ikut dihitung: shell yang diizinkan bisa `sed -i`, dan memperlakukannya
 * sebagai pembaca membuka pintu belakang ke persoalan yang serialisasi ini ada
 * untuk mencegahnya. Izin yang TIDAK disebut juga bukan deny — ia mewarisi
 * kebijakan global, yang defaultnya "ask".
 */
export function isReader(agent: Agent): boolean {
  const permission = agent.permission
  if (!permission) return false
  return permission.edit === "deny" && permission.write === "deny" && permission.bash === "deny"
}

/** Ekor antrean penulis per direktori kerja. */
const tail = new Map<string, Promise<unknown>>()

/**
 * Menjalankan `run` setelah penulis sebelumnya di direktori yang sama selesai.
 *
 * Kuncinya per DIREKTORI KERJA, bukan per sesi, karena repo bayangan snapshot
 * memang dikunci di situ. Dua penulis di direktori yang sama akan membuat satu
 * snapshot memuat perubahan keduanya bercampur, dan `/undo` kehilangan cara
 * memisahkan siapa mengubah apa.
 */
export function withWriteLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(cwd)
  const previous = tail.get(key) ?? Promise.resolve()

  // `then(run, run)`: penulis berikutnya tetap jalan walau pendahulunya gagal.
  // Kalau kegagalan menahan kunci, satu error mengunci antrean selamanya.
  const result = previous.then(run, run)
  tail.set(
    key,
    result.catch(() => undefined),
  )
  return result
}

/** Agent yang boleh dijadikan bawahan. `primary` tidak pernah termasuk. */
export function dispatchableAgents(config: Config): string[] {
  return Object.entries(config.agent)
    .filter(([, agent]) => agent.mode === "subagent" || agent.mode === "all")
    .map(([id]) => id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/subagent.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/subagent.ts test/subagent.test.ts
git commit -m "feat(subagent): reader/writer classification and the per-directory write lock"
```

---

## Task 4: The `subagent.updated` event

**Files:**
- Modify: `src/core/event.ts`, `src/tui/state.ts`
- Test: `test/tui-state.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - Event `{ type: "subagent.updated"; sessionID: string; child: SubagentState }`
  - `interface SubagentState { sessionID: string; agent: string; status: "queued" | "running" | "done" | "failed" | "stopped"; startedAt: number; note: string }`
  - `TuiState.subagents: SubagentState[]`

- [ ] **Step 1: Write the failing tests**

```ts
test("subagent.updated menyisipkan lalu memperbarui berdasarkan sesi anak", () => {
  // Panel harus menampilkan satu baris per sub-agent, bukan satu baris per
  // pembaruan — kalau tidak, agent yang berjalan 48 detik memenuhi layar.
  const running = reduce(initialState, {
    type: "subagent.updated",
    sessionID: "induk",
    child: { sessionID: "anak", agent: "explore", status: "running", startedAt: 1, note: "membaca" },
  })
  assert.equal(running.subagents.length, 1)

  const done = reduce(running, {
    type: "subagent.updated",
    sessionID: "induk",
    child: { sessionID: "anak", agent: "explore", status: "done", startedAt: 1, note: "selesai" },
  })
  assert.equal(done.subagents.length, 1, "diperbarui, bukan ditambah")
  assert.equal(done.subagents[0]?.status, "done")
})

test("berganti sesi mengosongkan daftar sub-agent", () => {
  // Sub-agent milik satu giliran di satu sesi. Membiarkannya terlihat setelah
  // berpindah sesi menampilkan pekerjaan yang bukan milik layar itu lagi.
  const withChild = reduce(initialState, {
    type: "subagent.updated",
    sessionID: "induk",
    child: { sessionID: "anak", agent: "explore", status: "running", startedAt: 1, note: "" },
  })
  const switched = reduce(withChild, {
    type: "session.switch",
    session: { id: "lain", title: "", directory: "/p", created: 1, updated: 1 },
  })
  assert.deepEqual(switched.subagents, [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/tui-state.test.ts`
Expected: FAIL — `subagents` is undefined

- [ ] **Step 3: Implement**

In `src/core/event.ts`, add the state type and the event to the `Event` union:

```ts
export interface SubagentState {
  sessionID: string
  agent: string
  status: "queued" | "running" | "done" | "failed" | "stopped"
  startedAt: number
  /** Satu baris aktivitas untuk panel, mis. "menulis src/auth.ts". */
  note: string
}
```

```ts
  | { type: "subagent.updated"; sessionID: string; child: SubagentState }
```

In `src/tui/state.ts`, add `subagents: SubagentState[]` to `TuiState`, `subagents: []` to `initialState`, and a case in `reduce`:

```ts
    case "subagent.updated": {
      // Diperbarui berdasarkan sessionID anak, bukan ditambahkan: panel
      // menampilkan satu baris per sub-agent, bukan satu baris per pembaruan.
      const index = state.subagents.findIndex((entry) => entry.sessionID === event.child.sessionID)
      if (index === -1) return { ...state, subagents: [...state.subagents, event.child] }
      const copy = state.subagents.slice()
      copy[index] = event.child
      return { ...state, subagents: copy }
    }
```

`session.switch` already returns `{ ...initialState, session }`, so the list clears on its own — verify that with the test rather than assuming it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/tui-state.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/event.ts src/tui/state.ts test/tui-state.test.ts
git commit -m "feat(event): subagent.updated carries child progress to the parent stream"
```

---

## Task 5: Dispatching a sub-agent

**Files:**
- Modify: `src/core/subagent.ts`
- Test: `test/subagent-run.test.ts`

**Interfaces:**
- Consumes: `createChildSession`, `listChildSessions`, `withWriteLock`, `isReader`, `prompt` from `src/core/agent.ts`
- Produces: `runSubagent(options: RunSubagentOptions): Promise<SubagentResult>` where

```ts
interface RunSubagentOptions {
  parentSessionID: string
  agentID: string
  instruction: string
  cwd: string
  config: Config
  signal: AbortSignal
}
interface SubagentResult {
  answer: string
  childSessionID: string
  status: "done" | "failed" | "stopped"
}
```

- [ ] **Step 1: Write the failing tests**

```ts
process.env["TITAH_DB"] = ":memory:"

test("sub-agent menjalankan giliran di sesi anaknya sendiri", async () => {
  const parent = createSession(process.cwd(), "induk")
  const restore = setModelResolver(() => stubModel("SUDAH DIPETAKAN"))
  try {
    const result = await runSubagent({
      parentSessionID: parent.id,
      agentID: "explore",
      instruction: "petakan auth",
      cwd: process.cwd(),
      config: configWithExplore(),
      signal: new AbortController().signal,
    })

    assert.equal(result.status, "done")
    assert.match(result.answer, /SUDAH DIPETAKAN/)
    assert.deepEqual(
      listChildSessions(parent.id).map((s) => s.id),
      [result.childSessionID],
    )
  } finally {
    restore()
  }
})

test("agent ber-mode primary DITOLAK sebagai bawahan", async () => {
  // `build-auto` punya izin serba-boleh. Kalau mode tidak ditegakkan di sini,
  // deklarasi di config jadi hiasan.
  const parent = createSession(process.cwd())
  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "build",
    instruction: "apa saja",
    cwd: process.cwd(),
    config: Config.parse({ agent: { build: { mode: "primary" } } }),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "failed")
  assert.match(result.answer, /not dispatchable|primary/i)
})

test("dibatalkan mengembalikan status stopped, BUKAN melempar", async () => {
  // Pembatalan adalah informasi untuk koordinator, bukan kegagalan giliran.
  // Melempar di sini akan menggugurkan giliran induk — persis yang dihindari.
  const parent = createSession(process.cwd())
  const controller = new AbortController()
  const restore = setModelResolver(() => slowStubModel())
  try {
    const running = runSubagent({
      parentSessionID: parent.id,
      agentID: "explore",
      instruction: "kerja lama",
      cwd: process.cwd(),
      config: configWithExplore(),
      signal: controller.signal,
    })
    controller.abort()
    const result = await running

    assert.equal(result.status, "stopped")
    assert.match(result.answer, /STOPPED BY USER/)
  } finally {
    restore()
  }
})
```

Write `stubModel`, `slowStubModel`, and `configWithExplore` as local helpers in this test file; follow the stub-model pattern already used in `test/agent.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/subagent-run.test.ts`
Expected: FAIL — `runSubagent is not a function`

- [ ] **Step 3: Implement**

Append to `src/core/subagent.ts`:

```ts
/**
 * Menjalankan satu sub-agent sampai selesai.
 *
 * Pembaca langsung jalan; penulis melewati `withWriteLock` lebih dulu. Statusnya
 * disiarkan ke stream sesi INDUK — TUI hanya berlangganan satu sesi, jadi
 * kemajuan anak yang hanya disiarkan ke sesinya sendiri tidak akan pernah terlihat.
 */
export interface RunSubagentOptions {
  parentSessionID: string
  agentID: string
  instruction: string
  cwd: string
  config: Config
  signal: AbortSignal
}

export interface SubagentResult {
  answer: string
  childSessionID: string
  status: "done" | "failed" | "stopped"
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
  const definition = options.config.agent[options.agentID]
  if (!definition || definition.mode === "primary") {
    return {
      answer: `Agent "${options.agentID}" is not dispatchable. Available: ${dispatchableAgents(options.config).join(", ") || "(none)"}.`,
      childSessionID: "",
      status: "failed",
    }
  }

  const child = createChildSession(options.parentSessionID, options.cwd, options.agentID)
  const startedAt = Date.now()

  const publish = (status: SubagentState["status"], note: string) => {
    bus.publish({
      type: "subagent.updated",
      sessionID: options.parentSessionID,
      child: { sessionID: child.id, agent: options.agentID, status, startedAt, note },
    })
  }

  const reader = isReader(definition)
  publish(reader ? "running" : "queued", reader ? "starting" : "waiting for a turn")

  const work = async (): Promise<SubagentResult> => {
    publish("running", "working")
    try {
      const message = await prompt({
        sessionID: child.id,
        text: options.instruction,
        agent: options.agentID,
      })
      const answer = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()

      if (options.signal.aborted) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }
      publish("done", "done")
      return { answer, childSessionID: child.id, status: "done" }
    } catch (error) {
      if (options.signal.aborted) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }
      const reason = error instanceof Error ? error.message : String(error)
      publish("failed", reason)
      return { answer: `FAILED: ${reason}`, childSessionID: child.id, status: "failed" }
    }
  }

  // Sinyal induk membatalkan giliran anak lewat controller milik sesi anak.
  const stop = () => abort(child.id)
  options.signal.addEventListener("abort", stop, { once: true })
  try {
    return reader ? await work() : await withWriteLock(options.cwd, work)
  } finally {
    options.signal.removeEventListener("abort", stop)
  }
}

function stoppedNote(startedAt: number): string {
  return `STOPPED BY USER after ${Math.round((Date.now() - startedAt) / 1000)}s.`
}
```

Import `bus` from `./event.ts`, and `prompt` plus `abort` from `./agent.ts`.

Snapshots need no new code: each child runs the ordinary loop, which already
takes one before its first mutating tool. Because writers are serialised, those
snapshots land in sequence rather than on top of each other — which is what makes
per-agent revert possible later, even though this plan does not build it.

**Circular import warning:** `agent.ts` will import `runSubagent` in Task 6 while `subagent.ts` imports `prompt` from `agent.ts`. Node's ESM handles this cycle as long as neither module calls the other at module-evaluation time — both only call at request time, so it resolves. If typecheck or runtime complains, break the cycle by having `agent.ts` pass `prompt` in through `RunSubagentOptions` rather than `subagent.ts` importing it; report which route you took.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/subagent-run.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/subagent.ts test/subagent-run.test.ts
git commit -m "feat(subagent): run a sub-agent in its own child session"
```

---

## Task 6: The `task` tool and the depth guard

**Files:**
- Create: `src/core/tool/task.ts`
- Modify: `src/core/tool/index.ts`, `src/core/tool/types.ts`, `src/core/agent.ts`
- Test: `test/tool-task.test.ts`

**Interfaces:**
- Consumes: `runSubagent`, `dispatchableAgents`
- Produces: `taskTool: TitahTool`; `ToolContext` gains `parentSessionID?: string`

- [ ] **Step 1: Write the failing tests**

```ts
test("task menjalankan sub-agent dan mengembalikan jawabannya", async () => {
  const session = createSession(process.cwd())
  const restore = setModelResolver(() => stubModel("HASIL SUB-AGENT"))
  try {
    const result = await taskTool.execute(
      { agent: "explore", instruction: "telusuri" },
      ctx(session.id, configWithExplore()),
    )
    assert.match(result.output, /HASIL SUB-AGENT/)
  } finally {
    restore()
  }
})

test("nama agent tak dikenal menyebut yang tersedia", async () => {
  const session = createSession(process.cwd())
  const result = await taskTool.execute(
    { agent: "tidakada", instruction: "x" },
    ctx(session.id, configWithExplore()),
  )
  assert.match(result.output, /explore/)
})

test("SUB-AGENT TIDAK MENDAPAT TOOL task", () => {
  // Tanpa penjaga ini, satu sub-agent bisa memanggil sub-agent lagi, dan
  // seterusnya — pohon yang melebar tanpa batas, membakar token provider user
  // sampai habis tanpa satu pun tempat untuk menghentikannya.
  const parentTools = buildToolNames({ isChild: false })
  const childTools = buildToolNames({ isChild: true })

  assert.ok(parentTools.includes("task"))
  assert.ok(!childTools.includes("task"), "kedalaman tepat satu tingkat")
})
```

For the third test, export a small helper from `agent.ts` that returns the tool names `buildTools` would produce for a given options shape, so the guard is testable without running a turn. Name it `buildToolNames(options: { isChild: boolean }): string[]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/tool-task.test.ts`
Expected: FAIL — cannot find module `tool/task.ts`

- [ ] **Step 3: Implement**

Create `src/core/tool/task.ts`:

```ts
import { z } from "zod"
import { dispatchableAgents, runSubagent } from "../subagent.ts"
import type { TitahTool } from "./types.ts"

const inputSchema = z.object({
  agent: z.string().describe("Name of a configured agent whose `mode` allows dispatch"),
  instruction: z.string().describe("What this sub-agent should do, stated on its own terms"),
})

export const taskTool: TitahTool<typeof inputSchema> = {
  name: "task",
  description:
    "Hand a piece of work to one of the configured sub-agents. Several calls in the same step " +
    "run concurrently; agents allowed to write files are serialised automatically. The " +
    "sub-agent cannot dispatch further sub-agents.",
  inputSchema,

  // Tanpa `permission`: tool ini tidak mengubah apa pun sendiri. Sub-agent yang
  // ia jalankan meminta izinnya masing-masing, dengan namanya sendiri.

  async execute(input, ctx) {
    const available = dispatchableAgents(ctx.config)
    if (!available.includes(input.agent)) {
      return {
        title: `task ${input.agent} (unknown)`,
        output: `No dispatchable agent named "${input.agent}". Available: ${available.join(", ") || "(none)"}.`,
      }
    }

    const result = await runSubagent({
      parentSessionID: ctx.sessionID,
      agentID: input.agent,
      instruction: input.instruction,
      cwd: ctx.cwd,
      config: ctx.config,
      signal: ctx.signal,
    })

    return {
      title: `task ${input.agent} (${result.status})`,
      output: result.answer,
      metadata: { childSessionID: result.childSessionID, status: result.status },
    }
  },
}
```

Register it in `src/core/tool/index.ts`.

In `src/core/agent.ts`, withhold it from children. `prompt()` must learn whether the session is a child — read it once near the top:

```ts
  // Sesi anak tidak pernah mendapat `task`. Kedalaman tepat satu tingkat.
  const isChild = getSession(session.id)?.parentID !== undefined
```

and in `buildTools`, skip `taskTool` when `options.isChild` is true. Add `isChild: boolean` to `BuildToolsOptions` and pass it through. `Session.parentID`
already exists from Task 2 — do not add it again.

Write the `ctx(sessionID, config)` helper used by these tests locally in the test
file: it returns a `ToolContext` with `cwd: process.cwd()`, a fresh
`AbortController().signal`, `callID: "c1"`, and the config you pass. Copy the
shape from the `ctx()` helper already in `test/tool.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/tool-task.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/tool/task.ts src/core/tool/index.ts src/core/tool/types.ts src/core/agent.ts src/core/storage/session.ts test/tool-task.test.ts
git commit -m "feat(tool): task dispatches a sub-agent, and children never receive it"
```

---

## Task 7: Sub-agents backed by an external CLI

**Files:**
- Modify: `src/core/subagent.ts`
- Test: `test/subagent-delegate.test.ts`

**Interfaces:**
- Consumes: `adapterFor` from `src/core/delegate/index.ts`
- Produces: no new exports; `runSubagent` honours `definition.delegate`

- [ ] **Step 1: Write the failing tests**

```ts
test("sub-agent ber-delegate menjalankan CLI eksternal, bukan loop Titah", async () => {
  const parent = createSession(process.cwd())
  const config = Config.parse({
    agent: { reviewer: { mode: "subagent", delegate: "stub" } },
    externalAgent: {
      stub: { command: process.execPath, args: [FIXTURE, "claude", "{prompt}"], format: "stream-json" },
    },
  })

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "reviewer",
    instruction: "tinjau ini",
    cwd: process.cwd(),
    config,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "done")
  assert.notEqual(result.answer, "")
})

test("delegate yang menunjuk agent eksternal tak dikenal gagal dengan jelas", async () => {
  const parent = createSession(process.cwd())
  const config = Config.parse({ agent: { x: { mode: "subagent", delegate: "hantu" } } })

  const result = await runSubagent({
    parentSessionID: parent.id,
    agentID: "x",
    instruction: "apa saja",
    cwd: process.cwd(),
    config,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "failed")
  assert.match(result.answer, /hantu/)
})
```

`FIXTURE` is the path to the existing `test/fixtures/stub-agent.js`; copy how `test/delegate.test.ts` references it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/subagent-delegate.test.ts`
Expected: FAIL — the delegated agent runs Titah's own loop instead

- [ ] **Step 3: Implement**

Inside `runSubagent`'s `work()`, branch before calling `prompt()`:

```ts
    if (definition.delegate !== undefined) {
      const adapter = adapterFor(options.config, definition.delegate)
      if (!adapter) {
        publish("failed", `unknown external agent "${definition.delegate}"`)
        return {
          answer: `Agent "${options.agentID}" delegates to "${definition.delegate}", which is not defined in \`externalAgent\`.`,
          childSessionID: child.id,
          status: "failed",
        }
      }
      const delegated = await adapter.prompt({
        prompt: options.instruction,
        cwd: options.cwd,
        signal: options.signal,
        onUpdate: (update) => {
          if (update.kind === "tool") publish("running", `running ${update.name}`)
        },
      })
      publish(delegated.isError ? "failed" : "done", delegated.isError ? "failed" : "done")
      return {
        answer: delegated.isError ? `FAILED: ${delegated.errorMessage ?? "no explanation"}` : delegated.answer,
        childSessionID: child.id,
        status: delegated.isError ? "failed" : "done",
      }
    }
```

The delegated branch deliberately does **not** pass a `resumeSessionID`: a sub-agent is given one task, and reusing a mapped session would bias it with a conversation it was never told about.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/subagent-delegate.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/subagent.ts test/subagent-delegate.test.ts
git commit -m "feat(subagent): an agent may use an external CLI as its engine"
```

---

## Task 8: The permission dialog names the agent

**Files:**
- Modify: `src/core/permission.ts`, `src/core/agent.ts`, `src/tui/components.tsx`
- Test: `test/permission.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PermissionRequest.agent?: string`; `AskOptions.agent?: string`

- [ ] **Step 1: Write the failing tests**

```ts
test("permintaan izin membawa nama agent yang meminta", async () => {
  // Tanpa nama ini, user menjawab pertanyaan tanpa tahu siapa yang bertanya —
  // dan dengan lima sub-agent berjalan, itu satu-satunya cara membedakannya.
  const asking = ask({
    sessionID: "s",
    permission: { edit: "ask", write: "ask", bash: "ask", allowlist: [] },
    kind: "write",
    title: "write src/auth.ts",
    detail: "…",
    pattern: "write",
    agent: "qc-developer",
    listeners: 1,
    signal: new AbortController().signal,
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  const [request] = listPending("s")
  assert.equal(request?.agent, "qc-developer")

  respond(request!.id, "reject")
  await asking
})

test("jawaban always berlaku untuk seluruh giliran, bukan hanya agent yang bertanya", () => {
  // Lima agent menanyakan hal yang sama lima kali adalah cara tercepat membuat
  // user berhenti membaca dialog izin.
  remember("induk", "git *")
  assert.equal(allowedBySession("induk", "git status"), true)
})
```

Adjust the second test to whatever the allowlist helpers are actually named in `permission.ts`; read the file first and use the real names.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/permission.test.ts`
Expected: FAIL — `agent` is not part of the request

- [ ] **Step 3: Implement**

Add `agent?: string` to both `PermissionRequest` and `AskOptions` in `src/core/permission.ts`, and pass it through when the request is built.

In `src/core/agent.ts`, `buildTools` gains `agentID?: string` in its options and forwards it into `ask({ …, agent: options.agentID })`.

The session allowlist must key on the **parent** session so an "always" answer covers the whole turn. In `runSubagent`, the child's turn runs under the child session id, so pass the parent id into the permission layer: add `allowlistSessionID` to `AskOptions`, defaulting to `sessionID`, and have `runSubagent` set it to the parent. State in your report which mechanism you used.

In `src/tui/components.tsx`, `PermissionDialog` prints the agent when present:

```tsx
      <Text color="yellow" bold>
        {request.agent ? `${request.agent} · ` : ""}
        Permission requested ({request.kind}): {request.title}
      </Text>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/permission.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/core/permission.ts src/core/agent.ts src/core/subagent.ts src/tui/components.tsx test/permission.test.ts
git commit -m "feat(permission): the dialog names the agent that is asking"
```

---

## Task 9: The panel

**Files:**
- Create: `src/tui/subagent-panel.tsx`
- Modify: `src/tui/keybinds.ts`, `src/tui/app.tsx`
- Test: `test/subagent-panel.test.ts`, `test/tui-input.test.ts`

**Interfaces:**
- Consumes: `SubagentState` from `src/core/event.ts`
- Produces: `SubagentPanel` component; keybind `subagents_panel`

- [ ] **Step 1: Write the failing tests**

Pure rendering first, in `test/subagent-panel.test.ts`:

```ts
test("baris antre menjelaskan KENAPA ia belum jalan", () => {
  // Tanpa baris ini, penulis yang mengantre terlihat persis seperti macet.
  const lines = panelLines(
    [
      { sessionID: "a", agent: "explore", status: "running", startedAt: Date.now() - 12_000, note: "reading files" },
      { sessionID: "b", agent: "qc-developer", status: "queued", startedAt: Date.now(), note: "waiting for a turn" },
    ],
    Date.now(),
  )

  assert.match(lines[0] ?? "", /◐ explore\s+12s\s+reading files/)
  assert.match(lines[1] ?? "", /∅ qc-developer\s+waiting for a turn/)
})

test("sub-agent selesai tetap terlihat, dengan durasinya", () => {
  const lines = panelLines(
    [{ sessionID: "a", agent: "analyst", status: "done", startedAt: Date.now() - 31_000, note: "done" }],
    Date.now(),
  )
  assert.match(lines[0] ?? "", /✓ analyst\s+31s/)
})
```

Then the integration, appended to `test/tui-input.test.ts`:

```ts
test("ctrl+x lalu panah bawah membuka panel sub-agent", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    await tick()

    h.clear()
    h.stdin.press("") // ctrl+x
    await tick(1)
    h.stdin.press("[B") // panah bawah
    await tick()

    assert.match(h.frame(), /sub-agents/)
    assert.match(h.frame(), /explore/)
  } finally {
    h.cleanup()
  }
})

test("x di panel membatalkan satu sub-agent lewat klien", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    await tick()
    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B")
    await tick()

    h.stdin.press("x")
    await tick()

    assert.deepEqual(h.recorded.aborted, ["anak"], "yang dibatalkan sesi ANAK, bukan induk")
  } finally {
    h.cleanup()
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/subagent-panel.test.ts`
Expected: FAIL — cannot find module `subagent-panel.tsx`

- [ ] **Step 3: Implement**

Create `src/tui/subagent-panel.tsx` exporting a pure `panelLines(subagents, now)` plus the `SubagentPanel` component that renders those lines inside a bordered box titled `sub-agents`. Status glyphs: `◐` running, `∅` queued, `✓` done, `✗` failed, `⊘` stopped.

Add to `src/tui/keybinds.ts`:

```ts
  /*
   * Panel sub-agent. `<leader>` lalu panah bawah, sama seperti opencode —
   * muscle memory yang sudah ada lebih berharga daripada tombol yang lebih rapi.
   */
  subagents_panel: "<leader>down",
```

In `src/tui/app.tsx`: add `subagents_panel` to the leader candidate list and a `case` that toggles panel state; render `<SubagentPanel>` above the editor when open; while open, `↑`/`↓` move the selection, `x` calls `client.abort(<child sessionID>)`, and `esc` closes. Put the panel's key handling **before** the popup check, so the two never contend for the arrow keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/subagent-panel.test.ts test/tui-input.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/tui/subagent-panel.tsx src/tui/keybinds.ts src/tui/app.tsx test/subagent-panel.test.ts test/tui-input.test.ts
git commit -m "feat(tui): sub-agent panel with per-agent cancellation"
```

---

## Task 10: `/tim` and the documentation

**Files:**
- Modify: `src/core/command.ts`, `src/core/agent.ts`, `README.md`
- Test: `test/command-tim.test.ts`

**Interfaces:**
- Consumes: `dispatchableAgents`
- Produces: builtin command `tim`

- [ ] **Step 1: Write the failing tests**

```ts
test("/tim adalah giliran biasa dengan roster di system prompt", async () => {
  // Kalau /tim butuh mesin orkestrasi tersendiri, itu tanda `task` dirancang salah.
  const session = createSession(root)
  let systemSeen = ""
  const restore = setModelResolver(() => captureSystem((s) => (systemSeen = s)))
  try {
    await prompt({ sessionID: session.id, text: "/tim perbaiki bug auth" })
    assert.match(systemSeen, /explore/, "roster disebutkan")
    assert.match(systemSeen, /split the work/i)
  } finally {
    restore()
  }
})

test("/tim tanpa sub-agent apa pun menjelaskan cara mendaftarkannya", async () => {
  const session = createSession(root)
  const message = await prompt({ sessionID: session.id, text: "/tim kerjakan sesuatu" })
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
  assert.match(text, /mode.*subagent/i)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/command-tim.test.ts`
Expected: FAIL — `/tim` is an unknown command

- [ ] **Step 3: Implement**

Add `"tim"` to `BUILTIN_COMMANDS` and to `listCommands` in `src/core/command.ts` with the description `"Split one task across your sub-agents"`. Do **not** add it to `IMMEDIATE_COMMANDS` — it takes an argument.

In `src/core/agent.ts`, handle it inside `builtinTurn`: when the roster is empty, answer with `infoTurn` explaining that agents need `"mode": "subagent"` in `titah.json`. Otherwise, fall through to the normal LLM path with an extra system section:

```ts
const TEAM_PROMPT = [
  "For this turn you are coordinating a team. Split the work across these sub-agents and",
  "dispatch them with the `task` tool; several calls in one step run at the same time.",
  "Agents that may write files are serialised for you — do not try to order them yourself.",
  "Do the work that is left over yourself rather than inventing an agent for it.",
].join("\n")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/command-tim.test.ts` → PASS, then the full gate.

- [ ] **Step 5: Update the README**

Add a "Sub-agents" section covering: `mode` and its `"primary"` default and why; `delegate`; that write capability comes from `permission` and that `bash` counts as writing; readers concurrent / writers serialised; `task` and `/tim`; the panel and its keybinding; that a sub-agent never dispatches further sub-agents; and that `/undo` still restores the whole turn rather than one sub-agent.

- [ ] **Step 6: Commit**

```bash
git add src/core/command.ts src/core/agent.ts README.md test/command-tim.test.ts
git commit -m "feat(command): /tim coordinates the sub-agent roster"
```

---

## Manual verification

After Task 10, with the user's own agents transcribed into `titah.json`:

```bash
npm run build
node dist/cli.js
# in the TUI:
/tim map the auth module and list its tests
# then, while it runs:
ctrl+x ↓        # panel shows explore running, qc-developer queued
x               # stop one; the coordinator reports it and carries on
```

Expected: readers appear concurrently, a second writer shows `∅ waiting for a turn`, and stopping one agent leaves the parent turn running.
