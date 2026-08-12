# An atomic model-history flush, and a pruner that knows what things cost

Design, 2026-08-12. Baseline: `main` @ `c473430`, 599 tests green, typecheck and
build clean.

Closes issues #3 and #4. Issues #1 and #2 (the summariser's unbounded prompt, and
the stale-number arithmetic behind the savings decision) were originally part of
this cycle and are now a separate change — see
`2026-08-12-compaction-hardening-design.md` on that branch. Issue #5 (intent
state) is a design pass with no code:
[`2026-08-12-intent-state-design.md`](./2026-08-12-intent-state-design.md).

## Why these two split off from the rest

All four issues came from the same change of exposure: automatic compaction moved
a mechanism the user used to invoke by hand into one that runs unbidden, mid-turn,
on every long session. But the four are not equally settled. Three review rounds
found eleven further defects in the #1/#2 work — including one regression against
`main` — while #3 and #4 were reviewed three times and came back sound both times
after their own single follow-up each. Holding the settled half hostage to the
moving half serves nobody, so they ship separately.

## The problem

- **`appendModelMessages` has no transaction** (#3). `src/core/storage/session.ts:284-292`
  is a bare loop of INSERTs, and the only `BEGIN` anywhere in
  `src/core/storage/` is the migration loop at `src/core/storage/db.ts:102`.
  Automatic compaction changed the exposure materially: the flush now runs
  **mid-turn, on every compaction trigger**, not once at the end of a turn.
- **The pruner discards sub-agent results** (#4). `pruneToolOutputs`
  (`src/core/compact.ts:121-154`) never reads `toolName`, so a `task` result is
  replaced by a marker telling the model to *"re-run the tool if you need it"* —
  advice that costs a whole nested turn.

### Why #4 was not caught by review

Parallel sub-agents and automatic compaction were built and reviewed as separate
features, each against its own brief, and neither review's scope included the
other. The interaction appears only when a `/tim` turn is long enough to trigger
compaction — which is exactly the kind of turn `/tim` exists for. The lesson is
recorded here because it is the second time an interaction defect has surfaced
between two independently-reviewed features, and it belongs in the process, not
in a comment.

## Decisions

### 1. The flush is all-or-nothing

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

### 2. The pruner distinguishes cheap output from expensive output

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

## Review rounds

Both issues drew one follow-up finding each, from the second and third
`/code-review` rounds on the original combined PR.

| Where | What |
|---|---|
| `auto-compact.ts`, sparing `task` in old history | The exemption assumes the summariser will represent those results. When the summariser **fails**, nothing is saved, the watermark does not move, and `pruneTail` only reaches `[cut, end)` — so a 22 KB `task` result in old history sat outside every remaining lever, where before the exemption it was pruned unconditionally. It now yields, with the cost-stating marker, before the tail is touched. |
| `storage/db.ts`, the transaction itself | `BEGIN` (DEFERRED) opens a read snapshot and upgrades on the first write; in WAL mode that upgrade can fail with `SQLITE_BUSY_SNAPSHOT`, which `PRAGMA busy_timeout` does **not** retry — while the bare inserts it replaced *were* covered by that timeout. A TUI and a `titah run` on one database was enough to lose a successful turn's history. `BEGIN IMMEDIATE` takes the write lock up front. Separately, `ROLLBACK` in the catch could itself throw and replace the real error; it is now caught and the original rethrown. |

**Not covered by a test:** `BEGIN IMMEDIATE` itself. Reproducing
`SQLITE_BUSY_SNAPSHOT` needs two processes racing on one database, and a flaky
test is worse than a documented gap. The `ROLLBACK` masking fix *is* pinned.

## Testing

Per fix, test first, then the code.

| Issue | The interesting assertion |
|---|---|
| #3 | A flush that fails part-way leaves the row set **unchanged**, and `listModelRows` has no duplicated adjacent message after a failed flush followed by the end-of-turn write. Failure injection uses a message whose `JSON.stringify` throws (a `BigInt`) — deterministic, and no mocking of the database. Plus: the original error survives a `ROLLBACK` that itself fails. |
| #4 | A transcript holding both a `task` result and a `read` result, pruned, has **only the `read` result replaced**. In the tail-prune path the `task` marker states its cost. And when summarisation fails, the spared `task` result yields rather than leaving the request oversized. |

## Gate

- `npm run typecheck && npm run build && npm test` green
- No `any` in `src/`
- New comments in Indonesian explaining WHY; new user-facing strings in English
