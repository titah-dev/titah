# Auto-compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact a session's context automatically — between turns and mid-turn — before the provider's context window overflows, and let each agent declare its own step limit now that the accidental limiter is replaced by a real one.

**Architecture:** A model's context window is declared in config; nothing is guessed. The trigger compares the **last step's** input tokens (not `totalUsage`, which is a sum) against `contextWindow − reserved`. When it fires, the turn-so-far is flushed to storage and then the existing row-based compaction engine runs: prune old tool output first (free), summarise only if that was not enough. Mid-turn is the same path with the flush doing real work; between turns the flush is a no-op.

**Tech Stack:** TypeScript strict (ESM, Node ≥22.6), Zod v4 schemas, AI SDK v7 (`streamText` / `prepareStep`), `node:sqlite`, `node:test` + `node:assert/strict`, `MockLanguageModelV4` from `ai/test`.

**Spec:** `docs/superpowers/specs/2026-08-11-auto-compaction-design.md`

## Global Constraints

- Code comments in **Indonesian**, explaining **WHY**, never WHAT. All user-facing strings in **English**.
- TypeScript strict. **No `any` anywhere in `src/`.**
- **No test may invoke a real provider or a real external CLI.** Tests isolate `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `TITAH_DB`.
- Every task ends green on `npm run typecheck && npm run build && npm test`.
- `.tsx` cannot be loaded by Node directly; TUI tests run against the build.
- **Every negative assertion must first prove a positive** on the same data. Asserting text is absent from a prompt that was never built passes vacuously.
- Prove each fix by **mutation**: undo the fix, confirm the intended test fails.
- Existing behaviour must be preserved when `compaction.auto` is `false` or `contextWindow` is undeclared.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/schema.ts` (modify) | `ProviderModel.contextWindow`, the `Compaction` block, `Agent.steps` |
| `src/core/provider.ts` (modify) | `contextWindowFor()` — model metadata lookup |
| `src/core/compact.ts` (modify) | **Pure policy**: cut points, threshold predicate, token estimate, pruner |
| `src/core/auto-compact.ts` (create) | **The runner**: flush → prune → summarise. Talks to storage and the model |
| `src/core/storage/session.ts` (modify) | `replaceModelMessage()` — the pruner must persist |
| `src/core/message.ts` (modify) | `usage.context` |
| `src/core/agent.ts` (modify) | Last-step token capture, `prepareStep` wiring, flush offset, per-agent `steps` |
| `src/cli.ts` (modify) | `doctor` reports undeclared context windows |
| `src/core/command.ts` (modify) | `/compact` palette fix |

`compact.ts` stays pure so its rules are testable without a database or a model. `auto-compact.ts` is the only new module and holds every side effect.

---

### Task 1: Declaring the context window

**Files:**
- Modify: `src/core/schema.ts:29-31` (`ProviderModel`)
- Modify: `src/core/provider.ts` (add `contextWindowFor`, after `parseModelId` at `:58-66`)
- Modify: `src/cli.ts:307` (`cmdDoctor`)
- Test: `test/provider.test.ts`, `test/cli-doctor.test.ts`

**Interfaces:**
- Consumes: `parseModelId(full): { providerId: string; modelId: string }` from `src/core/provider.ts:58`
- Produces:
  - `ProviderModel.contextWindow?: number`
  - `contextWindowFor(config: Config, full?: string): number | undefined`
  - `undeclaredContextWindows(config: Config): string[]` — model ids in `"provider/model"` form that are configured but have no `contextWindow`

- [ ] **Step 1: Write the failing test**

Append to `test/provider.test.ts`:

```ts
test("contextWindowFor membaca angka yang dideklarasikan config", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: {
      ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } },
    },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), 32768)
})

test("contextWindowFor memakai config.model saat argumennya kosong", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } } },
  })
  assert.equal(contextWindowFor(config), 32768)
})

test("model tanpa contextWindow mengembalikan undefined, BUKAN angka tebakan", () => {
  // Angka yang salah lebih berbahaya daripada tidak ada angka: memadatkan
  // terlalu telat tidak bisa dibedakan dari tidak memadatkan sama sekali,
  // kecuali user sudah telanjur percaya masalahnya tertangani.
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": {} } } },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), undefined)
})

test("id model yang tidak berbentuk provider/model tidak melempar, cuma undefined", () => {
  // contextWindowFor dipanggil di jalur panas tiap langkah. Melempar di sini
  // akan mematikan giliran gara-gara metadata yang hilang.
  const config = Config.parse({ provider: {} })
  assert.equal(contextWindowFor(config, "tanpa-slash"), undefined)
})

test("undeclaredContextWindows menyebut model yang dikonfigurasi tanpa batas", () => {
  const config = Config.parse({
    provider: {
      ollama: {
        models: { "qwen3:14b": { contextWindow: 32768 }, "llama3:8b": {} },
      },
    },
  })
  assert.deepEqual(undeclaredContextWindows(config), ["ollama/llama3:8b"])
})
```

Add to the imports at the top of `test/provider.test.ts`:

```ts
import { contextWindowFor, undeclaredContextWindows } from "../src/core/provider.ts"
import { Config } from "../src/core/schema.ts"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "contextWindowFor"`
Expected: FAIL — `contextWindowFor is not a function` / `undeclaredContextWindows is not a function`.

- [ ] **Step 3: Add the schema field**

In `src/core/schema.ts`, replace `ProviderModel` at `:29-31`:

```ts
export const ProviderModel = z.object({
  name: z.string().optional().describe("Display name for this model"),
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Context window in tokens. Required for automatic compaction on this model."),
})
```

- [ ] **Step 4: Implement the lookups**

Append to `src/core/provider.ts`:

```ts
/**
 * Jendela konteks sebuah model, kalau config menyatakannya.
 *
 * TIDAK ADA tabel bawaan. Angka yang salah lebih berbahaya daripada tidak ada
 * angka: pemadatan yang terlambat tidak bisa dibedakan dari tidak ada pemadatan
 * — sesinya tetap mati, hanya saja user sudah telanjur mengira aman.
 *
 * Tidak pernah melempar: ini dipanggil di jalur panas tiap langkah, dan
 * metadata yang hilang tidak boleh menjatuhkan giliran yang sedang berjalan.
 */
export function contextWindowFor(config: Config, full?: string): number | undefined {
  const target = full ?? config.model
  if (target === undefined) return undefined
  const slash = target.indexOf("/")
  if (slash <= 0 || slash === target.length - 1) return undefined
  const providerId = target.slice(0, slash)
  const modelId = target.slice(slash + 1)
  return config.provider[providerId]?.models[modelId]?.contextWindow
}

/** Model yang dikonfigurasi tapi belum punya `contextWindow`, untuk dilaporkan `doctor`. */
export function undeclaredContextWindows(config: Config): string[] {
  const out: string[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.contextWindow === undefined) out.push(`${providerId}/${modelId}`)
    }
  }
  return out
}
```

`parseModelId` is deliberately **not** reused: it throws, and this function must not.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep -c "^✔"` then `npm run typecheck`
Expected: the five new tests pass, typecheck clean.

- [ ] **Step 6: Write the failing doctor test**

`test/cli-doctor.test.ts` already has both helpers it needs: `isolatedProject(titahJson, skillFiles)` at `:19` and `runDoctor(cwd)` at `:30`, which runs the **built** `dist/cli.js`. Use them as-is.

```ts
test("doctor menyebut model yang belum punya contextWindow beserta jalur confignya", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "llama3:8b": {} },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  // Positif dulu: buktikan bagian Context windows benar-benar dirender,
  // supaya assertion berikutnya tidak lolos pada output kosong.
  assert.match(output, /Context windows/)
  assert.match(output, /ollama\/llama3:8b/)
  assert.match(output, /provider\.ollama\.models/)
})

test("doctor tidak mengeluh saat semua model sudah punya contextWindow", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "llama3:8b": { contextWindow: 8192 } },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /Context windows/)
  assert.match(output, /all configured models declare one/)
  assert.doesNotMatch(output, /ollama\/llama3:8b/)
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `npm run build && npm test 2>&1 | grep -A3 "contextWindow"`
Expected: FAIL — no `Context windows` section in the output.

- [ ] **Step 8: Add the doctor section**

In `src/cli.ts`, inside `cmdDoctor`, insert immediately after the `Providers` block (after the `out()` that follows the provider loop, around `:345`):

```ts
  out("Context windows")
  const undeclared = undeclaredContextWindows(loaded.config)
  if (undeclared.length === 0) {
    out("  all configured models declare one")
  } else {
    for (const id of undeclared) {
      const slash = id.indexOf("/")
      const providerId = id.slice(0, slash)
      const modelId = id.slice(slash + 1)
      out(`  ! ${id} — no contextWindow, automatic compaction is off for it`)
      out(`      add provider.${providerId}.models."${modelId}".contextWindow`)
    }
  }
  out()
```

Add `undeclaredContextWindows` to the existing `provider.ts` import at `src/cli.ts:7`.

- [ ] **Step 9: Run to verify it passes**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.

- [ ] **Step 10: Prove by mutation**

Change `contextWindowFor` to return `32768` when the lookup misses. Run `npm test`. Expected: *"model tanpa contextWindow mengembalikan undefined"* fails. Restore.

- [ ] **Step 11: Commit**

```bash
git add src/core/schema.ts src/core/provider.ts src/cli.ts test/provider.test.ts test/cli-doctor.test.ts
git commit -m "feat(config): declare model context windows, and have doctor name the missing ones"
```

---

### Task 2: The `compaction` config block, and turns instead of messages

**Files:**
- Modify: `src/core/schema.ts` (add `Compaction`, register on `Config`)
- Modify: `src/core/compact.ts:21-42` (`KEEP_TAIL` → `KEEP_TURNS`, `tailStart`)
- Modify: `src/core/compact.ts:59-71` (`planCompaction`)
- Modify: `src/core/agent.ts:725` (`compactTurn` passes the configured value)
- Test: `test/compact.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `ModelRow { seq: number; message: ModelMessage }` from `src/core/storage/session.ts:268`
- Produces:
  - `Config.compaction: { auto: boolean; reserved: number; tailTurns: number; prune: boolean }`
  - `KEEP_TURNS = 2`
  - `tailStart(messages: ModelMessage[], keepTurns?: number): number` — **signature unchanged, meaning changed**
  - `planCompaction(rows: ModelRow[], keepTurns?: number): CompactionPlan` — unchanged shape

- [ ] **Step 1: Write the failing tests**

In `test/compact.test.ts`, replace the existing `tailStart` tests with these (keep the `user`/`assistant`/`rows` helpers at the top of the file):

```ts
const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})
const toolResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "isi" } },
  ],
})

