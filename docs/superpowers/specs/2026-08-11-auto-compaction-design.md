# Auto-compaction, tuning, and per-agent step limits

Design, 2026-08-11. Baseline: `main` @ `b334908`, 511 tests green.

## The problem

`src/core/compact.ts` contains no notion of a token count, a threshold, or a
context window. Compaction runs only when the user types `/compact`. Nothing in
Titah knows how large any model's context window is.

So a long session is never trimmed — it **dies**, with a context-length error
from the provider, mid-work, and that turn's work is lost. The user has to guess
when to type `/compact`, and finds out the guess was wrong only after the damage.

The failure is worse than "a long conversation". The scenario that actually
breaks is **one agentic turn**: `MAX_STEPS = 20` steps reading thirty files
accumulates tool results in a single turn, with no user message in between where
a between-turns check could fire.

Two secondary problems are in scope because they are entangled with the first:

- **`MAX_STEPS = 20` is hardcoded** (`src/core/agent.ts:51`) and nothing checks
  whether the limit was reached. When step 20 ends on a tool call,
  `src/core/agent.ts:406-410` tells the user *"the model stopped without giving a
  text answer — try again, or use a different model"*. The model is fine; it ran
  out of steps. The advice sends the user in the wrong direction.
- **`/compact {message}` already works** — `compactPrompt(transcript, focus)` at
  `src/core/compact.ts:123` and `README.md:652` — but `"compact"` sits in
  `IMMEDIATE_COMMANDS` (`src/core/command.ts:69`), so choosing it from the
  palette runs it instantly and the user never gets to type the focus. The
  comment at `src/core/command.ts:57` states the opposite rule; `compact` is the
  only entry violating it.

## Why the step limit and compaction ship together

`MAX_STEPS = 20` is currently an **accidental context limiter**. It bounds how
much a single turn can accumulate.

Raising it per-agent removes that accidental guard. Doing so before the real
guard exists makes the situation strictly worse than leaving the limit alone. So
per-agent `steps` is task 6, after mid-turn compaction is proven in tasks 1–5.
The ordering is the safety argument, not a preference.

## Decisions

| Question | Decision | Rejected |
|---|---|---|
| Where does the context limit come from? | Declared in config, per model | models.dev dataset; a shipped defaults table |
| When does it fire? | Between turns **and** mid-turn | Between turns only |
| How many mechanisms? | Two: prune, then summarise | Summarise only |
| Unknown model? | Auto-compaction off, said out loud | Silent off; guessed defaults |
| Per-agent `steps`? | Yes, same plan, after the guard | Separate plan; not at all |
| Per-agent `temperature`/`top_p`? | **No** | — |

`temperature`/`top_p` touch the same file (`schema.ts`) but share no risk with
compaction. Including them only enlarges the review surface.

---

## 1. Declaring the context window

`ProviderModel` (`src/core/schema.ts:29`) currently holds only `name`. Add one
optional field:

```jsonc
{
  "provider": {
    "ollama": {
      "models": { "qwen3:14b": { "contextWindow": 32768 } }
    }
  }
}
```

A resolver — `contextWindowFor(config, modelID)` — reads
`provider[p].models[m].contextWindow` and returns `undefined` when it is not
declared.

No shipped defaults table. `schema.ts:192` already states the principle for
`model`: *"Nothing is guessed."* A stale context window is worse than none,
because compacting too late is indistinguishable from not compacting: the
session still dies, but now the user believes it was handled.

`DEFAULT_EXTERNAL_AGENTS` is not a counter-precedent. Those arguments were
verified against the installed CLIs and a wrong value fails loudly and
immediately; a wrong context window fails silently and much later.

### When it is not declared

Auto-compaction is off **for that model**, and three things say so:

- `titah doctor` reports it as a finding, naming the exact config path to add.
- The TUI warns once per session.
- `/compact` still works — manual compaction never needed the limit.

## 2. The `compaction` config block

```jsonc
{
  "compaction": {
    "auto": true,
    "reserved": 8192,
    "tailTurns": 2,
    "prune": true
  }
}
```

- **`auto`** — master switch. `false` restores today's behaviour exactly.
- **`reserved`** — tokens held back from the window. It must cover two things
  that are absolute rather than proportional: the next response, and the
  summarisation call itself. This is why `reserved` is a token count and not a
  percentage. It does **not** cover the growth of the next step — that is a
  separate, automatic margin (section 3), because it is a property of the running
  turn rather than of the configuration.
- **`tailTurns`** — how many recent user turns survive verbatim. Replaces
  `KEEP_TAIL = 4`.
- **`prune`** — enable the cheap mechanism (section 4). Defaults to `true`;
  since pruning only runs once the threshold is crossed, it changes nothing until
  something has to give.

