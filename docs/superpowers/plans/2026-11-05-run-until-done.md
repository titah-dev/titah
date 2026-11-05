# Run-Until-Done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Titah menjalankan satu perintah sampai rencananya tuntas tanpa disenggol, memadatkan pada ambang "fokus" yang terpisah dari jendela asli model, dan tetap melihat folder template yang ditunjuk user sepanjang sesi.

**Architecture:** Tiga lapis di atas mesin yang sudah ada. (1) `compactionWindowFor` memisahkan ambang pemadatan dari `contextWindow`, dan anggaran giliran turunan dihapus. (2) `src/core/continuation.ts` (baru, murni) memutuskan *apakah* dan *dengan teks apa* giliran dilanjutkan. `agent.ts` hanya memanggilnya di tempat `willContinue` sekarang dihitung. (3) Tabel `reference` + `referencePair` ikut masuk `requestShape`, sehingga bentuk yang dikirim dan yang diukur tetap satu definisi.

**Tech Stack:** TypeScript ESM (Node ≥ 22.6, `erasableSyntaxOnly`), AI SDK v7 (`MockLanguageModelV4` untuk test), `node:sqlite`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-05-run-until-done-design.md`

**Baseline:** branch `feat/run-until-done` dari `ee3c472`; `npm test` → `ℹ tests 1583`, `ℹ pass 1583`, `ℹ fail 0`.

## Global Constraints

- String UI dalam bahasa Inggris; komentar kode dalam Bahasa Indonesia, dan isinya menjelaskan *kenapa*.
- `erasableSyntaxOnly`: tanpa `enum`, tanpa parameter properties, tanpa namespace.
- `src/extension.ts` / `EXTENSION_API` tidak disentuh. Kalau ternyata harus, berhenti dan tanyakan.
- Migrasi DB hanya **ditambahkan di ujung** array di `src/core/storage/db.ts`.
- Nama test menyatakan perilaku. Test baru memakai pola harness `test/auto-continue.test.ts`: env `XDG_*` dan `TITAH_DB` ke tmp, `setModelResolver` + `MockLanguageModelV4`.
- `npm test` (build dulu) harus hijau di akhir setiap task. Tunjukkan output-nya.
- Commit per task di branch `feat/run-until-done`. Jangan push.
- Nilai dari spec: ambang "tanpa kemajuan" = **2** lanjutan berturut-turut; jaring lanjutan bawaan = **50**; pengingat rencana setelah **8** tool call tanpa rencana; anggaran referensi = **25%** dari ambang pemadatan efektif, dalam token, × `REAL_BYTES_PER_TOKEN` (4).

## Review Focus

1. **Pertanyaan sampingan di sesi yang punya rencana lama setengah jadi** tidak boleh membangunkan rencana itu. Test di Task 2: `rencana lama yang tidak disentuh giliran ini tidak memicu lanjutan`.
2. **Esc di antara dua giliran lanjutan** harus menghentikan rangkaian; tidak boleh ada giliran baru yang mulai. Test di Task 2: `abort sesudah giliran selesai tetap memutus rangkaian`.
3. **Model yang menjawab dengan pertanyaan ke user** (teks berakhir `?`, atau memanggil `question`) tidak boleh dilanjutkan, walau rencananya terbuka. Test di Task 2.
4. **Folder referensi yang lebih besar dari anggaran**, atau yang berisi berkas biner atau `node_modules`, tidak boleh meluapkan permintaan dan tidak boleh mengirim sampah biner. Test di Task 4: `berkas yang tidak muat hanya muncul di manifest` dan `berkas biner dan node_modules dilewati`.
5. **Yang diukur bukan yang dikirim.** `measure` di `auto-compact.ts:186-188` saat ini memanggil `requestShape(summary, plan, tail)` **tanpa memori**, padahal `splitModelRequest` mengirim memori. Referensi akan mengulang bug yang sama kalau tidak dipatok. Test di Task 4: `ukuran yang dipakai pemicu pemadatan memuat memori dan referensi yang benar-benar dikirim`.

---

### Task 1: Fokus terpisah dari kapasitas

**Files:**
- Modify: `src/core/schema.ts` (Compaction ±baris 420-430: kunci `target`; skema model provider: kunci `compactAt`)
- Modify: `src/core/provider.ts:188` (tambah `compactionWindowFor` di sebelah `contextWindowFor`)
- Modify: `src/core/agent.ts:111-160` (hapus `TURN_BUDGET_WINDOWS` dan `derivedTurnBudget`), `:767-768`, `:812`, `:885-886`, `:990`, `:1121-1158`, `:1360-1390` (notice)
- Test: `test/step-limit.test.ts` (ganti test 349 dan 400), `test/provider.test.ts`

**Interfaces:**
- Produces: `compactionWindowFor(config: Config, full?: string): number | undefined` di `provider.ts`.
  - Nilainya `min(compactAt ?? compaction.target ?? Infinity, contextWindow)`.
  - `undefined` bila `contextWindow` tidak dideklarasikan, sehingga aturan "tidak dideklarasikan berarti mati" tetap berlaku.
  - `compactAt` per model menang atas `compaction.target`.
- Produces: config `compaction.target?: number` (int positif) dan `provider.<p>.models.<m>.compactAt?: number` (int positif).

- [ ] **Step 1: Tulis test yang gagal**

Di `test/provider.test.ts`:

```ts
test("ambang pemadatan memakai compactAt model, lalu compaction.target, dan tidak pernah melebihi jendela", () => {
  // config: contextWindow 1_000_000, compaction.target 131072, model lain compactAt 200000
  assert.equal(compactionWindowFor(cfg, "p/besar"), 131072)
  assert.equal(compactionWindowFor(cfg, "p/fokus"), 200000)            // compactAt menang
  assert.equal(compactionWindowFor(cfgTargetBesar, "p/kecil"), 32768)   // dijepit jendela
  assert.equal(compactionWindowFor(cfgTanpaWindow, "p/x"), undefined)
})
```

Di `test/step-limit.test.ts`, ganti `anggaran BAWAAN diturunkan dari contextWindow` dan `kabarnya MENYEBUT bahwa anggarannya turunan` dengan:

```ts
test("contextWindow yang dideklarasikan tidak lagi menurunkan anggaran giliran", async () => {
  // contextWindow kecil (mis. 1000), tanpa limits.turnTokens; model neverStops
  // dengan usage besar per langkah → giliran TIDAK berhenti karena anggaran;
  // berhenti hanya di plafon STEP_BACKSTOP (200) atau agent.steps
  assert.ok(!notices.some((m) => m.includes("token budget")))
})
test("jendela dideklarasikan tanpa turnTokens memakai plafon 200, bukan 40", async () => { /* hitung langkah = 200 */ })
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: FAIL, karena `compactionWindowFor` belum diekspor dan test anggaran masih memakai anggaran turunan.