test("keepTurns menghitung GILIRAN user, bukan pesan", () => {
  // KEEP_TAIL lama menghitung pesan, dan satu giliran agentic bisa 20 pesan —
  // sehingga "4 pesan terakhir" bisa berisi empat hasil tool dari tengah
  // giliran, tanpa satu pun pertukaran yang utuh.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    assistant("jawab satu"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
    assistant("jawab dua"),
    user("tiga"),
    assistant("jawab tiga"),
  ]
  const cut = tailStart(messages, 2)
  assert.equal(messages[cut]?.role, "user")
  // Dua giliran terakhir dimulai di "dua" (indeks 4).
  assert.equal(cut, 4)
})

test("keepTurns lebih besar dari jumlah giliran mempertahankan semuanya", () => {
  const messages = [user("satu"), assistant("jawab")]
  assert.equal(tailStart(messages, 5), 0)
})

test("keepTurns 0 memadatkan seluruh riwayat", () => {
  const messages = [user("satu"), assistant("jawab"), user("dua"), assistant("jawab")]
  assert.equal(tailStart(messages, 0), messages.length)
})

test("batas potong SELALU jatuh di pesan user", () => {
  // Memotong di tengah pasangan tool-call/tool-result meninggalkan tool-result
  // yatim di awal riwayat, dan provider menolaknya dengan error yang tidak
  // menyebut pemadatan sama sekali.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
  ]
  const cut = tailStart(messages, 1)
  assert.equal(messages[cut]?.role, "user")
})
```

Append to `test/config.test.ts`:

```ts
test("compaction punya default yang bisa dipakai tanpa konfigurasi apa pun", () => {
  const config = Config.parse({})
  assert.deepEqual(config.compaction, {
    auto: true,
    reserved: 8192,
    tailTurns: 2,
    prune: true,
  })
})

test("compaction.auto false bisa dinyatakan tanpa menyebut field lain", () => {
  const config = Config.parse({ compaction: { auto: false } })
  assert.equal(config.compaction.auto, false)
  assert.equal(config.compaction.tailTurns, 2)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -B2 -A6 "keepTurns\|compaction punya default"`
Expected: FAIL — `tailStart` still counts messages (`cut` is not 4), and `config.compaction` is `undefined`.

- [ ] **Step 3: Add the config block**

In `src/core/schema.ts`, add before `export const Config`:

```ts
export const Compaction = z
  .object({
    auto: z.boolean().default(true).describe("Compact automatically when the context fills up"),
    reserved: z
      .number()
      .int()
      .min(0)
      .default(8192)
      .describe(
        "Tokens held back from the window, covering the next response and the summarisation call itself",
      ),
    tailTurns: z
      .number()
      .int()
      .min(0)
      .default(2)
      .describe("Recent user turns kept verbatim, never summarised"),
    prune: z
      .boolean()
      .default(true)
      .describe("Drop old tool output before summarising — free, and tool output is the bulk of it"),
  })
  .describe("Automatic context compaction. Requires contextWindow on the model in use.")
```

Register it on `Config`, next to `permission`:

```ts
  compaction: Compaction.default({ auto: true, reserved: 8192, tailTurns: 2, prune: true }),
```

And export the type next to the others at the bottom:

```ts
export type Compaction = z.infer<typeof Compaction>
```

- [ ] **Step 4: Rewrite `tailStart` to count turns**

In `src/core/compact.ts`, replace `KEEP_TAIL` and `tailStart` (`:14-42`):

```ts
/**
 * Berapa GILIRAN user terakhir yang tetap dikirim apa adanya.
 *
 * Dihitung dalam giliran, bukan pesan: satu giliran agentic bisa berisi dua
 * puluh pesan, jadi "4 pesan terakhir" bisa berarti empat hasil tool dari
 * tengah giliran — instruksinya sudah hilang, dan tidak satu pun pertukaran
 * tersisa utuh. Giliran adalah satuan yang bisa dibayangkan user.
 */
export const KEEP_TURNS = 2

/**
 * Batas potong: indeks pesan pertama yang dipertahankan.
 *
 * Wajib jatuh di pesan `user`. Memotong di tengah pasangan tool-call/tool-result
 * meninggalkan tool-result yatim di awal riwayat, dan provider menolak itu
 * dengan error yang tidak menyebut pemadatan sama sekali.
 */
export function tailStart(messages: ModelMessage[], keepTurns = KEEP_TURNS): number {
  if (keepTurns <= 0) return messages.length

  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue
    seen += 1
    if (seen === keepTurns) return index
  }
  // Giliran yang ada lebih sedikit dari yang diminta — pertahankan semuanya.
  return 0
}
```

- [ ] **Step 5: Update `planCompaction`'s parameter name**

In `src/core/compact.ts:59`, change the signature and the call through:

```ts
export function planCompaction(rows: ModelRow[], keepTurns = KEEP_TURNS): CompactionPlan {
  const messages = rows.map((row) => row.message)
  const cut = tailStart(messages, keepTurns)
```

The rest of the function body is unchanged.

- [ ] **Step 6: Pass the configured value from `/compact`**

In `src/core/agent.ts`, in `compactTurn` (around `:733`), change:

```ts
  const plan = planCompaction(rows, config.compaction.tailTurns)
```

- [ ] **Step 7: Fix remaining references**

Run: `npm run typecheck`
Expected: errors wherever `KEEP_TAIL` is still imported. Update every one to `KEEP_TURNS`, including `test/compact.test.ts` and `test/compact-storage.test.ts`.

- [ ] **Step 8: Run everything**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.

- [ ] **Step 9: Prove by mutation**

Change `tailStart` back to `messages.length - keepTurns` as its starting index. Run `npm test`. Expected: *"keepTurns menghitung GILIRAN user, bukan pesan"* fails on `cut === 4`. Restore.

- [ ] **Step 10: Commit**

```bash
git add src/core/schema.ts src/core/compact.ts src/core/agent.ts test/compact.test.ts test/config.test.ts test/compact-storage.test.ts
git commit -m "feat(compact): count kept history in user turns, and add the compaction config block"
```

---

### Task 3: The threshold, and the last-step token signal

**Files:**
- Modify: `src/core/compact.ts` (add `overBudget`)
- Modify: `src/core/message.ts:52` (`usage.context`)
- Modify: `src/core/agent.ts:378-390` (the `finish` case)
- Test: `test/compact.test.ts`, `test/agent.test.ts`

**Interfaces:**
- Consumes: `Config.compaction` from Task 2, `contextWindowFor` from Task 1
- Produces:
  - `overBudget(lastStepTokens: number | undefined, contextWindow: number | undefined, reserved: number): boolean`
  - `Message.usage.context?: number` — input tokens of the **final step**

- [ ] **Step 1: Write the failing tests**

Append to `test/compact.test.ts`:

```ts
test("overBudget menyala saat langkah terakhir mencapai window dikurangi reserved", () => {
  assert.equal(overBudget(24576, 32768, 8192), true)
  assert.equal(overBudget(24575, 32768, 8192), false)
})

test("contextWindow yang tidak dideklarasikan TIDAK PERNAH memicu", () => {
  // Tanpa batas yang dinyatakan, tidak ada ambang yang bisa dihitung. Menebak
  // di sini berarti memadatkan pada waktu yang salah dan menyembunyikan bahwa
  // fitur ini sebenarnya tidak aktif untuk model tersebut.
  assert.equal(overBudget(999_999, undefined, 8192), false)
})

test("token yang belum terukur TIDAK memicu", () => {
  // Sebelum langkah pertama selesai, tidak ada angka dari provider. Memadatkan
  // di titik itu berarti meringkas riwayat yang belum tentu terlalu besar.
  assert.equal(overBudget(undefined, 32768, 8192), false)
})

test("reserved lebih besar dari window memicu segera, bukan diam-diam mati", () => {
  // Config yang keliru harus terlihat sebagai pemadatan agresif, bukan sebagai
  // fitur yang seolah-olah mati.
  assert.equal(overBudget(1, 8192, 16384), true)
})
```

Append to `test/agent.test.ts`:

```ts
test("usage.context adalah input langkah TERAKHIR, bukan jumlah seluruh langkah", async () => {
  // totalUsage MENJUMLAHKAN tiap langkah. Giliran 20 langkah dengan konteks
  // tetap 15k melaporkan input ~300k — memakainya sebagai ambang berarti
  // memadatkan terus-menerus sambil terlihat seperti fitur yang bekerja.
  mockStreaming([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(100) },
    ],
    [
      { type: "text-delta", id: "t", delta: "selesai" },
      { type: "finish", finishReason: "stop", usage: usageWith(180) },
    ],
  ])

  const session = createSession(project)
  const message = await prompt({ sessionID: session.id, text: "baca halo.txt" })

  assert.equal(message.usage?.context, 180)
  assert.equal(message.usage?.input, 280)
  assert.notEqual(message.usage?.context, message.usage?.input)
})
```

- [ ] **Step 1b: Build the shared test harness that Tasks 5–8 also use**

Every later task needs three things `test/agent.test.ts` does not have yet: usage with a chosen input count, a mock whose recorded calls survive, and a per-test project with its own `titah.json`. Build all three now, once.

Add next to `USAGE` at `test/agent.test.ts:60`:

```ts
/** Bentuk usage LanguageModelV4 dengan input token tertentu. */
function usageWith(inputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: undefined, reasoning: undefined },
  }
}

/**
 * Seperti `mockStreaming`, tapi MENGEMBALIKAN model-nya sehingga
 * `doStreamCalls` bisa diperiksa.
 *
 * Yang diperiksa lewat `doStreamCalls[n].prompt` adalah apa yang BENAR-BENAR
 * diterima provider. Test yang cuma membuktikan sebuah fungsi terpanggil tidak
 * membuktikan apa pun tentang isi permintaannya.
 */