### Why `tailTurns` rather than a message count

`KEEP_TAIL = 4` counts **messages**. One agentic turn can be twenty messages, so
"the last 4 messages" today can be four tool results from the middle of a turn —
the initiating instruction already gone, and not one complete exchange preserved.

A *turn* is the unit a user can reason about. `tailStart()` already scans back to
a `user` message, so the boundary logic is unchanged; only the counting unit is.

## 3. The trigger signal

### The trap

`src/core/agent.ts:381` stores `part.totalUsage.inputTokens`, and **`totalUsage`
is the sum across every step, not the size of the context.** A 20-step turn
holding a steady 15k context reports `input` ≈ 300k.

Using that as the threshold fires compaction far too early and then continuously
— and it would look like the feature working, because compaction *is* happening.

### The correct signal

The input tokens of the **last step**:

- **Mid-turn** — `steps.at(-1)?.usage?.inputTokens`, available inside
  `prepareStep`.
- **Between turns** — a new field, `usage.context`, on the assistant message,
  recording the final step's input tokens. Kept separate from `usage.input`,
  which stays what it is today: the billing total. Two different quantities that
  must not share a field.

### The threshold

```
trigger  ⇔  lastStepInputTokens ≥ contextWindow − reserved − growthMargin
```

Both compaction paths use this one predicate. It is a pure function and is
tested as one.

**Amended after the whole-branch review.** The predicate first shipped without
`growthMargin`, and that gap was measured: `prepareStep` reads the **previous**
step's usage, so on an 8192-token window with a 6144 threshold it passed at
6142, and the very next step appended a whole 6 KB tool result, landing 257
tokens from the edge of the window without compaction ever firing.

`growthMargin` is the **largest tool result seen so far in the running turn**,
converted to tokens at the realistic 4-bytes-per-token ratio rather than the
conservative one used for savings — the safe direction is reversed for a budget.
It is per-turn state: it starts at zero for every turn and never crosses between
turns, or between a parent session and a child. It is capped at a quarter of the
available budget, because a result larger than that will not fit after any
compaction, so reserving room for it would move the overflow rather than prevent
it.

`reserved` and `growthMargin` are therefore two separate jobs, and the config
documents them as such: `reserved` covers the next *response* and the
summarisation call; `growthMargin` covers the next *step's* input.

### Resetting after compaction

The tracked value is cleared when compaction runs. Without this, the stale
pre-compaction number immediately re-triggers compaction on the next check, and
the session compacts in a loop while making no progress — a failure that would
look like the model being slow rather than a bug.

## 4. Mechanism: flush, prune, summarise

### The trap

`appendModelMessages` is called **once, at the end of the turn**
(`src/core/agent.ts:420`), with `[userTurn, ...steps.flatMap(...)]`. Mid-turn,
not one row exists in the database — while the entire existing compaction engine
(`planCompaction`, the watermark, `saveCompaction`) operates on rows.

The tempting shortcut is a second code path over the in-memory message array.
Two consequences make it wrong:

1. Two compaction mechanisms must be kept in agreement forever.
2. The in-memory path leaves **no trace**. The turn ends, the next turn sends the
   full history again, and blows up immediately. The mid-turn work is undone by
   the turn ending.

### The design

Flush first, then use the mechanism that already exists.

```
trigger
  │
  ├─ 1. flush the turn-so-far to rows   (they were going to be written anyway)
  ├─ 2. prune old tool output           (free — no model call)
  ├─ 3. still over threshold? summarise (planCompaction + saveCompaction)
  └─ 4. rebuild the array from modelMessages(), return it from prepareStep
```

Between-turns compaction is the special case where everything is already
flushed. **One path, not two.**

The cost is honest and bounded: `appendModelMessages` at the end of the turn must
skip what was already written, so the turn tracks a flush offset. That is the
price of unifying the paths, and it is cheaper than keeping two engines in sync.

### Pruning

Pruning replaces the **output** of `tool-result` parts with a short marker naming
the tool and stating that its output was dropped. It never removes a message, so
no `tool-result` is ever orphaned from its `tool-call` — the structural invariant
of section 5 is untouched by pruning.

**Which results are pruned:** everything before the cut point of section 5 — the
same `tailTurns` boundary summarisation would use, and mid-turn the same
non-`tool` index. Reusing one boundary means the recent exchange keeps its tool
output verbatim under both mechanisms, and there is only one rule to get right.

It runs first because it is free, and because in an agentic turn tool output *is*
the bulk of the context. Its risk is that the model re-reads a file. That is
recoverable; a summary that quietly drops a decision is not.

### Knowing whether pruning was enough

Step 3 asks "still over the threshold?", and there is no way to answer it
exactly: token counts come from the provider, and asking costs the very request
we are trying to make safe.