- [ ] **Step 3: Implementasi**

- Tambah kunci skema. Teks `.describe` dalam bahasa Inggris:
  - `target`: `"Compact when the context reaches this many tokens, even if the model's window is larger. Keeps long turns focused. Never exceeds contextWindow."`
  - `compactAt`: kalimat yang sama, ditambah "for this model; overrides compaction.target".
- `agent.ts:767`:
  - `contextWindow` tetap diambil dari `contextWindowFor` dan hanya dipakai untuk `warnUndeclaredWindow`.
  - Variabel baru `compactWindow = compactionWindowFor(config, modelID)` menggantikan `contextWindow` di semua argumen pemadatan (`:812`, `:990`, `:1121`, `:1144`, `:1158`) dan di `ctx.contextWindow` tool (`plan` menjepit dirinya ke jendela kerja).
- `:885-886`:
  - `turnBudget = config.limits.turnTokens`.
  - `maxSteps = agentDef?.steps ?? (turnBudget === undefined && compactWindow === undefined ? MAX_STEPS : STEP_BACKSTOP)`.
- Hapus `TURN_BUDGET_WINDOWS` dan `derivedTurnBudget`. Pindahkan alasan historisnya, satu paragraf, ke komentar `STEP_BACKSTOP`: anggaran turunan dihapus karena menyatukan fokus dan kapasitas.
- Notice anggaran: hapus cabang "That is the default: 5×…".
- Notice batas langkah: ubah ekornya menjadi `"... the work may not be finished. Titah continues on its own while the plan has open items; otherwise send another prompt."`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: `ℹ fail 0`