function recordingModel(chunks: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = chunks[Math.min(call, chunks.length - 1)] as LanguageModelV4StreamPart[]
      call += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  restore = setModelResolver(() => model)
  return model
}

/** Proyek sementara dengan titah.json sendiri — `prompt()` memuat config dari direktori sesi. */
function projectWith(titahJson: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(root, "proyek-"))
  fs.writeFileSync(path.join(dir, "halo.txt"), "baris satu\nbaris dua\n")
  fs.writeFileSync(
    path.join(dir, "titah.json"),
    JSON.stringify({ skills: { discover: [], paths: [] }, ...titahJson }),
  )
  return dir
}

/** Config yang menyatakan jendela konteks untuk model yang dipakai test. */
function windowConfig(contextWindow: number, extra: Record<string, unknown> = {}) {
  return {
    model: "mock/m",
    provider: { mock: { models: { m: { contextWindow } } } },
    ...extra,
  }
}
```

**Important, and easy to get wrong:** `synthesizerFor` (`src/core/consensus.ts:157`) calls `streamText`, so the summariser is served by the **same mock** and advances the **same `call` counter**. A test that triggers compaction must budget one `chunks` entry for the summary. State this in a comment wherever it matters, and prefer a single-element `chunks` array (the mock repeats its last entry) when the exact call order is not what is under test.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -A4 "overBudget\|usage.context"`
Expected: FAIL — `overBudget is not a function`, and `usage.context` is `undefined`.

- [ ] **Step 3: Implement the predicate**

Append to `src/core/compact.ts`:

```ts
/**
 * Apakah konteks sudah cukup penuh untuk dipadatkan.
 *
 * `lastStepTokens` WAJIB input token satu langkah, bukan `totalUsage` yang
 * menjumlahkan seluruh langkah. Giliran 20 langkah dengan konteks tetap 15k
 * melaporkan totalUsage ~300k; memakainya di sini memicu pemadatan terus-menerus
 * sambil terlihat persis seperti fitur yang sedang bekerja.
 *
 * Batas yang tidak dideklarasikan berarti mati, bukan ditebak — lihat
 * `contextWindowFor`.
 */
export function overBudget(
  lastStepTokens: number | undefined,
  contextWindow: number | undefined,
  reserved: number,
): boolean {
  if (lastStepTokens === undefined || contextWindow === undefined) return false
  return lastStepTokens >= contextWindow - reserved
}
```

- [ ] **Step 4: Add the message field**

In `src/core/message.ts:52`:

```ts
  /**
   * `input` adalah total penagihan seluruh langkah; `context` adalah input
   * langkah TERAKHIR, yaitu ukuran konteks sesungguhnya. Dua besaran berbeda
   * yang tidak boleh berbagi satu field — menukarnya membuat ambang pemadatan
   * menyala jauh terlalu dini.
   */
  usage?: { input?: number; output?: number; context?: number }
```

- [ ] **Step 5: Capture it in the turn**

In `src/core/agent.ts`, the `finish` case at `:378-390` reports `totalUsage`. Add a per-step capture. Above the `for await` loop, declare:

```ts
    // Input token langkah TERAKHIR — ukuran konteks, bukan total penagihan.
    let lastStepTokens: number | undefined
```

Then extend the stream switch with a `finish-step` case (place it directly above `case "finish"`):

```ts
        case "finish-step": {
          const input = part.usage?.inputTokens
          if (input !== undefined) lastStepTokens = input
          break
        }
```

And in the existing `case "finish"`, add `context` alongside `input`/`output`:

```ts
            ...(lastStepTokens !== undefined ? { context: lastStepTokens } : {}),
```

The part name is verified, not guessed: `TextStreamFinishStepPart` is declared at `node_modules/ai/dist/index.d.ts:2909` as `{ type: 'finish-step'; usage: LanguageModelUsage; … }`, and `LanguageModelUsage.inputTokens` is `number | undefined` (`:320-324`) — a plain number at this layer, unlike the nested object the provider-level mock emits.

- [ ] **Step 6: Run to verify they pass**

Run: `npm run typecheck && npm test 2>&1 | grep -A4 "usage.context"`
Expected: PASS.

- [ ] **Step 7: Prove by mutation**

In `agent.ts`, set `context: part.totalUsage.inputTokens` instead of `lastStepTokens`. Run `npm test`. Expected: *"usage.context adalah input langkah TERAKHIR"* fails with `280 !== 180`. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/core/compact.ts src/core/message.ts src/core/agent.ts test/compact.test.ts test/agent.test.ts
git commit -m "feat(compact): add the budget predicate and record the last step's context size"
```

---

### Task 4: Pure policy — the pruner, the estimate, and the mid-turn cut

Everything in this task is a pure function plus one storage write. Task 5's runner needs **all** of it, so it lands together and the runner is written once, correctly.

**Files:**
- Modify: `src/core/compact.ts` (add `estimateTokens`, `pruneToolOutputs`, `midTurnCut`, `planAtCut`)
- Modify: `src/core/storage/session.ts` (add `replaceModelMessage`)
- Test: `test/compact.test.ts`, `test/storage.test.ts`

**Interfaces:**
- Consumes: `ModelRow`, `CompactionPlan`, `tailStart` from Task 2
- Produces:
  - `BYTES_PER_TOKEN = 8`
  - `estimateTokens(bytes: number): number`
  - `pruneToolOutputs(messages: ModelMessage[], upTo: number): { messages: ModelMessage[]; bytesFreed: number }`
  - `MID_TURN_KEEP = 6`
  - `midTurnCut(messages: ModelMessage[], keepMessages: number): number`
  - `planAtCut(rows: ModelRow[], cut: number): CompactionPlan`
  - `replaceModelMessage(sessionID: string, seq: number, message: ModelMessage): void`

- [ ] **Step 1: Write the failing tests**

Append to `test/compact.test.ts`:

```ts
test("pruner mengganti output tool dengan penanda, TIDAK menghapus pesannya", () => {
  // Menghapus pesan `tool` akan meninggalkan tool-call tanpa hasilnya, dan
  // provider menolak riwayat seperti itu. Penanda menjaga strukturnya utuh.
  const messages = [
    user("satu"),
    toolCall("a"),
    toolResult("a"),
    user("dua"),
    toolCall("b"),
    toolResult("b"),
  ]
  const { messages: pruned, bytesFreed } = pruneToolOutputs(messages, 3)

  assert.equal(pruned.length, messages.length)
  assert.equal(pruned[2]?.role, "tool")
  assert.ok(bytesFreed > 0)

  const first = JSON.stringify(pruned[2])
  assert.match(first, /output was dropped/)
  assert.doesNotMatch(first, /isi/)

  // Di luar batas potong tidak disentuh sama sekali.
  const last = JSON.stringify(pruned[5])
  assert.match(last, /isi/)
})

test("pruner tidak mengubah array aslinya", () => {
  const messages = [toolCall("a"), toolResult("a")]
  const before = JSON.stringify(messages)
  pruneToolOutputs(messages, 2)
  assert.equal(JSON.stringify(messages), before)
})

test("prune kedua atas hasil yang sama tidak membebaskan byte lagi", () => {
  // Tanpa ini, pemicu akan mengira prune selalu menolong dan tidak pernah
  // naik ke peringkasan — sesinya lalu mati persis seperti sebelum fitur ada.
  const messages = [toolCall("a"), toolResult("a")]
  const once = pruneToolOutputs(messages, 2)
  const twice = pruneToolOutputs(once.messages, 2)
  assert.equal(twice.bytesFreed, 0)
})

test("estimateTokens MEREMEHKAN penghematan, tidak melebih-lebihkannya", () => {
  // Dua arah kesalahan tidak setara: meremehkan berarti satu panggilan
  // smallModel yang mubazir; melebih-lebihkan berarti melewatkan peringkasan
  // yang dibutuhkan lalu mengirim permintaan kebesaran — kegagalan yang jadi
  // alasan seluruh fitur ini dibangun.
  const realistic = 4 // byte per token pada teks nyata
  const bytes = 40_000
  assert.ok(estimateTokens(bytes) < bytes / realistic)
})

test("potong mid-turn tidak pernah jatuh di pesan tool", () => {
  // Di tengah giliran tidak ada pesan user setelah giliran dimulai, jadi aturan
  // tailStart tidak berlaku. Memotong di pesan `tool` meninggalkan hasil tanpa
  // panggilannya, dan provider menolaknya dengan error yang tidak menyebut
  // pemadatan sama sekali.
  const messages = [
    user("kerjakan"),
    toolCall("a"),
    toolResult("a"),
    toolCall("b"),
    toolResult("b"),
    toolCall("c"),
    toolResult("c"),
  ]
  for (let keep = 1; keep <= messages.length; keep += 1) {
    const cut = midTurnCut(messages, keep)
    assert.notEqual(messages[cut]?.role, "tool", `keep=${keep} memotong di pesan tool`)
  }
})

test("potong mid-turn mundur ke indeks aman terdekat, tidak maju", () => {
  // Maju berarti membuang lebih banyak dari yang diminta — termasuk hasil tool
  // terbaru yang justru paling dibutuhkan model untuk melanjutkan.
  const messages = [user("kerjakan"), toolCall("a"), toolResult("a"), toolCall("b"), toolResult("b")]
  const cut = midTurnCut(messages, 2)
  assert.equal(cut, 3)
  assert.equal(messages[cut]?.role, "assistant")
})

test("potong mid-turn nol saat tidak ada indeks aman", () => {
  const messages = [toolResult("a"), toolResult("b")]
  assert.equal(midTurnCut(messages, 1), 0)
})