So the decision uses an **estimate of what pruning removed** — the byte length of
the discarded output, converted at a fixed, documented ratio — subtracted from
the last measured step. The estimate is used **only** for this second-order
decision. It never drives the trigger in section 3, which stays on numbers the
provider reported.

The ratio is deliberately **conservative — it under-counts the saving.** The two
errors are not symmetric:

- Under-estimating the saving summarises when pruning would have sufficed: one
  extra `smallModel` call.
- Over-estimating it skips a needed summarisation and sends an oversized request:
  the exact failure this whole design exists to prevent.

`reserved` is the slack that absorbs the remaining error.

## 5. The cut point

### Between turns

Unchanged in kind: cut at a `user` message, now counting `tailTurns` turns rather
than `KEEP_TAIL` messages.

### Mid-turn

There is no `user` message after the turn began, so `tailStart()` cannot serve
here. **Corrected during Task 2** — the original text claimed it would return
"summarise everything, including the running instruction". Turn-counting made the
opposite true: with fewer `user` messages than `tailTurns`, `tailStart()` returns
`0`, meaning *keep everything*, so mid-turn it would compact nothing at all.

The conclusion is unchanged and the safer failure was chosen deliberately — a
`tailStart()` that over-keeps produces an empty `dropped` and a "nothing to
compact" report, while one that over-drops orphans a tool result. But mid-turn
still needs its own rule, because "compact nothing" is exactly as useless as
"compact everything" when the context is already full.

**The rule: cut at any index that is not a `tool` message.**

Cutting at a `tool` message leaves a tool result whose `tool-call` was dropped,
and providers reject that with an error that never mentions compaction. Cutting
at an `assistant` message that contains tool calls is safe, because their results
follow it and are kept.

### The tail is bounded by size, not only by count

**Amended after the whole-branch review.** The mid-turn tail first shipped as a
message count (`MID_TURN_KEEP = 6`) with no size bound at all, and that count
bounds nothing when a single message holds a 22 KB `read`. Measured end to end:
one 22 KB file read in a loop on a declared 8192-token window, stock defaults,
`steps: 20` — the context sent peaked at **19,407 tokens, 2.4× the window**, and
stayed there for the whole turn, plus roughly sixteen `smallModel` calls that
changed nothing. The kept tail was unreachable by both mechanisms: pruning is
skipped when the cut is `0`, and pruning only ever touched indices *below* the
cut.

Two changes, both of them:

1. **The tail has a byte budget: a quarter of the available budget** — the same
   fraction as `RESERVE_FRACTION`, leaving three quarters for the summary, the
   system prompt, and the next step's growth. The message count survives as an
   *upper* bound, so a small tail does not grow just because it is cheap, and at
   least one message is always kept, or the model has nothing to continue from.
   The backward walk to a non-`tool` index is applied after both bounds, so the
   structural invariant above is unchanged.

2. **Pruning may reach into the tail as a last resort** — after pruning outside
   the cut and after summarising, if the context is *still* over budget. This is
   safe for the same reason pruning is safe anywhere: it never removes a message,
   so nothing is orphaned, and the model can re-read the file. It runs last,
   after both cheaper mechanisms have been shown to be insufficient.

After both, the same measurement peaks at **7,780 tokens — under the window for
the whole turn — with one `smallModel` call instead of sixteen.**

### Amended again: the size of a single result

The two changes above closed the *step-count* axis and left the *result-size*
axis open. Measured on the same 8192-token window with full defaults: 22 KB
peaks at 7,752 with no overflow, 26 KB overflows on 11 of 30 steps, 28 KB on 29
of 30, and 30–32 KB peaks at 8,998 — 110% of the window.

The mechanism has two halves, and both come from comparing a **stale** number
against the budget:

1. When the large result first arrives, `lastStepTokens` is still the *previous*
   step's count and does not include it. The growth margin was supposed to cover
   this, but it is capped at a quarter of the budget — 1,536 tokens against a
   result of roughly 7,500 — so the trigger stays silent and the next request is
   already over the window.
2. Once the trigger does fire, the last-resort tail prune is gated on a
   "still over budget?" question that **credits** the bytes pruning freed while
   never **debiting** the result that just arrived. It answers "it fits", and the
   one remedy that could reach that result never runs.

Both are fixed by projecting the next request instead of reusing the last
measurement: `projected = lastStepTokens + arrivedTokens`, where `arrivedTokens`
is the size of the messages produced by the step that just finished. It is a
measured fact about messages already in hand, so unlike the growth margin it is
**not** capped — capping it would be pretending something that exists is smaller
than it is.