- [ ] **Step 5: Regenerasi schema dan commit**

```bash
npm run schema
git add src/core/schema.ts src/core/provider.ts src/core/agent.ts test/step-limit.test.ts test/provider.test.ts config.schema.json
git commit -m "feat(compaction): separate focus (compaction.target, compactAt) from contextWindow; drop derived turn budget"
```

---

### Task 2: Keputusan lanjutan — pemicu, rem, dan teks

**Files:**
- Create: `src/core/continuation.ts`
- Modify: `src/core/agent.ts:174-177` (`CONTINUE_TEXT` pindah ke `continuation.ts`), `:397-430` (`PromptInput`), `:1426-1438` (`willContinue`), `:1500-1515` (notice + rekursi)
- Modify: `src/core/schema.ts:923-933` (`continueTurns` menjadi opsional tanpa default)
- Create: `test/run-until-done.test.ts`
- Modify: `test/auto-continue.test.ts` (sesuaikan `bawaannya MATI…` dan `giliran yang selesai WAJAR…`)

**Interfaces:**
- Produces (di `continuation.ts`):

```ts
export type ContinueReason = "limit" | "open-plan" | "announced" | "text-tool-call"
export interface TurnEnding {
  stoppedAtLimit: boolean
  lastText: string            // teks part terakhir giliran, apa adanya
  calledQuestion: boolean     // langkah terakhir memanggil tool `question`
  plan: { text: string; updated: number } | undefined
  chainStarted: number        // ms; waktu pesan user ASLI dimulai
}
export function continueReason(ending: TurnEnding): ContinueReason | undefined
export function continuationText(reason: ContinueReason): string
export const UNTIL_DONE_CEILING = 50
export const IDLE_LIMIT = 2
export function isIdleContinuation(toolCalls: number, mutatingCalls: number, planBefore: string | undefined, planAfter: string | undefined): boolean
```

- Produces (di `PromptInput`): `interactive?: boolean`, `chainStarted?: number`, `idleStreak?: number`.
- Konsumen di Task 3: `interactive`.

**Aturan `continueReason`** (urutannya penting, karena pengecualian selalu menang):
1. `calledQuestion` atau `lastText.trimEnd().endsWith("?")` → `undefined`.
2. `stoppedAtLimit && hasOpenWork(plan?.text)` → `"limit"`.
3. `/<tool_call>|<function=/.test(lastText)` → `"text-tool-call"`.
4. `lastText.trimEnd().endsWith(":")` → `"announced"`.
5. `hasOpenWork(plan?.text) && plan.updated >= chainStarted` → `"open-plan"`.
6. selain itu → `undefined`.

**`isIdleContinuation`:** `toolCalls === 0 || (mutatingCalls === 0 && planBefore === planAfter)`. Bagian kedua adalah penyempurnaan spec: giliran yang terus menulis berkas tanpa memperbarui rencana masih dihitung kemajuan.

**Teks** (semuanya diawali `[titah] `):
- `limit` dan `open-plan` → `CONTINUE_TEXT` yang sekarang (`agent.ts:174`), dipindah apa adanya.
- `announced` → `"[titah] Your previous message announced a next step but ended without doing it. Do it now, then continue with the plan."`
- `text-tool-call` → `"[titah] Your previous message contained a tool call written as text, which was not executed. Call the tool properly and continue."`

- [ ] **Step 1: Tulis test unit yang gagal** di `test/run-until-done.test.ts`