test("planAtCut dan planCompaction sepakat soal batas air", () => {
  // Satu aturan batas air, bukan dua. Kalau keduanya menyimpang, jalur
  // mid-turn dan antar-giliran akan menandai titik berbeda sebagai "sudah
  // diringkas", dan sebagian riwayat terkirim dua kali atau hilang.
  const messages = [user("satu"), assistant("a"), user("dua"), assistant("b")]
  const list = rows(messages, 10)
  assert.deepEqual(planCompaction(list, 1), planAtCut(list, tailStart(messages, 1)))
})
```

Append to `test/storage.test.ts`:

```ts
test("replaceModelMessage menimpa satu baris tanpa menyentuh urutannya", () => {
  const session = createSession(dir)
  appendModelMessages(session.id, [
    { role: "user", content: "satu" },
    { role: "assistant", content: "dua" },
  ])
  const rows = listModelRows(session.id)
  const target = rows[1]
  assert.ok(target)

  replaceModelMessage(session.id, target.seq, { role: "assistant", content: "diganti" })

  const after = listModelRows(session.id)
  assert.equal(after.length, 2)
  assert.deepEqual(
    after.map((row) => row.seq),
    rows.map((row) => row.seq),
  )
  assert.equal(after[1]?.message.content, "diganti")
  assert.equal(after[0]?.message.content, "satu")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -A4 "pruner\|estimateTokens\|replaceModelMessage"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the pruner**

Append to `src/core/compact.ts`:

```ts
/**
 * Rasio byte→token yang SENGAJA meremehkan.
 *
 * Teks nyata kira-kira 4 byte per token. Angka 8 di sini membuat penghematan
 * hasil prune selalu ditaksir lebih kecil dari sebenarnya, sehingga keputusan
 * "masih perlu diringkas?" condong ke arah meringkas. Dua arah kesalahannya
 * tidak setara: menaksir terlalu rendah cuma menambah satu panggilan
 * smallModel; menaksir terlalu tinggi berarti melewatkan peringkasan yang
 * dibutuhkan lalu mengirim permintaan kebesaran.
 */
export const BYTES_PER_TOKEN = 8

export function estimateTokens(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_TOKEN)
}

/** Penanda yang menggantikan output tool yang dibuang. */
const PRUNED = "[output was dropped to free context — re-run the tool if you need it]"

/**
 * Membuang output hasil tool SEBELUM `upTo`, tanpa menghapus satu pesan pun.
 *
 * Pesan `tool` yang dihapus akan meninggalkan tool-call tanpa hasilnya, dan
 * provider menolak riwayat semacam itu. Karena itu yang diganti hanya ISI-nya.
 *
 * Ini mekanisme yang murah: tidak ada panggilan model sama sekali, sementara di
 * giliran agentic output tool memang bagian terbesar konteks. Risikonya model
 * membaca ulang berkas — itu bisa dipulihkan, beda dari ringkasan yang
 * diam-diam menjatuhkan sebuah keputusan.
 */
export function pruneToolOutputs(
  messages: ModelMessage[],
  upTo: number,
): { messages: ModelMessage[]; bytesFreed: number } {
  let bytesFreed = 0

  const out = messages.map((message, index) => {
    if (index >= upTo) return message
    if (message.role !== "tool" || typeof message.content === "string") return message

    const parts = message.content as { type: string; [key: string]: unknown }[]
    let changed = false
    const next = parts.map((part) => {
      if (part["type"] !== "tool-result") return part
      const output = part["output"]
      const rendered = JSON.stringify(output ?? "")
      if (rendered === JSON.stringify({ type: "text", value: PRUNED })) return part
      bytesFreed += Buffer.byteLength(rendered)
      changed = true
      return { ...part, output: { type: "text", value: PRUNED } }
    })

    return changed ? ({ ...message, content: next } as ModelMessage) : message
  })

  return { messages: out, bytesFreed }
}

/**
 * Berapa pesan terakhir yang dipertahankan saat memadatkan DI TENGAH giliran.
 *
 * Bukan giliran, karena di tengah giliran tidak ada batas giliran untuk
 * dihitung. Enam cukup untuk menyisakan beberapa hasil tool terakhir, yang
 * biasanya persis yang sedang dipakai model untuk memutuskan langkah berikutnya.
 */
export const MID_TURN_KEEP = 6

/**
 * Batas potong untuk pemadatan di tengah giliran.
 *
 * Aturannya satu: JANGAN memotong di pesan `tool`. Pesan itu memuat hasil dari
 * tool-call di pesan sebelumnya; memotong di situ meninggalkan hasil tanpa
 * panggilannya, dan provider menolak riwayat seperti itu dengan error yang
 * tidak menyebut pemadatan sama sekali. Memotong di pesan `assistant` yang
 * berisi tool-call justru aman, karena hasilnya menyusul dan ikut disimpan.
 *
 * Selalu MUNDUR ke indeks aman, tidak pernah maju: maju berarti membuang lebih
 * banyak dari yang diminta.
 */
export function midTurnCut(messages: ModelMessage[], keepMessages: number): number {
  let cut = Math.max(0, messages.length - keepMessages)
  while (cut > 0 && messages[cut]?.role === "tool") cut -= 1
  return cut
}
```

- [ ] **Step 3b: Give the watermark exactly one owner**

`planCompaction` and the mid-turn path must not each compute a watermark. Replace `planCompaction` in `src/core/compact.ts` with a delegating pair:

```ts
/**
 * `planCompaction` dengan batas potong yang sudah ditentukan pemanggil.
 *
 * Dipakai jalur mid-turn, yang batas amannya dihitung `midTurnCut` dan bukan
 * dari giliran user. Aturan batas air hidup DI SINI SAJA — dua salinan akan
 * menandai titik berbeda sebagai "sudah diringkas", dan sebagian riwayat lalu
 * terkirim dua kali atau hilang sama sekali.
 */
export function planAtCut(rows: ModelRow[], cut: number): CompactionPlan {
  const dropped = rows.slice(0, cut).map((row) => row.message)
  // Batas air = seq terakhir yang diringkas. Kalau semuanya diringkas, itu seq
  // baris terakhir; kalau tidak, satu di bawah baris pertama yang dipertahankan.
  const firstKept = rows[cut]
  const lastRow = rows.at(-1)
  const watermark = firstKept ? firstKept.seq - 1 : (lastRow?.seq ?? -1)
  return { dropped, watermark, kept: rows.length - cut }
}

export function planCompaction(rows: ModelRow[], keepTurns = KEEP_TURNS): CompactionPlan {
  const messages = rows.map((row) => row.message)
  return planAtCut(rows, tailStart(messages, keepTurns))
}
```

- [ ] **Step 4: Implement the storage write**

Append to `src/core/storage/session.ts`, next to `appendModelMessages`:

```ts
/**
 * Menimpa satu baris riwayat di tempat.
 *
 * Dipakai pruner: nomor urut WAJIB tidak berubah, karena batas air pemadatan
 * menunjuk ke `seq`. Menulis ulang sebagai baris baru akan memindahkan pesan ke
 * sisi lain batas air dan membuatnya dikirim dua kali.
 */
export function replaceModelMessage(
  sessionID: string,
  seq: number,
  message: ModelMessage,
): void {
  database()
    .prepare("UPDATE model_message SET data = ? WHERE session_id = ? AND seq = ?")
    .run(JSON.stringify(message), sessionID, seq)
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 6: Prove by mutation**

Set `BYTES_PER_TOKEN = 2`. Run `npm test`. Expected: *"estimateTokens MEREMEHKAN penghematan"* fails. Restore.

Then make `pruneToolOutputs` filter out `tool` messages instead of rewriting them. Expected: *"pruner mengganti output tool dengan penanda, TIDAK menghapus pesannya"* fails on the length assertion. Restore.

Then change `midTurnCut`'s `cut -= 1` to `cut += 1`. Expected: *"potong mid-turn tidak pernah jatuh di pesan tool"* fails. Restore.

Then give `planAtCut` a different watermark rule (`firstKept.seq` instead of `firstKept.seq - 1`). Expected: *"planAtCut dan planCompaction sepakat soal batas air"* fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/core/compact.ts src/core/storage/session.ts test/compact.test.ts test/storage.test.ts
git commit -m "feat(compact): prune old tool output, and add the mid-turn cut rule

The watermark rule now lives only in planAtCut; planCompaction delegates to it,
so the mid-turn and between-turns paths cannot drift apart on where 'already
summarised' ends."
```

---

### Task 5: The runner, and the between-turns trigger

**Files:**
- Create: `src/core/auto-compact.ts`
- Create: `test/auto-compact.test.ts`
- Modify: `src/core/agent.ts` (call it before the turn's `streamText`)

**Interfaces:**
- Consumes: `overBudget`, `estimateTokens`, `pruneToolOutputs`, `planCompaction`, `COMPACT_SYSTEM`, `compactPrompt`, `wrapSummary` from `src/core/compact.ts`; `listModelRows`, `latestCompaction`, `saveCompaction`, `replaceModelMessage` from `src/core/storage/session.ts`; `synthesizerFor` from `src/core/consensus.ts`
- Produces:

```ts
export interface AutoCompactInput {
  sessionID: string
  compaction: Compaction          // config block from Task 2
  contextWindow: number | undefined
  lastStepTokens: number | undefined
  /** Peringkas: (system, prompt) => summary. Disuntik supaya bisa diuji tanpa provider. */
  summarise: (system: string, prompt: string) => Promise<string>
  /** Instruksi giliran berjalan, diteruskan sebagai `focus`. */
  focus?: string
  /** Batas potong mid-turn, dipakai Task 6. Antar-giliran biarkan undefined. */
  midTurnKeep?: number
}

export interface AutoCompactResult {
  ran: boolean
  prunedBytes: number
  summarised: boolean
}

export async function autoCompact(input: AutoCompactInput): Promise<AutoCompactResult>
```

- [ ] **Step 1: Write the failing tests**

Create `test/auto-compact.test.ts`, following the isolation preamble used by `test/compact-storage.test.ts`:

```ts
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import type { ModelMessage } from "ai"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-autocompact-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "autocompact.db")
process.env.HOME = path.join(root, "home")

const { autoCompact } = await import("../src/core/auto-compact.ts")
const { createSession, appendModelMessages, listModelRows, latestCompaction, listModelMessages } =
  await import("../src/core/storage/session.ts")

after(() => fs.rmSync(root, { recursive: true, force: true }))

const CONFIG = { auto: true, reserved: 100, tailTurns: 1, prune: true }

const bigResult = (id: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "text", value: "x".repeat(20_000) },
    },
  ],
})
const call = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
})

function seed(): string {
  const session = createSession(root)
  appendModelMessages(session.id, [
    { role: "user", content: "giliran satu" },
    call("a"),
    bigResult("a"),
    { role: "assistant", content: "selesai satu" },
    { role: "user", content: "giliran dua" },
    { role: "assistant", content: "selesai dua" },
  ])
  return session.id
}

test("di bawah ambang, tidak melakukan apa pun", async () => {
  const sessionID = seed()
  const before = listModelRows(sessionID)

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 32768,
    lastStepTokens: 10,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })

  assert.equal(result.ran, false)
  assert.deepEqual(listModelRows(sessionID), before)
})

test("contextWindow yang tidak dideklarasikan tidak pernah menjalankan apa pun", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: undefined,
    lastStepTokens: 999_999,
    summarise: async () => {
      throw new Error("peringkas tidak boleh dipanggil")
    },
  })
  assert.equal(result.ran, false)
})

test("prune jalan lebih dulu, dan tersimpan ke baris", async () => {
  const sessionID = seed()

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 950,
    summarise: async () => "RINGKASAN",
  })

  assert.equal(result.ran, true)
  assert.ok(result.prunedBytes > 10_000)

  // Positif dulu: barisnya memang masih ada dan strukturnya utuh.
  const rows = listModelRows(sessionID)
  assert.equal(rows.length, 6)
  assert.equal(rows[2]?.message.role, "tool")
  // Baru negatif: isinya sudah tidak ada.
  assert.doesNotMatch(JSON.stringify(rows[2]?.message), /xxxxx/)
})

test("prune yang tidak cukup naik ke peringkasan", async () => {
  const sessionID = seed()
  let called = 0

  const result = await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999, // jauh di atas apa pun yang bisa dibebaskan prune
    summarise: async (system, prompt) => {
      called += 1
      assert.match(system, /compress a coding session/)
      assert.match(prompt, /giliran satu/)
      return "RINGKASAN"
    },
  })

  assert.equal(called, 1)
  assert.equal(result.summarised, true)
  assert.equal(latestCompaction(sessionID)?.summary.includes("RINGKASAN"), true)

  // Giliran terakhir tetap utuh — itu arti tailTurns.
  const visible = listModelMessages(sessionID)
  assert.match(JSON.stringify(visible), /giliran dua/)
})

test("focus diteruskan ke prompt peringkas", async () => {
  const sessionID = seed()
  let seen = ""
  await autoCompact({
    sessionID,
    compaction: CONFIG,
    contextWindow: 1000,
    lastStepTokens: 999_999,
    focus: "modul autentikasi",
    summarise: async (_system, prompt) => {
      seen = prompt
      return "RINGKASAN"
    },
  })
  assert.match(seen, /modul autentikasi/)
})

test("prune: false melewatkan prune dan langsung meringkas", async () => {
  const sessionID = seed()
  const result = await autoCompact({
    sessionID,
    compaction: { ...CONFIG, prune: false },
    contextWindow: 1000,
    lastStepTokens: 999_999,
    summarise: async () => "RINGKASAN",
  })
  assert.equal(result.prunedBytes, 0)
  assert.equal(result.summarised, true)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -A4 "auto-compact"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

Create `src/core/auto-compact.ts`:

```ts
import type { ModelMessage } from "ai"
import {
  COMPACT_SYSTEM,
  compactPrompt,
  estimateTokens,
  midTurnCut,
  overBudget,
  planAtCut,
  pruneToolOutputs,
  renderTranscript,
  tailStart,
  wrapSummary,
} from "./compact.ts"
import type { Compaction } from "./schema.ts"
import {
  latestCompaction,
  listModelRows,
  replaceModelMessage,
  saveCompaction,
} from "./storage/session.ts"

export interface AutoCompactInput {
  sessionID: string
  compaction: Compaction
  contextWindow: number | undefined
  lastStepTokens: number | undefined
  summarise: (system: string, prompt: string) => Promise<string>
  focus?: string
  midTurnKeep?: number
}

export interface AutoCompactResult {
  ran: boolean
  prunedBytes: number
  summarised: boolean
}

const IDLE: AutoCompactResult = { ran: false, prunedBytes: 0, summarised: false }

/**
 * Memadatkan konteks sesi saat sudah mendekati batas jendela model.
 *
 * Satu jalur untuk dua situasi. Di tengah giliran, pemanggil sudah lebih dulu
 * menuliskan pesan giliran-sejauh-ini menjadi baris — sesuatu yang toh akan
 * ditulis di akhir giliran. Dengan begitu mesin pemadatan yang sudah ada (yang
 * bekerja atas baris dan batas air) dipakai apa adanya, alih-alih membangun
 * jalur kedua atas array di memori yang tidak meninggalkan jejak dan langsung
 * terhapus begitu gilirannya usai.
 */
export async function autoCompact(input: AutoCompactInput): Promise<AutoCompactResult> {
  const { compaction, sessionID } = input
  if (!compaction.auto) return IDLE
  if (!overBudget(input.lastStepTokens, input.contextWindow, compaction.reserved)) return IDLE

  const previous = latestCompaction(sessionID)
  const rows = listModelRows(sessionID).filter((row) => !previous || row.seq > previous.seq)
  if (rows.length === 0) return IDLE

  const messages = rows.map((row) => row.message)
  const cut =
    input.midTurnKeep === undefined
      ? tailStart(messages, compaction.tailTurns)
      : midTurnCut(messages, input.midTurnKeep)

  let prunedBytes = 0
  if (compaction.prune && cut > 0) {
    const pruned = pruneToolOutputs(messages, cut)
    prunedBytes = pruned.bytesFreed
    if (prunedBytes > 0) {
      for (const [index, message] of pruned.messages.entries()) {
        if (message === messages[index]) continue
        const row = rows[index]
        if (row) replaceModelMessage(sessionID, row.seq, message)
      }
    }
  }

  // Estimasi HANYA untuk keputusan tingkat kedua ini. Pemicunya sendiri tetap
  // memakai angka yang dilaporkan provider, tidak pernah taksiran.
  const remaining = (input.lastStepTokens ?? 0) - estimateTokens(prunedBytes)
  if (!overBudget(remaining, input.contextWindow, compaction.reserved)) {
    return { ran: true, prunedBytes, summarised: false }
  }

  // Batas potong yang SAMA dengan yang dipakai prune — satu aturan, bukan dua.
  const plan = planAtCut(rows, cut)
  if (plan.dropped.length === 0) return { ran: true, prunedBytes, summarised: false }

  // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk — menumpuk
  // membuat ringkasan tumbuh tanpa batas, persis masalah yang mau dipecahkan.
  const source = previous
    ? `${previous.summary}\n\n${renderTranscript(plan.dropped)}`
    : renderTranscript(plan.dropped)

  const summary = await input.summarise(COMPACT_SYSTEM, compactPrompt(source, input.focus))
  if (summary.trim() === "") return { ran: true, prunedBytes, summarised: false }

  saveCompaction(sessionID, plan.watermark, wrapSummary(summary))
  return { ran: true, prunedBytes, summarised: true }
}
```

Import `midTurnCut` and `planAtCut` from `./compact.ts` as well — both landed in Task 4, so the runner is written once with its real branch.

**Note on the summarisation source:** `planAtCut(rows, cut)` runs on the **pre-prune** `rows`, so the summary is written from the full, un-pruned text. That is deliberate: the summary is the only surviving record of that material, and writing it from text whose tool output was just discarded would lose the same detail twice. Pruning still applies to the rows on disk; only the summariser sees the original.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run typecheck && npm test 2>&1 | grep -A4 "auto-compact"`
Expected: PASS.

- [ ] **Step 5: Wire the between-turns trigger**

In `src/core/agent.ts`, immediately before `const history = listModelMessages(session.id)` (around `:315`), add:

```ts
  // Ambang dibaca dari giliran SEBELUMNYA: `usage.context` pesan assistant
  // terakhir yang PUNYA angka itu. Bukan sekadar yang terakhir — giliran yang
  // gagal atau dibatalkan tidak pernah sempat mengukur apa pun, dan memakainya
  // akan mematikan pemadatan otomatis sampai ada giliran yang sukses.
  const lastMeasured = listMessages(session.id)
    .filter((message) => message.role === "assistant" && message.usage?.context !== undefined)
    .at(-1)
  const contextWindow = contextWindowFor(config, agentDef?.model ?? modelOverride)
  await autoCompact({
    sessionID: session.id,
    compaction: config.compaction,
    contextWindow,
    lastStepTokens: lastMeasured?.usage?.context,
    summarise: synthesizerFor(resolver(config, config.smallModel ?? input.model)),
    focus: text,
  })
```

`contextWindow` is declared here rather than inline because Task 6's `prepareStep` reuses the same value.

Import `autoCompact` from `./auto-compact.ts`, `contextWindowFor` from `./provider.ts`, and `listMessages` from `./storage/session.ts` if not already imported.

**Why no explicit "reset the counter after compacting":** every check reads a number the provider reported for a request that was actually sent. After a between-turns compaction, the turn's own steps produce a fresh, smaller `usage.context`, so the following turn reads the new number, not the stale one. Mid-turn (Task 6) is the same: compacting in `prepareStep(N)` means `prepareStep(N+1)` reads step N's post-compaction usage. There is no counter to reset — but there **is** a test below pinning that behaviour, because an implementer who caches the value would reintroduce the loop.

- [ ] **Step 6: Write the end-to-end test**

Append to `test/agent.test.ts`:

```ts
test("giliran berikutnya memadatkan sendiri saat giliran sebelumnya mengisi konteks", async () => {
  const dir = projectWith(windowConfig(8192))
  const session = createSession(dir)

  // Satu entri saja: mock mengulang entri terakhirnya, jadi giliran kedua DAN
  // panggilan peringkas sama-sama dilayani bentuk yang sama. `synthesizerFor`
  // memakai streamText, sehingga ia menghabiskan mock yang SAMA.
  recordingModel([
    [
      { type: "text-delta", id: "t", delta: "jawaban" },
      { type: "finish", finishReason: "stop", usage: usageWith(7800) },
    ],
  ])
  await prompt({ sessionID: session.id, text: "giliran satu" })

  await prompt({ sessionID: session.id, text: "giliran dua" })

  const history = listModelMessages(session.id)
  // Positif dulu: pemadatan memang menghasilkan ringkasan yang terpasang.
  assert.match(JSON.stringify(history), /context-summary/)
  // Baru negatif: teks giliran pertama sudah tidak dikirim apa adanya.
  assert.doesNotMatch(JSON.stringify(history.slice(2)), /giliran satu/)
})

test("giliran ketiga TIDAK meringkas lagi setelah giliran kedua memadatkan", async () => {
  // Kalau angka pra-pemadatan disimpan alih-alih dibaca ulang tiap giliran,
  // sesi akan memadatkan berulang-ulang tanpa kemajuan — terlihat seperti model
  // yang lambat, bukan seperti bug.
  const dir = projectWith(windowConfig(8192))
  const session = createSession(dir)

  recordingModel([
    [
      { type: "text-delta", id: "t", delta: "besar" },
      { type: "finish", finishReason: "stop", usage: usageWith(7800) },
    ],
    [
      { type: "text-delta", id: "t", delta: "ringkasan" },
      { type: "finish", finishReason: "stop", usage: usageWith(50) },
    ],
    [
      { type: "text-delta", id: "t", delta: "kecil" },
      { type: "finish", finishReason: "stop", usage: usageWith(50) },
    ],
  ])

  await prompt({ sessionID: session.id, text: "giliran satu" })
  await prompt({ sessionID: session.id, text: "giliran dua" })
  const before = latestCompaction(session.id)?.created

  await prompt({ sessionID: session.id, text: "giliran tiga" })
  const after = latestCompaction(session.id)?.created

  assert.ok(before !== undefined, "giliran dua seharusnya sudah memadatkan")
  assert.equal(after, before, "giliran tiga tidak boleh memadatkan lagi")
})
```

Import `latestCompaction` into `test/agent.test.ts` from `../src/core/storage/session.ts`.

- [ ] **Step 7: Run and prove by mutation**

Run: `npm run typecheck && npm run build && npm test`

Then mutate: in `autoCompact`, change the early return to `if (!compaction.auto) return IDLE` → `return IDLE` unconditionally. Expected: the end-to-end test fails on the `context-summary` assertion. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/core/auto-compact.ts src/core/agent.ts test/auto-compact.test.ts test/agent.test.ts
git commit -m "feat(compact): compact automatically between turns

midTurnKeep is accepted but unused until the mid-turn cut lands."
```

---

### Task 6: Mid-turn compaction

All the policy this needs already exists: `midTurnCut`, `MID_TURN_KEEP`, and `planAtCut` landed in Task 4, and `autoCompact` already honours `midTurnKeep`. This task is **wiring only** — the trigger point inside the turn, and the flush offset that makes it safe.

**Files:**
- Modify: `src/core/agent.ts` (`prepareStep`, the flush offset, the end-of-turn write)
- Test: `test/agent.test.ts`

**Interfaces:**
- Consumes: `autoCompact` and `AutoCompactInput.midTurnKeep` from Task 5; `MID_TURN_KEEP` from Task 4; `contextWindow` hoisted in Task 5 Step 5
- Produces: no new exports

- [ ] **Step 1: Add the flush offset and `prepareStep`**

In `src/core/agent.ts`, before `try {` (around `:320`), add:

```ts
  // Berapa pesan giliran ini yang SUDAH tertulis jadi baris. Pemadatan mid-turn
  // harus menuliskannya lebih dulu supaya mesin pemadatan berbasis baris bisa
  // dipakai apa adanya; tanpa penghitung ini, penulisan di akhir giliran akan
  // menduplikasi apa yang sudah tersimpan.
  let flushed = 0
```

Add `prepareStep` to the `streamText` options, directly above `stopWhen`:

```ts
      prepareStep: async ({ steps }) => {
        const used = steps.at(-1)?.usage?.inputTokens
        if (!overBudget(used, contextWindow, config.compaction.reserved)) return {}

        const soFar: ModelMessage[] = [
          userTurn,
          ...steps.flatMap((step) => step.response.messages),
        ]
        appendModelMessages(session.id, soFar.slice(flushed))
        flushed = soFar.length

        const result = await autoCompact({
          sessionID: session.id,
          compaction: config.compaction,
          contextWindow,
          lastStepTokens: used,
          summarise: synthesizerFor(resolver(config, config.smallModel ?? input.model)),
          focus: text,
          midTurnKeep: MID_TURN_KEEP,
        })
        if (!result.ran) return {}

        return { messages: listModelMessages(session.id) }
      },
```

`contextWindow` was already declared in Task 5 Step 5, above the between-turns call. `prepareStep` closes over it — do not compute it a second time.

- [ ] **Step 2: Make the end-of-turn write respect the offset**

Replace `src/core/agent.ts:419-423`:

```ts
    const steps = await result.steps
    const all: ModelMessage[] = [userTurn, ...steps.flatMap((step) => step.response.messages)]
    appendModelMessages(session.id, all.slice(flushed))
    flushed = all.length
```

- [ ] **Step 3: Write the end-to-end test**

Append to `test/agent.test.ts`:

```ts
test("giliran multi-langkah memadatkan DI TENGAH, dan konteks yang dikirim menyusut", async () => {
  // Ini kegagalan utama yang jadi alasan fitur ini ada: satu giliran agentic
  // yang membaca banyak berkas, tanpa satu pun pesan user di tengahnya tempat
  // pemeriksaan antar-giliran bisa menyala.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
    ],
    [
      { type: "tool-call", toolCallId: "c2", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(120) },
    ],
    [
      { type: "text-delta", id: "t", delta: "selesai" },
      { type: "finish", finishReason: "stop", usage: usageWith(130) },
    ],
  ])

  const dir = projectWith(windowConfig(8192))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "baca berulang" })

  // Positif dulu: giliran ini memang menempuh beberapa langkah. Tanpa ini,
  // assertion di bawah bisa lolos pada giliran yang tidak pernah jalan.
  assert.ok(model.doStreamCalls.length >= 3)

  const first = JSON.stringify(model.doStreamCalls[0]?.prompt)
  const last = JSON.stringify(model.doStreamCalls.at(-1)?.prompt)

  // Yang membuktikan fiturnya bekerja: yang DIKIRIM ke provider memuat
  // ringkasan, bukan sekadar bahwa sebuah fungsi terpanggil.
  assert.match(last, /context-summary/)
  assert.doesNotMatch(last, /baris satu/)
  assert.match(first, /baca berulang/)
})