A third correction fell out of the same trace. The last-resort prune destroys
content the model just asked for, so its threshold is now the **context window
itself**, not the budget — deliberately skipping both the growth margin
(speculation may buy cheap remedies, not destructive ones) and `reserved`
(headroom for the answer, not a wall). Measured: a 22 KB read produces a tail of
about 6,300 tokens — above the 6,144 budget but below the window. Judged against
the budget it was discarded on every step and the model never saw the file it
had just read; judged against the window it arrives intact.

Finally, when the tail *alone* already fills the window, the tail is pruned
before the summariser is called rather than after: summarisation can only free
what lies before the cut, so if what lies after it already fills the window,
the call is knowably wasted.

After all four, no request exceeds the window at any result size: 22 KB peaks at
6,755 with the file delivered, 26 KB alternates 7,895 / 501 with the file
delivered every other step, and 28–32 KB — which cannot fit at all — is replaced
by the pruned marker, peaking at 501.

### Preserving the running instruction

The instruction that started the turn is passed to `compactPrompt()` as the
existing **`focus`** argument: *"pay particular attention to … keep that material
in full detail."*

This reuses a tested mechanism for exactly its stated purpose. The alternative —
keeping the instruction as a separate message next to the summary — would place
two consecutive `user` messages in the history, which Anthropic's API may reject.

## 6. Per-agent `steps`

`steps` becomes an optional field on `Agent`, with `MAX_STEPS = 20` as the
default. Sub-agents get it too: a reader agent needs five, a refactor agent
sixty, and one global number cannot be both.

### Reaching the limit must produce an answer

When the limit is reached, make one final call with tools disabled, so the model
**must** answer in text. This is what opencode's schema describes as *"before
forcing text-only response"*.

Without it, per-agent `steps` only moves where the silence happens. With it, the
misleading message at `src/core/agent.ts:406-410` stops firing for this cause,
and the user gets the model's own account of where it got to.

## 7. The `/compact` palette fix

Remove `"compact"` from `IMMEDIATE_COMMANDS` (`src/core/command.ts:69`).

`/compact {message}` already works and is already documented. The palette is the
only thing hiding it. The comment at `src/core/command.ts:57` already states the
rule — commands that take arguments are inserted, not run — and `compact` is the
sole entry breaking it.

## 8. Testing

Constraints carried from the project: no test may invoke a real provider or a
real external CLI; tests isolate `HOME` and the `XDG_*` variables; every task
ends green on `npm run typecheck && npm run build && npm test`.

**Pure functions, tested directly:** the threshold predicate, the mid-turn cut
point, `tailTurns` counting, the pruner, and `contextWindowFor`.

**The trigger, through `MockLanguageModelV4`** with per-step usage supplied by
the test. Specifically covering:

- `totalUsage` is **not** what drives the threshold — a multi-step turn whose
  summed usage exceeds the limit while its per-step context does not must **not**
  compact. This is the trap in section 3 and it needs a test that fails if
  someone reaches for the convenient field.
- The post-compaction reset — two consecutive checks must not both fire.
- An undeclared `contextWindow` never compacts, and warns.
- The saving estimate errs low: a pruning pass whose real saving would have been
  enough must still be allowed to summarise, and a test pins the direction of the
  error so a later "improvement" to the ratio cannot silently invert it.

**The load-bearing assertion:** that the context actually shrank, read from
`doStreamCalls[n].prompt` — not that a function was called. A test proving
`compact()` ran proves nothing about what the provider received.

**Structural invariants:** after any compaction, no `tool` message may appear
without its `tool-call`, and no message may be lost from disk.

Every fix is proven by mutation: undo the fix, confirm the right test fails.

**Every negative assertion must first prove a positive.** The repo has a
documented history of `assert.doesNotMatch` passing on an empty frame; the same
hazard applies to asserting a message is absent from a prompt that was never
built.

## Out of scope

- `temperature` / `top_p` per agent.
- A shipped table of known context windows.
- `preserveRecentTokens` — `tailTurns` states the same thing in a unit a person
  can picture, and two knobs for one quantity raise the question of which wins.
- Compaction for delegated sub-agents running an external CLI. Their context is
  the external tool's to manage; Titah only sends a task and receives an answer.

## Task order

The order is the risk control, not a convenience:

1. `contextWindow` in config + `contextWindowFor` + `doctor` reporting
2. `compaction` config block + `tailTurns` replacing `KEEP_TAIL`
3. The threshold predicate and the last-step token signal
4. The pruner + the conservative saving estimate
5. Between-turns trigger (flush is a no-op here)
6. Mid-turn cut point + `prepareStep` + the flush offset
7. **— the guard is standing —** `steps` per agent
8. Text-only response when the step limit is reached
9. `/compact` palette fix + README

Tasks 7 and 8 must not land before 6 is green.
