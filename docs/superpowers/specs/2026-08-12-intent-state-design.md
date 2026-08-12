# Intent state: a small protected store the model writes its plan into

Design, 2026-08-12. Baseline: `main` @ `c473430`, 599 tests green.

Answers issue #5. **This document is a design pass only — no code lands from it
in this cycle.** The issue is deliberately open, and the four questions below are
the ones it asks to have answered before anything is built.

## The problem

Titah tracks **execution state** well and has no **intent state** at all.

`ToolState` (`src/core/message.ts`) is a five-variant union — `pending`,
`running`, `completed`, `error`, `denied` — and it earns its detail: `denied` is
deliberately distinct from `error` because a refused permission is not a failure,
and `completed` carries `outcome?: "failed" | "stopped"` so `task` does not render
a success glyph over a sub-agent that failed. Sub-agents have their own
`queued → running → done | failed | stopped`.

All of that answers *"what is happening right now"*, for the user watching.
Nothing answers *"what does the model intend to do"*, for the model itself.

There is no `todowrite`-style tool (verified: zero matches for `todo`,
`checklist`, or `plan_` anywhere in `src/`), so the model's only memory of a
multi-step plan is the transcript — and the transcript is now summarised
automatically, **mid-turn**, exactly during the long agentic turns where a plan
matters most. Per-agent `steps` now allows 60-step turns, so there is more room
to forget the plan than there was when the limit was a hardcoded 20.

**Adding a todo tool alone would not fix this.** Its contents would live in the
transcript and be summarised with everything else. The interesting version of
this ticket is not "add a todo list" but "give the model a small protected store,
and let the plan live in it".

## The shape already exists

Compaction already has a store that survives pruning. `saveCompaction`
(`src/core/storage/session.ts:331`) writes to a `compaction` table — outside
`model_message` entirely — and `listModelMessages` (`:356-367`) prepends it to
every turn ahead of the watermark. The pruner only rewrites `model_message` rows
(`replaceModelMessage`, `:301`), and the summariser only reads rows above the
watermark, so neither can reach it.

What is missing is a way for the **model** to put something there deliberately.

## The four questions

### 1. Where does plan state live, and why can compaction not reach it?

A new `plan` table, one row per session: `(session_id PRIMARY KEY, text,
updated)`. Not a column on `session`, so that reading the plan never means
loading and rewriting session metadata; not a row in `model_message`, which is
the only table compaction touches.

Compaction cannot reach it for the same structural reason it cannot reach the
summary, and this is a property of the schema rather than a rule anyone has to
remember: `pruneToolOutputs` rewrites `model_message` rows and `planCompaction`
selects `model_message` rows. Neither names the `plan` table, and neither can.

**Read path.** `listModelMessages` grows a second protected pair, after the
summary pair and before the tail:

```
[ user: <context-summary>…  ]  ← existing, when a compaction exists
[ assistant: Understood…    ]
[ user: <plan>…             ]  ← new, when the plan is non-empty
[ assistant: Understood…    ]
…tail, which always begins with a user message
```

The pair, rather than a single user message, is not cosmetic: the retained tail
always starts with a `user` message, so a lone user message here would produce
two consecutive user turns — rejected by some providers and silently merged by
others. That reasoning is already recorded at `src/core/storage/session.ts:347-355`
and applies unchanged.

### 2. Who writes it, and who reads it?

**The model writes it, through one tool.** Whole-document replace — `plan(text)`
sets the entire plan, an empty string clears it. Rejected alternative: granular
todo items with add/complete/reorder operations. That is a second state machine
next to `ToolState`, and it buys step-level status that the transcript already
shows while costing a tool surface the model has to learn. A markdown document
the model rewrites is something it is already fluent in.

**Every turn reads it**, exactly like the summary — no tool call, no decision, no
opportunity to forget. A store the model must remember to read is a store that
answers the wrong question: forgetting is the failure being fixed.

**The user reads it too.** It renders in the TUI, because a plan that has gone
stale is only visible if it is on screen, and a stale plan is a real failure mode
(see Risks).

