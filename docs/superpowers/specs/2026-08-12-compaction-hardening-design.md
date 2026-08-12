# Compaction hardening: a bounded summariser, a measured request, an atomic flush, and a pruner that knows what things cost

Design, 2026-08-12. Baseline: `main` @ `c473430`, 599 tests green, typecheck and
build clean.

Closes issues #1, #2, #3, #4. Issue #5 (intent state) is deliberately out of
scope here and has its own design — see
[`2026-08-12-intent-state-design.md`](./2026-08-12-intent-state-design.md).

## The problem

Automatic compaction shipped in the previous cycle
([`2026-08-11-auto-compaction-design.md`](./2026-08-11-auto-compaction-design.md))
and moved a mechanism the user used to invoke by hand into a mechanism that runs
unbidden, mid-turn, on every long session. Four defects follow from that change
of exposure. None of them fails a test today, which is the point: they are
runtime behaviours no test pins.

Two of them are about *correctness of the record*, and rank above the other two:

- **The summariser's own prompt is unbounded** (#1). With `smallModel`
  declaring `contextWindow: 4096`, the prompt sent measured **78,964 tokens via
  `/compact` and 79,662 via the automatic path** — 19.3× and 19.4×. Nothing
  calls `contextWindowFor` for `smallModel`; nothing bounds `compactPrompt`
  (`src/core/compact.ts:327`).