test("tidak ada pesan tool yatim, dan tidak ada baris ganda, setelah pemadatan mid-turn", async () => {
  // Dua invarian sekaligus. Yatim: hasil tool tanpa panggilannya ditolak
  // provider dengan error yang tidak menyebut pemadatan. Ganda: offset flush
  // yang salah menuliskan giliran dua kali, dan riwayatnya membengkak
  // diam-diam alih-alih menyusut.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(7900) },
    ],
    [
      { type: "text-delta", id: "t", delta: "selesai" },
      { type: "finish", finishReason: "stop", usage: usageWith(120) },
    ],
  ])

  const dir = projectWith(windowConfig(8192))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "sekali baca" })

  assert.ok(model.doStreamCalls.length >= 2)

  const messages = listModelMessages(session.id)
  assert.ok(messages.length > 0)
  assert.notEqual(messages[0]?.role, "tool")

  const seen = listModelRows(session.id).map((row) => JSON.stringify(row.message))
  assert.equal(new Set(seen).size, seen.length, "ada baris riwayat yang tertulis dua kali")
})
```

Import `listModelRows` into `test/agent.test.ts` from `../src/core/storage/session.ts`.

- [ ] **Step 4: Run and prove by mutation**

Run: `npm run typecheck && npm run build && npm test`

Mutations, each restored after:
1. `prepareStep`: return `{}` unconditionally. Expected: the mid-turn end-to-end test fails on `context-summary`.
2. End-of-turn write: use `all` instead of `all.slice(flushed)`. Expected: *"tidak ada baris ganda"* fails on the `Set` size.
3. `prepareStep`: drop the `appendModelMessages(...soFar.slice(flushed))` flush entirely, keeping the `autoCompact` call. Expected: the mid-turn test fails — with nothing flushed there are no rows above the watermark to summarise, so `autoCompact` returns without producing a summary. This is the trap the whole flush design exists to avoid; if the suite stays green here, the test is not proving what it claims.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts test/agent.test.ts
git commit -m "feat(compact): compact mid-turn, so one long agentic turn cannot overflow"
```