```ts
test("teks berakhir titik dua memicu 'announced'", () =>
  assert.equal(continueReason(end({ lastText: "Sekarang buat semua app Django sekaligus:" })), "announced"))
test("tool call yang ditulis sebagai teks memicu 'text-tool-call'", () =>
  assert.equal(continueReason(end({ lastText: "<tool_call>\n<function=read>" })), "text-tool-call"))
test("pertanyaan ke user tidak pernah dilanjutkan, walau rencananya terbuka", () => {
  assert.equal(continueReason(end({ lastText: "Mau pakai Postgres atau SQLite?", plan: fresh("- [ ] a") })), undefined)
  assert.equal(continueReason(end({ calledQuestion: true, stoppedAtLimit: true, plan: fresh("- [ ] a") })), undefined)
})
test("rencana terbuka yang ditulis dalam rangkaian ini memicu 'open-plan'", () =>
  assert.equal(continueReason(end({ plan: { text: "- [ ] a", updated: 2000 }, chainStarted: 1000 })), "open-plan"))
test("rencana lama yang tidak disentuh giliran ini tidak memicu lanjutan", () =>
  assert.equal(continueReason(end({ plan: { text: "- [ ] a", updated: 500 }, chainStarted: 1000 })), undefined))
test("giliran yang selesai wajar dengan rencana tuntas tidak dilanjutkan", () =>
  assert.equal(continueReason(end({ lastText: "Selesai.", plan: fresh("- [x] a") })), undefined))
test("lanjutan tanpa tool call dihitung menganggur", () => assert.equal(isIdleContinuation(0, 0, "a", "b"), true))
test("lanjutan yang menulis berkas tanpa memperbarui rencana tetap kemajuan", () =>
  assert.equal(isIdleContinuation(5, 2, "a", "a"), false))
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npm test 2>&1 | grep -E "run-until-done|ℹ fail"`
Expected: FAIL, modul belum ada.

- [ ] **Step 3: Implementasi `continuation.ts`** sesuai Interfaces. Impor `hasOpenWork` dari `plan-progress.ts`.

- [ ] **Step 4: Tulis test integrasi yang gagal** (harness `neverStops` disalin dari `auto-continue.test.ts`, plus model `announcesThenStops` yang giliran pertamanya berakhir teks `"Sekarang tulis berkas:"` tanpa tool call)

```ts
test("giliran interaktif yang mengumumkan tanpa aksi dilanjutkan tanpa continueTurns di config", async () => {
  // configWith({}) — TANPA limits; prompt({ ..., interactive: true })
  assert.equal(turns(session.id), 2)
  assert.match(seen.prompts[1], /announced a next step/)
})
test("tanpa interactive, bawaannya tetap mati", async () => { /* prompt tanpa interactive → 1 giliran */ })
test("continueTurns 0 yang ditulis eksplisit mematikan lanjutan, juga di client interaktif", async () => {})
test("dua lanjutan menganggur berturut-turut menghentikan rangkaian", async () => {
  // model yang selalu menjawab "lanjut:" tanpa tool → giliran asli + 2 lanjutan, lalu berhenti
  assert.equal(turns(session.id), 3)
})
test("abort sesudah giliran selesai tetap memutus rangkaian", async () => {
  // abort(session.id) dipanggil dari handler bus `session.notice` "Continuing on its own"
  // → tidak ada giliran berikutnya yang memanggil model
})
test("notice lanjutan menyebut alasannya", async () => { /* notice memuat "announced" atau teks setara */ })
```

- [ ] **Step 5: Wiring di `agent.ts`**

- `chainStarted = input.chainStarted ?? Date.now()`, diambil saat giliran mulai, dan diteruskan ke rekursi.
- Allowance: `config.limits.continueTurns ?? (input.interactive === true ? UNTIL_DONE_CEILING : 0)`.
- `willContinue` = semua syarat lama kecuali `stoppedAtLimit` dan `hasOpenWork` (yaitu `allowed > 0`, `done < allowed`, `!isChild`, `!aborted`, `error === undefined`), **dan** `reason !== undefined`, **dan** `idleStreak < IDLE_LIMIT`.
- `idleStreak` berikutnya:
  - hanya dihitung bila `input.continuation > 0`;
  - bertambah bila `isIdleContinuation(...)`, dan kembali ke 0 bila tidak.
- `toolCalls` dan `mutatingCalls` dihitung dari `steps`. Berkas "mutating" adalah tool yang definisinya punya `mutates`.
- `planBefore` adalah teks rencana yang dibaca saat giliran mulai.
- Celah Esc: setelah `willContinue` dihitung dan sebelum `return prompt(...)`, periksa lagi apakah `abort()` sudah dipanggil untuk sesi ini. Pakai flag per sesi yang diset oleh `abort()` dan dibersihkan saat giliran user asli dimulai. `running` sudah dihapus di `finally`, jadi `abort()` di celah itu sekarang mengembalikan `false` dan sinyalnya hilang.
- Notice: `Continuing on its own (${n} of ${allowed}) — ${label}. Press Esc to stop.`. Label:
  - `limit` → `"the plan still has unfinished items"`
  - `open-plan` → `"the plan still has unfinished items"`
  - `announced` → `"the model announced a step without taking it"`
  - `text-tool-call` → `"a tool call came back as text"`