**No permission axis.** Writing a plan touches neither the filesystem nor the
shell; it is a bounded write to Titah's own database. The missing axes named in
`docs/gap-analysis.md` §10 — `task`, delegation, network — are all about spending
something the user owns. This spends nothing.

### 3. What happens across turns, and does a child session inherit it?

**Across turns:** it persists for the life of the session. That is the whole
point — surviving compaction is surviving the mechanism that eats turns.

- Cleared explicitly by the model writing an empty plan, and by `/new` (a new
  session is a new row).
- **`/undo` does not touch it.** Undo reverts a turn's file changes; the plan is a
  record of intent, not a file, and a plan reverted to a previous state would
  describe work the working tree no longer matches. Stated explicitly here
  because the opposite is a defensible guess.
- A resumed session (`/session`, `-s <id>`) reads its plan back with its history.

**A child session ignores its parent's plan, and gets its own empty store.**

A sub-agent is briefed deliberately: "Subagents see none of the coordinator's
conversation, so each task must carry the paths, constraints, and report format it
needs" (`README.md`, Sub-agents). Inheriting the coordinator's plan would leak
exactly the context that brief excludes, and it would invite several sub-agents
to write to a store their coordinator owns — a write race between siblings, over
the one piece of state that is supposed to be reliable. Its own store dies with
it, which is correct: its plan was for its own task.

The coordinator's plan is therefore the only one that outlives a turn, and that
matches the existing one-level dispatch cap: there is exactly one planner.

### 4. How is it bounded?

Two bounds, and neither is a silent truncation.

- **A hard byte cap at write time.** The tool **rejects** a plan over the cap with
  an error naming the limit and the actual size, and the model shortens it and
  writes again. Failing hard is the same choice `edit` already makes
  (`DESIGN.md` §3): better a refusal than a silent write of the wrong thing.
- **A cap relative to the window.** The plan is prepended to every request, so on
  a small model an absolute cap is the same collision `reserved` already hit — an
  8192-token window where a 4 KB plan takes an eighth of the budget before any
  conversation exists. The effective cap is `min(absolute, window / N)` with the
  same `RESERVE_FRACTION`-style shape used at `src/core/compact.ts:346-365`, so a
  reader who has understood one of these numbers has understood all of them.

**It must also be counted, not just capped.** The plan rides in every request, so
it belongs in the measurement that issue #2 introduces — the `measure` function
`autoCompact` receives. A protected store excluded from the budget is a second
unbounded context problem wearing a cap.

## Explicitly not solved here

**Sub-agent results do not move into this store.** Issue #4 names that as an
option ("store sub-agent results outside the transcript entirely"), and it is
rejected: this store is small, bounded, and single-writer by design, while
sub-agent answers are unbounded and arrive from several writers at once. Putting
them here trades a pruning bug for an unbounded-store bug. #4's own fix —
exempting `task` results from ordinary pruning — addresses that from the right
side.

## Risks

**A stale plan is worse than no plan.** The model may finish a step and not
update the document, and a confident wrong plan is exactly the failure mode
`COMPACT_SYSTEM` is written to avoid in summaries. Three mitigations, in order of
how much they are worth: render it in the TUI so the user sees the drift; state in
the prompt that the plan is the model's own record and must be updated as steps
complete; and keep it small enough that rewriting it is cheap. None of these is a
guarantee, and this design does not claim one.

**It is one more thing in every request.** On a small local model the budget is
already tight. The window-relative cap bounds it, and the measurement makes it
visible instead of hidden.

## What would make this worth building

The evidence to collect while using Titah for real work, before writing code:
how often a long turn actually loses its plan, and whether the loss shows up as
repeated work or as silently skipped steps. `docs/gap-analysis.md` §12 predicts
both. If the observed failure is repeated work, this store is the fix. If it is
skipped steps, the fix may instead be in how `/tim` briefs its sub-agents — a
cheaper change to a smaller surface.