---

### Task 7: Per-agent step limits

**The guard from Tasks 5 and 6 must be green before this lands.** `MAX_STEPS = 20` is today an accidental context limiter; raising it before compaction works is strictly worse than leaving it alone.

**Files:**
- Modify: `src/core/schema.ts` (`Agent.steps`)
- Modify: `src/core/agent.ts:51` and the `stopWhen` at `:342`
- Test: `test/config.test.ts`, `test/agent.test.ts`

**Interfaces:**
- Produces: `Agent.steps?: number`, `MAX_STEPS = 20` remains the default

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
test("steps opsional pada agent, dan wajib positif", () => {
  const config = Config.parse({ agent: { scout: { steps: 5 } } })
  assert.equal(config.agent["scout"]?.steps, 5)
  assert.throws(() => Config.parse({ agent: { scout: { steps: 0 } } }))
  assert.throws(() => Config.parse({ agent: { scout: { steps: -1 } } }))
})

test("agent tanpa steps tidak memaksa nilai apa pun", () => {
  const config = Config.parse({ agent: { scout: {} } })
  assert.equal(config.agent["scout"]?.steps, undefined)
})
```

Append to `test/agent.test.ts`:

```ts
test("steps agent membatasi jumlah langkah giliran", async () => {
  // Tiap langkah memanggil tool lagi; tanpa batas, mock ini berputar sampai
  // MAX_STEPS. Dengan steps: 2, giliran berhenti setelah dua langkah.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
  ])

  // Jendela sengaja besar supaya pemadatan tidak ikut campur — yang diuji di
  // sini murni batas langkah.
  const dir = projectWith(windowConfig(1_000_000, { agent: { scout: { steps: 2 } } }))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "baca terus", agent: "scout" })

  assert.equal(model.doStreamCalls.length, 2)
})