- Ubah `continueTurns` di skema menjadi `.optional()` dengan describe: `"How many times Titah may continue on its own when a turn ends before the work is done. Unset: until done (up to 50) in the TUI and web client, off for titah run. 0 disables it."`. Default objek `limits` menjadi `{}`.

- [ ] **Step 6: Sesuaikan test lama.**
  - `bawaannya MATI…` sekarang memastikan *tanpa `interactive`* tidak dilanjutkan.
  - `giliran yang selesai WAJAR tidak dilanjutkan, walau rencananya punya sisa` diganti nama dan isinya: giliran wajar dengan rencana terbuka **yang tidak ditulis dalam rangkaian ini** tidak dilanjutkan.

- [ ] **Step 7: Jalankan, pastikan lulus**

Run: `npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: `ℹ fail 0`

- [ ] **Step 8: Commit**

```bash
npm run schema
git add src/core/continuation.ts src/core/agent.ts src/core/schema.ts config.schema.json test/run-until-done.test.ts test/auto-continue.test.ts
git commit -m "feat(agent): continue until done — premature-end triggers, idle brake, Esc across the gap"
```

---

### Task 3: Client interaktif menandai dirinya

**Files:**
- Modify: `src/server/index.ts:279-315` (baca `body.interactive === true`, teruskan ke kedua panggilan `prompt`)
- Modify: `src/tui/client.ts:80-87` (kirim `interactive: true`)
- Modify: `src/server/web.ts:341-345` (kirim `interactive: true`)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `PromptInput.interactive` (Task 2).

- [ ] **Step 1: Tulis test yang gagal**

```ts
test("POST message dengan interactive:true diteruskan ke giliran", async () => { /* resolver spy menangkap PromptInput.interactive === true */ })
test("titah run tidak menandai dirinya interaktif", () => { /* panggilan prompt di cli.ts:1634 tidak membawa interactive */ })
```

Test kedua cukup membaca kode sumber dengan regex terhadap blok `prompt({` di `src/cli.ts`, kalau pemanggilan in-process sulit di-spy. Sertakan komentar kenapa test ini dibuat begitu.

- [ ] **Step 2: Jalankan, pastikan gagal.** Run: `npm test 2>&1 | grep -E "✖|ℹ fail"`
- [ ] **Step 3: Implementasi** tiga perubahan di atas.
- [ ] **Step 4: Jalankan, pastikan lulus.** Expected: `ℹ fail 0`
- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/tui/client.ts src/server/web.ts test/server.test.ts
git commit -m "feat(server): TUI and web mark their turns interactive"
```

---

### Task 4: Referensi — penyimpanan, pasangan terlindung, ukuran = kiriman

**Files:**
- Modify: `src/core/storage/db.ts:182` (migrasi baru di ujung):
  `CREATE TABLE reference (session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, path TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (session_id, path))`
- Create: `src/core/references.ts`
- Modify: `src/core/storage/session.ts:534-620` (`requestShape`, `splitModelRequest`, `listModelMessages`)
- Modify: `src/core/auto-compact.ts:186-188` (`measure`)
- Modify: `src/core/agent.ts:842`, `:1177` (berikan anggaran referensi)
- Test: `test/references.test.ts`, `test/auto-compact.test.ts`

**Interfaces:**
- Produces (`references.ts`):

```ts
export function addReference(sessionID: string, absPath: string): void
export function removeReference(sessionID: string, absPath: string): boolean
export function listReferences(sessionID: string): string[]          // path absolut, urut `added`
export function referenceBudgetBytes(compactWindow: number | undefined): number   // floor(w * 0.25) * REAL_BYTES_PER_TOKEN; undefined → 64 KiB
export function referencePair(sessionID: string, budgetBytes: number): ModelMessage[]  // [] bila tidak ada referensi
```

- Produces (`session.ts`):
  - `requestShape(summary, plan, tail, memory = [], references = [])`. Urutannya: `memory, references, summary, plan, tail`.
  - `splitModelRequest(sessionID, referenceBudget?: number)` dan `listModelMessages(sessionID, referenceBudget?: number)`.
  - Tanpa `referenceBudget`, keduanya memakai `referenceBudgetBytes(undefined)`.

**Isi `referencePair`** memakai `protectedPair` yang sudah ada:
- Pesan user: `<references>`, lalu satu blok manifest (path relatif ke akar referensi + ukuran), lalu `<file path="...">…</file>` per berkas yang muat, lalu `</references>`, diikuti kalimat: `"These are the reference files the user pinned. Match them exactly — structure, class names, colours, spacing. Files listed without content did not fit: read them before writing the matching UI."`
- Balasan assistant: `"Understood. I will follow these references."`

Urutan prioritas pengisian:
1. Berkas yang dirujuk dari `index.html` di akar referensi (`href`/`src` relatif).
2. Sisa `*.css`.
3. Sisa `*.html`.
4. Sisanya.

Yang dilewati:
- direktori `node_modules`, `.git`, `dist`;
- berkas yang memuat byte `\0` di 8 KB pertama;
- berkas > 256 KB.

Cache baca: `Map<path, { mtimeMs; size; text }>` tingkat modul. Berkas dibaca ulang hanya bila `mtimeMs` atau `size` berubah.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test("referensi bertahan lintas pemadatan karena tidak tinggal di model_message", () => { /* addReference → saveCompaction → listModelMessages memuat "<references>" */ })
test("referensi ada di permintaan sebelum ringkasan dan rencana", () => { /* indeks "<references>" < indeks "<context-summary>" < indeks "<plan>" */ })
test("berkas yang tidak muat hanya muncul di manifest", () => { /* anggaran 2 KB, berkas 10 KB → path ada, isi tidak */ })
test("berkas biner dan node_modules dilewati", () => {})
test("berkas yang dirujuk index.html didahulukan", () => {})
test("isi yang berubah di disk terbaca pada permintaan berikutnya", () => {})
test("anggaran referensi adalah seperempat ambang pemadatan dalam token", () =>
  assert.equal(referenceBudgetBytes(131072), 32768 * 4))
```

Di `test/auto-compact.test.ts`:

```ts
test("ukuran yang dipakai pemicu pemadatan memuat memori dan referensi yang benar-benar dikirim", () => {
  // bandingkan requestTokens(listModelMessages(id, budget)) dengan angka yang dipakai `measure`
})
```

- [ ] **Step 2: Jalankan, pastikan gagal.** Run: `npm test 2>&1 | grep -E "✖|ℹ fail"`
- [ ] **Step 3: Implementasi.**
  - `measure` di `auto-compact.ts` membangun pasangan memori dan referensi lewat fungsi yang sama dengan `splitModelRequest`.
  - Ekstrak satu helper `protectedParts(sessionID, referenceBudget)` di `session.ts` yang dipakai keduanya. Ini juga menutup selisih memori yang ada sekarang.
  - `AutoCompactInput` menerima `referenceBudget?: number`, dan agent mengisinya dari `referenceBudgetBytes(compactWindow)`.
- [ ] **Step 4: Jalankan, pastikan lulus.** Expected: `ℹ fail 0`
- [ ] **Step 5: Commit**

```bash
git add src/core/storage/db.ts src/core/references.ts src/core/storage/session.ts src/core/auto-compact.ts src/core/agent.ts test/references.test.ts test/auto-compact.test.ts
git commit -m "feat(references): pinned reference files ride in the protected prefix, measured as sent"
```

---

### Task 5: Menunjuk referensi — `/pin`, `/unpin`, field `references` di `plan`, prompt

**Files:**
- Modify: `src/core/agent.ts:1778` (dispatch `pin` dan `unpin` lewat `infoTurn`)
- Modify: `src/core/command.ts:104-118` (daftar builtin)
- Modify: `src/core/tool/plan.ts:83-140` (field opsional `references`)
- Modify: `src/core/prompt.ts:34-47` (paragraf referensi), dan prompt koordinator `task` (sebut path referensi di brief)
- Test: `test/references.test.ts`, `test/plan.test.ts`, `test/prompt.test.ts`

**Interfaces:**
- Consumes: `addReference`, `removeReference`, `listReferences` (Task 4), `resolveInside` (`tool/types.ts:157`).
- Path diresolusi dengan `resolveInside(session.directory, arg)`.

**Path di luar proyek:** spec meminta izin ditanya sekali saat path di-pin. Kode ini **sengaja** tidak bertanya saat berjalan: akar tambahan hanya bisa datang dari config `permission.rules` `external_directory(...)`, lihat komentar di `types.ts:126-139`. Rencana ini mengikuti kode, bukan spec, karena alasan di komentar itu bersifat struktural. Akibatnya: `/pin ~/Downloads/template` di luar proyek ditolak dengan pesan `resolveInside` yang sudah menyebut kunci config yang perlu ditambah. Setelah kunci itu ditambah, `/pin` berhasil. Ini disebut di handoff ke user.

- [ ] **Step 1: Tulis test yang gagal**

```ts
test("/pin menyimpan path dan /pin tanpa argumen menampilkan daftarnya", async () => {})
test("/unpin menghapus path", async () => {})
test("/pin path yang tidak ada ditolak dengan pesan yang menyebut path-nya", async () => {})
test("/pin di luar proyek ditolak dan menyebut external_directory", async () => {})
test("plan dengan references menyimpan referensi tanpa mengganti rencana menjadi kosong", async () => {})
test("prompt build menyuruh mengunci template yang disebut user sebagai referensi", () => {
  assert.match(SYSTEM_PROMPT, /references/)
})
```

- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi.**
  - `plan` input mendapat `references: z.array(z.string()).optional().describe("Paths (files or folders) the user gave as the design or template to follow. Pinned for the whole session and re-sent after compaction.")`.
  - Tiap path melewati `resolveInside(ctx.cwd, p)`. Yang ditolak dikembalikan sebagai `ToolError` dengan pesan `resolveInside` apa adanya.
  - Paragraf baru di `prompt.ts` di bawah "About `plan`":

    > `"When the user points at a template, design, or example to follow, pin it with plan's references field before you start building, then match it closely. The pinned files are re-sent after every compaction, so you never have to work from a summary of them."`

  - Prompt koordinator `task`: satu kalimat bahwa sub-agent tidak melihat referensi, jadi path-nya harus ditulis di brief.
- [ ] **Step 4: Jalankan, pastikan lulus.** Expected: `ℹ fail 0`
- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts src/core/command.ts src/core/tool/plan.ts src/core/prompt.ts test/references.test.ts test/plan.test.ts test/prompt.test.ts
git commit -m "feat(references): /pin, /unpin and plan.references"
```

---

### Task 6: Pengingat rencana

**Files:**
- Modify: `src/core/agent.ts` (sekitar `closing` di ±baris 1080, yang menyuntik `instructions` di `prepareStep`)
- Test: `test/run-until-done.test.ts`

**Interfaces:**
- Consumes: `readPlan` (storage).
- Konstanta `PLAN_NUDGE_AFTER = 8` dan teks `PLAN_NUDGE_NOTE`:

  > `"You have taken several actions without a plan. If this work has more than a few steps, write it now with the plan tool as - [ ] checkboxes; Titah uses them to keep going until the work is done."`

- [ ] **Step 1: Tulis test yang gagal**

```ts
test("agent primary yang sudah 8 tool call tanpa rencana menerima pengingat lewat instructions", async () => {})
test("pengingat tidak masuk riwayat model_message", async () => {})
test("sub-agent tidak pernah menerima pengingat rencana", async () => {})
test("pengingat berhenti setelah rencana ditulis", async () => {})
```

- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi.**
  - Di `prepareStep`, bila `!isChild`, jumlah tool call sejauh ini ≥ 8, dan `readPlan(session.id) === undefined`, tambahkan `PLAN_NUDGE_NOTE` ke `instructions`.
  - Gabungkan dengan `LAST_STEP_NOTE` bila keduanya berlaku. Komentar menjelaskan kenapa lewat `instructions`, merujuk alasan `LAST_STEP_NOTE`.
- [ ] **Step 4: Jalankan, pastikan lulus.**
- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts test/run-until-done.test.ts
git commit -m "feat(agent): nudge the primary agent to write a checkbox plan"
```

---

### Task 7: Tanda cache kedua untuk referensi (OpenAI-compatible)

**Files:**
- Modify: `src/core/cache-control.ts:58-100` (`markCacheControl`)
- Modify: `src/core/schema.ts` (opsi provider `cacheReferences?: boolean`, default `true`, hanya berarti bila `cacheControl` menyala)
- Modify: `src/core/provider.ts:124` (teruskan opsi ke `withCacheControl`)
- Test: `test/cache-control.test.ts`

**Interfaces:**
- `markCacheControl(body: unknown, options?: { references?: boolean }): unknown`
- `withCacheControl(base?: typeof fetch, options?: { references?: boolean }): typeof fetch`

- [ ] **Step 1: Tulis test yang gagal**

```ts
test("pesan user yang dibuka <references> mendapat tanda cache di blok terakhirnya", () => {})
test("tanpa pesan referensi, hanya system yang ditandai seperti sebelumnya", () => {})
test("cacheReferences false hanya menandai system", () => {})
test("blok yang sudah bertanda tidak ditandai dua kali", () => {})
```

- [ ] **Step 2: Jalankan, pastikan gagal.**
- [ ] **Step 3: Implementasi.** Cari pesan `role: "user"` **terakhir** yang kontennya diawali `<references>`, lalu tandai blok terakhirnya dengan `EPHEMERAL`, memakai aturan anti-tumpuk yang sama seperti untuk system.
- [ ] **Step 4: Jalankan, pastikan lulus.**
- [ ] **Step 5: Verifikasi terhadap 9router sungguhan.**
  - Jalankan `npm run dev` di repo uji dengan satu `/pin` kecil, lalu kirim dua prompt.
  - Lihat `usage` di `titah stats` atau di pesan: prompt kedua harus menunjukkan cache read.
  - Kalau gateway menolak permintaan, laporkan error-nya ke user dan **jangan** ubah default diam-diam.
- [ ] **Step 6: Commit**

```bash
npm run schema
git add src/core/cache-control.ts src/core/schema.ts src/core/provider.ts config.schema.json test/cache-control.test.ts
git commit -m "feat(cache): second cache mark after pinned references on OpenAI-compatible providers"
```

---

### Task 8: Pengukuran, dokumentasi, rollout

**Files:**
- Create: `scripts/measure-stops.ts` (logika `stops2.mjs` dari sesi brainstorming: kelompokkan pesan user "lanjutkan/next/continue" menurut keadaan assistant sebelumnya, read-only, path DB dari argumen atau `dataDir()`)
- Modify: `CHANGELOG.md`, `README.md` (bagian limits/compaction), `DESIGN.md` §3 (tautan ke spec)

- [ ] **Step 1: Tulis skrip.** Jalankan `node scripts/measure-stops.ts` pada DB user dan simpan output *sebelum* di bagian "Pengukuran" spec, dengan tanggal.
- [ ] **Step 2: CHANGELOG.**
  - `compaction.target` dan `compactAt` baru.
  - Anggaran giliran turunan dihapus.
  - `continueTurns` tanpa nilai berarti "sampai selesai" di TUI dan web.
  - `/pin` dan `/unpin`.
  - Tanda cache referensi.
- [ ] **Step 3: Gate akhir**

Run: `npm run typecheck && npm test 2>&1 | tail -5`
Expected: typecheck tanpa output error; `ℹ fail 0`

- [ ] **Step 4: Commit**

```bash
git add scripts/measure-stops.ts CHANGELOG.md README.md DESIGN.md docs/superpowers/specs/2026-11-05-run-until-done-design.md
git commit -m "docs: run-until-done — changelog, measurement script, baseline numbers"
```

- [ ] **Step 5: Rollout config user. Tanyakan dulu, jangan otomatis.** Usulkan perubahan ini di `~/.config/titah/titah.json`:
  - hapus `"continueTurns": 0`;
  - `9router/ant` `contextWindow` dikembalikan ke angka asli dan `compactAt: 131072`;
  - tulis ulang komentar "LANTAI YANG SENGAJA RENDAH" yang sekarang menyesatkan.

  Terapkan hanya setelah user setuju.
- [ ] **Step 6: Pengukuran sesudah.** Ini butuh user dan model sungguhan, jadi ditawarkan, bukan dijalankan otomatis: tugas tetap "bangun web app dari `./template`", 3× per model, catat intervensi, lanjutan, token, dan kemiripan.