- **`appendModelMessages` has no transaction** (#3). `src/core/storage/session.ts:284-292`
  is a bare loop of INSERTs, and the only `BEGIN` anywhere in
  `src/core/storage/` is the migration loop at `src/core/storage/db.ts:102`.

And two are about *cost and lost work*:

- **The savings decision is arithmetic on a stale number** (#2).
  `remainingConservative` (`src/core/auto-compact.ts:146`) subtracts an 8:1 byte
  estimate from `inputTokens` the provider reported for a **different** request
  one step ago. Measured: at 28 KB and 32 KB results on an 8192 window, the
  request that would actually be sent is **490 tokens — 6% of the window — and
  the summariser still fires on 29 of 30 steps.**
- **The pruner discards sub-agent results** (#4). `pruneToolOutputs`
  (`src/core/compact.ts:121-154`) never reads `toolName`, so a `task` result is
  replaced by a marker telling the model to *"re-run the tool if you need it"* —
  advice that costs a whole nested turn.

### Why #1 is the one that cannot be left

It is the only remaining **silent** failure in the feature. The provider does
not reject an oversized prompt; it truncates the oldest part. The summariser then
writes a confident summary of material it never saw, and the model works from a
record that is wrong, with no signal anywhere. That is precisely the hazard named
in the opening comment of `src/core/compact.ts:5-13`.

Two things make it worse than the raw multiple suggests. Before automatic
compaction, `summarise` ran only when the user typed `/compact`, so the user
chose it. And the fix that moved `/compact` from the turn's model to `smallModel`
**widened** the exposure on that path: `/compact` previously used a model whose
window matched the conversation.

### Why #4 was not caught by review

Parallel sub-agents and automatic compaction were built and reviewed as separate
features, each against its own brief, and neither review's scope included the
other. The interaction appears only when a `/tim` turn is long enough to trigger
compaction — which is exactly the kind of turn `/tim` exists for. The lesson is
recorded here because it is the second time an interaction defect has surfaced
between two independently-reviewed features, and it belongs in the process, not
in a comment.

## Decisions

### 1. The summariser summarises in chunks, each guaranteed to fit

Three options were considered. **Chunking wins because it is the only one where a
long session still gets compacted.**

| Option | Why not |
|---|---|
| Bound `compactPrompt` and refuse loudly when it does not fit | Turns a silent failure into a loud one, but the session still dies of context overflow — on exactly the long sessions compaction exists to save. |
| Fall back to the turn's model | Sound and cheap (the dropped transcript provably fits the turn model's window, since it was part of a history that fit), but it spends expensive-model tokens precisely when sessions are longest, which is what `smallModel` exists to avoid. |
| **Chunk against the resolvable window** | Chosen. Never refuses, never truncated silently, keeps `smallModel`. Costs several `smallModel` calls on a huge transcript, and a summary-of-summaries is lossier than a single pass. |

Both callers go through **one** entry point in `src/core/compact.ts`, so
behaviour is identical on the `/compact` path (`src/core/agent.ts:973-982`) and
the automatic path (`src/core/auto-compact.ts:207`). Two copies of a chunking
rule would drift, and a drifting rule here means one path silently truncating
again.

```
summariseInChunks(summarise, source, focus, chunkBytes)
  split at MESSAGE boundaries — never split one message across chunks
  a single message larger than a chunk is truncated EXPLICITLY, with a marker
  more than one chunk → summarise each, then summarise the summaries
  the joined summaries still too large → recurse
```

**Chunk size** is `budgetTokens(window, reserved)` minus the rendered size of
`COMPACT_SYSTEM` and the prompt wrapper, converted at `REAL_BYTES_PER_TOKEN`.
The system prompt eats the same window as the transcript; a chunk budget that
ignores it overflows anyway, which is the naive version of this fix.

**Window resolution**, in order: `contextWindowFor(config, config.smallModel)`,
then the turn model's window. The fallback is not a guess — it is the window
that must already be declared for automatic compaction to be on at all, and when
`smallModel` is unset the turn's model *is* the summariser. Consistent with the
existing rule at `src/core/provider.ts:156-165`: an undeclared window means off,
never guessed.

**`titah doctor` names a `smallModel` whose window is undeclared.** The bound
cannot be enforced without one, so the user has to be able to see it.

**One failed chunk abandons the whole summarisation and returns empty**
(decided during implementation, after the first attempt got it wrong). The
first version skipped a chunk that came back empty and carried on with the rest,
reasoning that one transient 503 should not throw away the other chunks' work.
That is wrong twice over:

- A summary missing one chunk of the transcript, saved as though complete, *is*
  the failure this whole feature exists to prevent — a confident record of
  material nobody ever saw. Returning empty is strictly better: the caller then
  leaves the old history alone.
- `synthesizerFor` returns an empty string rather than throwing when the model
  fails **or when the turn is cancelled** (`streamText` routes provider errors to
  `onError`). So continuing after a cancel means calling the model again with an
  already-aborted signal — and the `abort` listener there never fires a second
  time, so that call hangs forever. Measured: one turn hung for 20 seconds until
  its test gave up, on a path the user never asked for.

### 2. The savings question is answered by measurement, not arithmetic

`autoCompact` takes a `measure: (messages: ModelMessage[]) => number` from its
caller. `src/core/agent.ts` assembles the request, so it is the only place that
honestly knows the whole shape — system prompt, summary, history. `needsMore`
and `doesNotFit` consult that measurement instead of subtracting an estimate
from a stale number.

`estimateTokens` and `BYTES_PER_TOKEN` are **deleted from `src/`**, not merely
left unused. The acceptance criterion asks for a test that fails if the code
silently reverts to arithmetic on a stale number; removing the function is the
strongest form of that — there is nothing left to revert to. The three tests
pinning the 8:1 ratio (`test/compact.test.ts:330`, `:353`, `:602`) are replaced
by tests pinning the measurement.

**The trigger is not touched.** `projectedContext` and `overBudget` answer "is it
time?", which runs every step and legitimately reads the provider's last real
count plus what has arrived since. This issue is about "was the saving enough?".
Conflating the two would undo `395239d` and `63c841a`.

`measure` is injected rather than computed inside `autoCompact` for the same
reason `summarise` is: the tests must run without a provider.

### 3. The flush is all-or-nothing

A `transaction<T>(fn: () => T): T` helper in `src/core/storage/db.ts` — lifting
the `BEGIN`/`COMMIT`/`ROLLBACK` shape already at `:102-111` into one place rather
than copying it. `appendModelMessages` wraps its loop **including `nextSeq`**:
reading `MAX(seq)` outside the transaction lets the number go stale before the
first insert lands.

Other multi-statement write paths in that file are audited and wrapped only where
a partial failure can leave a half-written state. Single-INSERT paths are already
atomic and are left alone — the point is the invariant, not uniformity of style.

The failure this prevents is specifically silent: a partial failure leaves rows
written while the turn's `flushed` offset stays stale, the end-of-turn write
re-appends the same messages, and because `nextSeq` is `MAX(seq) + 1` the
`PRIMARY KEY (session_id, seq)` does **not** reject the duplication — history
doubles. Mid-turn compaction's own `try`/`catch` (`src/core/agent.ts:533`) then
converts a loud crash into a quiet one, which is right for the turn and wrong for
the record.

### 4. The pruner distinguishes cheap output from expensive output

Two tiers, because the acceptance criteria are two different sentences.

| Where | Policy |
|---|---|
| History, before the cut (ordinary prune) | `task` results are **exempt**. Summarisation handles them instead — lossy, but not destructive. |
| The tail, last resort (only when `doesNotFit`) | Nothing is exempt, but a dropped `task` result gets its **own marker that states the cost**: re-running it means another full sub-agent turn. |

Exempting `task` in the tail as well would restore the original hazard: the
request stays oversized, the provider truncates silently, and the model answers
confidently about material it never saw. Losing the tail's contents is the lesser
harm — that is already the reasoning behind `doesNotFit`
(`src/core/auto-compact.ts:158-179`), and it does not change here.

`MARKER_BYTES` becomes per-marker. The `task` marker is longer, and `bytesFreed`
has to keep meaning *bytes genuinely freed* — overstating it makes the caller
believe it has lightened enough when it has not, which is the bug
`src/core/compact.ts:93-101` already warns about.

## Testing

Per fix, test first, then the code.

| Issue | The interesting assertion |
|---|---|
| #1 | A transcript larger than the summariser's declared window produces a summary via more than one bounded call, and **no single call exceeds the window**. Identical on both the `/compact` and automatic paths. `doctor` names an undeclared `smallModel` window. |
| #2 | Summariser call count on the measured scenarios (22/26/28/32 KB) drops to what the context actually requires, and no request exceeds the declared window at any of them. |
| #3 | A flush that fails part-way leaves the row set **unchanged**, and `listModelRows` has no duplicated adjacent message after a failed flush followed by the end-of-turn write. |
| #4 | A transcript holding both a `task` result and a `read` result, pruned, has **only the `read` result replaced**. In the tail-prune path the `task` marker states its cost. |

Failure injection for #3 uses a message whose `JSON.stringify` throws (a
`BigInt`) — deterministic, and no mocking of the database.

## Review round, 2026-08-12

`/code-review` on PR #6 found six defects in this cycle's own work. Four were
outright bugs, two of which were as severe as the issues this cycle set out to
close, and none of them failed a test — the same pattern that produced #1–#4 in
the first place. All six are fixed on the branch; three were reproduced with
independent measurements before being accepted.

| # | Where | What |
|---|---|---|
| R1 | `compact.ts` depth-limit fallback | Took `packChunks(...)[0]` — the **first** chunk — and dropped the rest with no marker. Measured: 15,908 bytes of material became a 506-byte summary, no `truncated` anywhere, then saved while the watermark advanced. ~97% of history lost permanently, silently. Now joins every chunk summary and marks the cut. |
| R2 | `summariserWindowFor` returning `0` | An undeclared window fell through the budget arithmetic to a negative number, which the `MIN_CHUNK_BYTES` floor tamed into the **smallest possible chunk**. Measured: `summariserChunkBytes(0, 8192) === 512`, so a 200 KB transcript on `/compact` became ~400 sequential `smallModel` calls where it used to be one. Now `undefined` means don't chunk — the same rule `contextWindowFor` already follows. |
| R3 | `doesNotFit` after a failed summarisation | `summariseInChunks` returns empty rather than throwing, so nothing is saved and the watermark does not move — yet the fit check measured only the tail. `pruneTail`, the one lever left, never ran. Now the measured set depends on whether summarisation actually happened. |
| R4 | `packChunks` truncation | `String.prototype.slice` (UTF-16 code units) against a **byte** budget. Measured: 2,000 CJK characters with a 1,000-byte budget produced 2,834 bytes — 2.8×. `sliceBytes` truncates by bytes without splitting a character. |
| R5 | `measure()` between turns | The pending user message is not in the rows yet, so a 40 KB paste was invisible to the decision it should have driven. Now counted. |
| R6 | The `requestTokens` limit, as documented | The claim that under-counting is bounded by "a few hundred tokens" was **wrong**: token-dense content (code, CJK, base64) lands at 2–3 bytes per token, so the estimate can be 30–50% low. Corrected in the code, the commit message, and the PR body. |

**R6 is a documented limit, not a fix.** `reserved` is headroom above the budget,
so an under-count of roughly a third is absorbed without any request passing the
window; beyond that it can pass, and the only recovery is the trigger — which
reads the provider's real number — firing again the next step. The correct
replacement is counting tokens with the provider's tokenizer instead of a ratio.
Titah has no such path today, and until it does, this limit is real.

**What R1, R2 and R4 have in common** is worth naming: all three are in the
chunking code added for #1, and all three were the *bounding* logic itself
failing to bound. A guard is the last place where "it looks right" should be
accepted, and the tests written for #1 checked that chunking *happened* rather
than that its output was whole and within budget. The new tests assert the
output.

## Second review round, 2026-08-12

A second `/code-review` on the same PR — after the fixes above — found five more.
That is the honest headline: **two consecutive review rounds each found real
defects in this cycle's work**, and the second round's findings were mostly in the
code the first round had just produced.

| # | Where | What |
|---|---|---|
| S1 | `summariserChunkBytes` overhead | The `focus` text — the user's entire prompt, unbounded — was appended to **every** chunk prompt and counted by nobody. Measured: chunk budget 11,047 bytes, actual prompt **42,515 bytes ≈ 10,629 tokens against a 4,096 window** (2.6×), with the transcript sitting *first* so the provider truncated exactly the material being summarised. Issue #1's bound was defeated by one pasted file. Now `summariseInChunks` owns the whole budget, and `focus` is clamped to a quarter of it. After: largest prompt 11,902 bytes ≈ 2,976 tokens. |
| S2 | `doesNotFit` | Made purely measurement-based by #2, and it deliberately skips `reserved` — so nothing absorbed `requestTokens`' own admitted 30–50% under-count. A provider reporting 8,354 tokens on an 8,192 window while the same messages measure ~6,100 meant the tail was never pruned, every step. The provider number is back as a second signal, credited with what was freed; the larger of the two wins. |
| S3 | sparing `task` in old history | #4's protection assumes the summariser will represent those results. When the summariser **fails**, nothing is saved, the watermark does not move, and `pruneTail` only reaches `[cut, end)` — so a 22 KB `task` result in old history sat outside every remaining lever. It now yields, with the cost-stating marker, before the tail is touched. |
| S4 | summariser model vs window | The summariser was resolved from `config.smallModel ?? input.model` while its window came from `agentDef?.model ?? modelOverride` — **two expressions for one decision**. They diverge in a real case: `subagent.ts` calls `prompt()` with no `model`, so an agent declaring its own model gave a 400,000-token window while `config.model` (8,192) did the summarising. `summariserModelFor` is now the single source for both. |
| S5 | `?? 0` in `autoCompact` | Converted "unknown window" back into the `0` that S-round-one had just removed, one edit away from being live. Dropped. |

**The pattern across both rounds is the same shape of mistake**, and it is worth
stating plainly rather than filed as five items: every one of these is a *bound*
that trusted a number computed somewhere else. S1 trusted a caller to have
subtracted the overhead; S2 trusted a byte ratio where a provider fact was
available; S4 trusted two expressions to stay equal. The structural answer, applied
in each case, is to give the bound everything it needs and let it do its own
arithmetic — `summariseInChunks` now owns the whole prompt budget, `doesNotFit`
consults both signals, and one function resolves the summariser model.

**Not every fix has a test that would catch a regression.** S4's fix is structural
(one expression used twice); its test pins `summariserModelFor`'s semantics, not
agent.ts's wiring. S5's guard is unreachable today, so nothing exercises it. Both
are stated here rather than counted as covered.

## Out of scope

Intent state (#5) — its own design. The gap-analysis backlog (MCP, web tools,
LSP, hooks, background bash, server auth, eval harness) is untouched: this cycle
finishes the feature that is already shipped rather than starting the next one.

## Gate

- `npm run typecheck && npm run build && npm test` green
- No `any` in `src/`
- New comments in Indonesian explaining WHY; new user-facing strings in English
- `DESIGN.md` §3 no longer says `task`/subagent spawning is deferred to v2, and
  `CHANGELOG.md` records compaction and sub-agents — both drifted from the code
  and are corrected as part of this cycle, since #1 and #5 both turn on the
  design doc being silent where it should not be.