test("agent tanpa steps tetap memakai batas bawaan", async () => {
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
  ])

  const dir = projectWith(windowConfig(1_000_000, { agent: { plain: {} } }))
  const session = createSession(dir)
  await prompt({ sessionID: session.id, text: "baca terus", agent: "plain" })

  assert.equal(model.doStreamCalls.length, 20)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -A4 "steps"`
Expected: FAIL — `steps` is stripped by the schema; the turn runs 20 steps.

- [ ] **Step 3: Add the schema field**

In `src/core/schema.ts`, inside the `Agent` object (next to `model` at `:105`):

```ts
    steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum agentic iterations for this agent before it is forced to answer in text",
      ),
```

- [ ] **Step 4: Use it**

In `src/core/agent.ts:51`, keep the constant and rename its comment:

```ts
/** Batas langkah bawaan, dipakai agent yang tidak menyatakan `steps` sendiri. */
const MAX_STEPS = 20
```

Above the `streamText` call, add:

```ts
  const maxSteps = agentDef?.steps ?? MAX_STEPS
```

and change `:342`:

```ts
      stopWhen: stepCountIs(maxSteps),
```

- [ ] **Step 5: Run and prove by mutation**

Run: `npm run typecheck && npm run build && npm test`

Mutate: `stopWhen: stepCountIs(MAX_STEPS)`. Expected: *"steps agent membatasi jumlah langkah giliran"* fails with 20 calls instead of 2. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/core/schema.ts src/core/agent.ts test/config.test.ts test/agent.test.ts
git commit -m "feat(agent): per-agent step limits, now that compaction guards the context"
```

---

### Task 8: An answer when the step limit is reached

**Files:**
- Modify: `src/core/agent.ts` (`prepareStep`, and the note at `:406-410`)
- Test: `test/agent.test.ts`

**Interfaces:**
- Consumes: `maxSteps` from Task 7, `prepareStep` from Task 6
- Produces: no new exports; the final step runs with `activeTools: []`

- [ ] **Step 1: Write the failing test**

Append to `test/agent.test.ts`:

```ts
test("langkah terakhir dijalankan tanpa tool, sehingga model WAJIB menjawab teks", async () => {
  // Sebelum ini, giliran yang kehabisan langkah berakhir pada tool call dan
  // user dikirimi "try a different model" — nasihat yang menyalahkan pihak
  // yang keliru, karena modelnya baik-baik saja dan cuma kehabisan langkah.
  const model = recordingModel([
    [
      { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"path":"halo.txt"}' },
      { type: "finish", finishReason: "tool-calls", usage: usageWith(10) },
    ],
    [
      { type: "text-delta", id: "t", delta: "sejauh ini saya menemukan X" },
      { type: "finish", finishReason: "stop", usage: usageWith(10) },
    ],
  ])

  const dir = projectWith(windowConfig(1_000_000, { agent: { scout: { steps: 2 } } }))
  const session = createSession(dir)
  const message = await prompt({ sessionID: session.id, text: "baca terus", agent: "scout" })

  assert.equal(model.doStreamCalls.length, 2)

  // Positif: langkah pertama memang punya tool.
  const firstTools = model.doStreamCalls[0]?.tools ?? []
  assert.ok(firstTools.length > 0)
  // Baru negatif: langkah terakhir tidak punya satu pun.
  const lastTools = model.doStreamCalls[1]?.tools ?? []
  assert.equal(lastTools.length, 0)

  // Dan hasilnya jawaban teks, bukan pesan "ganti model".
  const text = message.parts.find((part) => part.type === "text")
  assert.match(JSON.stringify(text), /sejauh ini saya menemukan X/)
  assert.doesNotMatch(JSON.stringify(message.parts), /different model/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A6 "WAJIB menjawab teks"`
Expected: FAIL — the last step still carries the full tool set.

- [ ] **Step 3: Disable tools on the final step**

In `src/core/agent.ts`, at the top of the `prepareStep` callback added in Task 6, before the budget check:

```ts
      prepareStep: async ({ steps, stepNumber }) => {
        // Langkah terakhir dijalankan tanpa tool sama sekali, sehingga model
        // TIDAK PUNYA pilihan selain menjawab dengan teks. Tanpa ini, giliran
        // yang kehabisan langkah berakhir pada tool call dan user membaca
        // "try a different model" — padahal modelnya baik-baik saja.
        const lastStep = stepNumber >= maxSteps - 1
```

and merge it into the return values:

```ts
        const used = steps.at(-1)?.usage?.inputTokens
        if (!overBudget(used, contextWindow, config.compaction.reserved)) {
          return lastStep ? { activeTools: [] } : {}
        }
        // … flush + autoCompact as in Task 6 …
        if (!result.ran) return lastStep ? { activeTools: [] } : {}
        return lastStep
          ? { activeTools: [], messages: listModelMessages(session.id) }
          : { messages: listModelMessages(session.id) }
```

- [ ] **Step 4: Narrow the fallback note**

`src/core/agent.ts:406-410` still fires when a turn genuinely produces no text. Leave it, but correct its advice, since the step-limit cause is now handled:

```ts
      const note =
        "(the model stopped without giving a text answer — try again, " +
        "or use a different model with --model)"
```

stays as-is **only if** the mutation in Step 5 shows it no longer fires for the step-limit case. If it still fires, the `activeTools: []` step is not being reached — fix that rather than editing the message.

- [ ] **Step 5: Run and prove by mutation**

Run: `npm run typecheck && npm run build && npm test`

Mutate: change `stepNumber >= maxSteps - 1` to `false`. Expected: *"langkah terakhir dijalankan tanpa tool"* fails on `lastTools.length`. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent.ts test/agent.test.ts
git commit -m "fix(agent): force a text answer when the step limit is reached, instead of blaming the model"
```

---

### Task 9: The `/compact` palette fix, and the docs

**Files:**
- Modify: `src/core/command.ts:60-70` (`IMMEDIATE_COMMANDS`)
- Modify: `README.md` (the `### Context management` section at `:640`)
- Create: `test/command.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

Nothing in `test/` references `IMMEDIATE_COMMANDS` today — the only consumers are `src/core/command.ts` and `src/tui/app.tsx`. Create `test/command.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { IMMEDIATE_COMMANDS } from "../src/core/command.ts"

test("/compact TIDAK langsung jalan dari palet — ia menerima argumen", () => {
  // `/compact {pesan}` sudah bekerja sejak lama (compactPrompt menerima focus),
  // tapi menjalankannya seketika dari palet tidak pernah memberi user
  // kesempatan mengetik fokusnya. Aturannya sudah tertulis di komentar di atas
  // IMMEDIATE_COMMANDS; `compact` satu-satunya yang melanggarnya.
  assert.equal(IMMEDIATE_COMMANDS.has("compact"), false)
})

test("command tanpa argumen tetap langsung jalan", () => {
  assert.equal(IMMEDIATE_COMMANDS.has("agents"), true)
  assert.equal(IMMEDIATE_COMMANDS.has("new"), true)
})
```

This is a unit guard, not proof. `IMMEDIATE_COMMANDS` is consumed by `src/tui/app.tsx`, and this repo has a documented history of TUI behaviour that unit tests bless and a real terminal contradicts. Step 6 is where the fix is actually proven.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A3 "TIDAK langsung jalan"`
Expected: FAIL — `compact` is in the set.

- [ ] **Step 3: Remove it**

In `src/core/command.ts`, delete the `"compact",` line from `IMMEDIATE_COMMANDS` (`:69`).

- [ ] **Step 4: Update the README**

In `README.md`, in the `### Context management` section, replace the `/compact` description with one that covers both the automatic and manual paths:

```markdown
Titah compacts automatically once the context approaches the model's window, and
`/compact` runs the same thing on demand.

    /compact                        # summarise everything but the last turns
    /compact the database schema    # same, but keep that material in full detail

Automatic compaction needs to know how large the model's window is, and nothing
is guessed. Declare it per model:

    "provider": { "ollama": { "models": { "qwen3:14b": { "contextWindow": 32768 } } } }

Without it, automatic compaction is off for that model — `titah doctor` lists
every model missing one. `/compact` still works either way.

Tuning, with the defaults shown:

    "compaction": {
      "auto": true,        // turn the whole thing off with false
      "reserved": 8192,    // tokens held back for the next answer and the summary itself
      "tailTurns": 2,      // recent turns kept verbatim, never summarised
      "prune": true        // drop old tool output first — free, and usually enough
    }

When the context fills up, old tool output is dropped first, because it is the
bulk of an agentic turn and costs nothing to discard — the model can re-read a
file. Only if that is not enough is a summary written.

This happens **mid-turn** too. One long turn reading thirty files is the case
that overflows most often, and there is no user message in the middle of it where
a between-turns check could fire.
```

Also document `steps` in the **Custom agents** section:

```markdown
`steps` caps how many tool-calling iterations one turn may take for this agent —
five for a scout, sixty for a refactor. The default is 20. When the cap is
reached, the final iteration runs with no tools at all, so the model has to
report what it found rather than stopping mid-air.
```

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.

- [ ] **Step 6: Verify in a real terminal**

The TUI half of this repo has a documented history of tests passing under mutations a real terminal shows are broken. Drive the built CLI through a pty (Python `pty.fork` against `dist/cli.js`, 100×30, isolated `HOME`/`XDG_*`/`TITAH_DB`, temp project, local OpenAI-compatible stub provider, frames read with `pyte`). **Trap:** setting `CI=""` puts Ink in CI mode and nothing renders — delete the variable instead of emptying it.

Confirm: opening the palette, selecting `/compact`, and seeing `/compact ` inserted into the editor with the cursor after it — not a compaction running immediately.

- [ ] **Step 7: Commit**

```bash
git add src/core/command.ts README.md test/command.test.ts
git commit -m "fix(command): stop the palette from running /compact before its focus can be typed"
```

---

## Final gate

- [x] `npm run typecheck && npm run build && npm test` — all green (615/615, 2026-08-12)
- [x] A session with an undeclared `contextWindow` behaves exactly as it did before this plan — pinned by `test/agent.test.ts` ("contextWindow yang tidak dideklarasikan…", and the once-per-session notice test)
- [x] `compaction.auto: false` behaves exactly as it did before this plan — pinned by `test/auto-compact.test.ts` ("compaction.auto: false tidak menjalankan apa pun…")
- [x] `titah doctor` names every model missing a `contextWindow` — and, since the follow-up cycle, a `smallModel` missing one too
- [x] No `any` in `src/`
- [x] All new comments are Indonesian and explain WHY; all new user-facing strings are English

**Follow-up cycle, 2026-08-12.** Shipping this plan surfaced four defects that
were behaviours no test pinned, filed as issues #1–#4 and fixed under
`docs/superpowers/specs/2026-08-12-compaction-hardening-design.md`: the
summariser's own prompt was unbounded, the "was pruning enough?" decision was
arithmetic on a stale provider number, `appendModelMessages` had no transaction,
and the pruner discarded sub-agent results. Issue #5 (no intent state) has a
design and no code: `2026-08-12-intent-state-design.md`.

---

### Task 10: The `reserved` floor, and a `doctor` warning for the collision

**Added 2026-08-11, after Task 5's review.** Not in the original plan — it corrects a design defect the review reproduced. **Must land before Task 6**, because Task 6's `prepareStep` calls `overBudget` and its tests would otherwise be written against the un-floored threshold.

**The defect.** `reserved` defaults to `8192`. A model with an 8192-token window makes `contextWindow - reserved` exactly `0`, so `overBudget` returns true for every measured value. Reproduced by the reviewer: **12 tokens of context triggered a full summarisation** on an 8k model with stock config, silently, on every turn from the third onward. 8k local models are a common setup, so this is Titah's collision, not a user misconfiguration.

Task 3 deliberately pinned `overBudget(1, 8192, 16384) === true` with the rationale that a misconfiguration should read as aggressive compaction rather than a dead feature. That rationale stands for `reserved` *larger than the whole window*; it does not transfer to the shipped default meeting a common model.

**Files:**
- Modify: `src/core/compact.ts` (`overBudget`)
- Modify: `src/cli.ts` (`cmdDoctor`)
- Test: `test/compact.test.ts`, `test/cli-doctor.test.ts`

**Interfaces:**
- Consumes: `overBudget`, `contextWindowFor`, `undeclaredContextWindows`
- Produces: `RESERVE_FRACTION = 4`; `effectiveReserved(contextWindow: number, reserved: number): number`; `reservedCollisions(config: Config): { model: string; reserved: number; contextWindow: number }[]`

- [ ] **Step 1: Write the failing tests**

Append to `test/compact.test.ts`:

```ts
test("reserved tidak boleh menelan lebih dari seperempat jendela", () => {
  // Default reserved (8192) sama besar dengan jendela model 8k, dan itu
  // membuat ambangnya nol — pemadatan menyala tiap giliran walau konteksnya
  // dua belas token. Itu tabrakan bawaan Titah, bukan salah setelan user.
  assert.equal(effectiveReserved(8192, 8192), 2048)
  assert.equal(overBudget(6144, 8192, 8192), true)
  assert.equal(overBudget(6143, 8192, 8192), false)
})

test("jendela besar tidak terpengaruh lantainya", () => {
  // 8192 masih di bawah seperempat dari 200k, jadi nilai yang wajar lewat
  // apa adanya. Lantai ini hanya menangkap yang mustahil.
  assert.equal(effectiveReserved(200_000, 8192), 8192)
  assert.equal(overBudget(191_808, 200_000, 8192), true)
  assert.equal(overBudget(191_807, 200_000, 8192), false)
})

test("reserved nol tetap nol — lantainya batas atas, bukan batas bawah", () => {
  // Lantai membatasi seberapa BANYAK reserved boleh mengambil. User yang
  // sengaja menyetel 0 minta pemadatan sedekat mungkin ke batas, dan itu
  // pilihannya.
  assert.equal(effectiveReserved(8192, 0), 0)
  assert.equal(overBudget(8192, 8192, 0), true)
  assert.equal(overBudget(8191, 8192, 0), false)
})

test("reservedCollisions menyebut model yang reserved-nya menelan jendelanya", () => {
  const config = Config.parse({
    compaction: { reserved: 8192 },
    provider: {
      ollama: {
        models: { "kecil": { contextWindow: 8192 }, "besar": { contextWindow: 200000 } },
      },
    },
  })
  assert.deepEqual(reservedCollisions(config), [
    { model: "ollama/kecil", reserved: 8192, contextWindow: 8192 },
  ])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/compact.test.ts`
Expected: FAIL — `effectiveReserved is not a function`.

Also expected: the Task 3 test `"reserved lebih besar dari window memicu segera, bukan diam-diam mati"` (`overBudget(1, 8192, 16384) === true`) now **fails**, because the floor makes the threshold 6144. That test is being deliberately superseded — see Step 4.

- [ ] **Step 3: Implement the floor**

In `src/core/compact.ts`, above `overBudget`:

```ts
/**
 * Berapa bagian jendela yang paling banyak boleh diambil `reserved`.
 *
 * Tanpa lantai ini, `reserved` bawaan (8192) sama besar dengan jendela model
 * 8k, ambangnya jadi nol, dan pemadatan menyala di TIAP giliran walau
 * konteksnya cuma dua belas token — terukur. Model 8k lokal itu setelan yang
 * umum, jadi tabrakannya milik Titah, bukan salah setelan user.
 */
export const RESERVE_FRACTION = 4

/**
 * `reserved` yang benar-benar dipakai: tidak pernah lebih dari seperempat
 * jendela.
 *
 * Ini batas ATAS, bukan bawah — `reserved: 0` tetap nol, karena user yang
 * menyetelnya nol memang minta pemadatan sedekat mungkin ke batas jendela.
 */
export function effectiveReserved(contextWindow: number, reserved: number): number {
  return Math.min(reserved, Math.floor(contextWindow / RESERVE_FRACTION))
}
```

and change `overBudget`'s final line to use it:

```ts
  return lastStepTokens >= contextWindow - effectiveReserved(contextWindow, reserved)
```

- [ ] **Step 4: Restate the superseded Task 3 test**

`test/compact.test.ts` has a Task 3 test named `"reserved lebih besar dari window memicu segera, bukan diam-diam mati"` asserting `overBudget(1, 8192, 16384) === true`. The floor makes that false, and deliberately so.

**Do not delete it.** Rewrite it to pin what is now true, and say in its comment why the old expectation was dropped:

```ts
test("reserved yang mustahil dijinakkan lantainya, bukan dibiarkan memicu terus", () => {
  // Dulu test ini mematok `overBudget(1, 8192, 16384) === true` dengan alasan
  // salah setelan harus terlihat sebagai pemadatan agresif, bukan fitur mati.
  // Alasan itu gugur ketika ternyata reserved BAWAAN bertabrakan dengan jendela
  // 8k yang umum: yang terlihat bukan salah setelan user, melainkan Titah yang
  // memadatkan tiap giliran tanpa alasan. Lantainya menjinakkan keduanya, dan
  // `doctor` yang bicara soal setelannya.
  assert.equal(effectiveReserved(8192, 16384), 2048)
  assert.equal(overBudget(6144, 8192, 16384), true)
  assert.equal(overBudget(1, 8192, 16384), false)
})
```

- [ ] **Step 5: Implement the collision report**

Append to `src/core/compact.ts`:

```ts
/**
 * Model yang `reserved`-nya menelan seperempat jendelanya atau lebih.
 *
 * Lantai di `effectiveReserved` sudah membuat perilakunya waras, jadi ini
 * bukan peringatan soal kerusakan — ini memberi tahu user bahwa angka yang ia
 * tulis TIDAK dipakai apa adanya, supaya ia tidak menyetel ulang berkali-kali
 * dan bingung kenapa tidak ada bedanya.
 */
export function reservedCollisions(
  config: Config,
): { model: string; reserved: number; contextWindow: number }[] {
  const reserved = config.compaction.reserved
  const out: { model: string; reserved: number; contextWindow: number }[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const contextWindow = model.contextWindow
      if (contextWindow === undefined) continue
      if (reserved <= Math.floor(contextWindow / RESERVE_FRACTION)) continue
      out.push({ model: `${providerId}/${modelId}`, reserved, contextWindow })
    }
  }
  return out
}
```

This needs `Config` imported as a type in `src/core/compact.ts`. If that import would create a cycle, put `reservedCollisions` in `src/core/provider.ts` beside `undeclaredContextWindows` instead and say which you chose.

- [ ] **Step 6: Report it in `doctor`**

In `src/cli.ts`, inside the `Context windows` section added by Task 1, after the undeclared loop:

```ts
  for (const clash of reservedCollisions(loaded.config)) {
    out(
      `  ! ${clash.model} — compaction.reserved (${clash.reserved}) is large for a ` +
        `${clash.contextWindow}-token window; capped at ${Math.floor(clash.contextWindow / 4)}`,
    )
  }
```

- [ ] **Step 7: Write the doctor test**

Append to `test/cli-doctor.test.ts`, using the file's existing `isolatedProject` and `runDoctor` helpers:

```ts
test("doctor bilang kalau reserved dijinakkan lantainya", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      compaction: { reserved: 8192 },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "kecil": { contextWindow: 8192 } },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /Context windows/)
  assert.match(output, /ollama\/kecil/)
  assert.match(output, /capped at 2048/)
})
```

- [ ] **Step 8: Run and prove by mutation**

Run: `npm run typecheck && npm run build && npm test`

Mutations, each restored after:
1. `effectiveReserved` returns `reserved` unchanged. Expected: the floor tests fail.
2. `Math.min` → `Math.max`. Expected: the large-window test fails (8192 becomes 50000).
3. `effectiveReserved` returns `Math.max(reserved, …)` so `reserved: 0` becomes 2048. Expected: the `reserved: 0` test fails — the floor must be an upper bound on `reserved`, not a lower one.
4. `reservedCollisions` returns `[]`. Expected: the doctor test fails.

- [ ] **Step 9: Commit**

```bash
git add src/core/compact.ts src/cli.ts test/compact.test.ts test/cli-doctor.test.ts
git commit -m "fix(compact): cap reserved at a quarter of the window, and have doctor say so

The default reserved (8192) equals a common 8k context window, which made the
threshold zero and fired compaction on every turn — measured at twelve tokens of
context. Task 3's test pinning the opposite is restated rather than deleted: its
rationale covered a user misconfiguration, not the shipped default colliding
with a common model."
```
