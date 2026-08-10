# Parallel sub-agents

**Date:** 2026-08-10
**Status:** approved, ready for planning

## Problem

Titah can call other agent editors, but only one at a time and only when the user
types the call. Everything else is a single loop: `config.agent` entries are
*modes* the user switches between with Tab, not workers that can be given a task.

The user maintains 13 named agents in opencode — `explore`, `senior-developer`,
`qc-developer`, `security-expert`, `devops-engineer` and others — each with its
own model, skills, and description. In opencode these are sub-agents: the primary
agent delegates to them, and a panel (`ctrl+x` then `↓`) shows what each is
working on. Titah has no equivalent.

The gap is not configuration. Titah's `Agent` schema already carries
`description`, `prompt`, `model`, `tools`, `skills`, and `permission` — nearly
identical to opencode's `AgentConfig`. What is missing is the ability to **run an
agent as a subordinate**, several at once, and see what they are doing.

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | The model may dispatch **internal** sub-agents on its own; `@claude`/`@opencode` stay user-triggered | Model may dispatch everything, as opencode does | Internal agents cost the user's own provider tokens; external ones spend a paid subscription. The cost boundary belongs where the money is |
| 2 | Write capability is declared per agent via `permission` | One global read-only or read-write rule | The user's roster genuinely splits: `explore` reads, `senior-developer` writes. A global rule makes one of those groups useless |
| 3 | Readers run concurrently without limit; writers are serialised on a per-working-directory lock | Refuse a second writer; or allow concurrent writes | The snapshot repo is keyed per directory, so that is where the real boundary lies. Refusing would make a self-dispatching model fail constantly; allowing would make `/undo` restore a blend of two agents' work |
| 4 | `/tim {message}` is a coordinator turn — the model splits the work itself | User names the roster; or a fixed pipeline | A separate orchestration engine would mean the `task` tool was designed wrong |
| 5 | Agents are declared in `titah.json` only — no discovery from opencode's config | Read opencode's `agent` block, as skills do | An agent carries `permission`: what it may do to the machine. Silently inheriting that from another tool's config is a different risk from inheriting a markdown skill |
| 6 | Each sub-agent runs as a **child session** in-process | Spawn `titah run` as a subprocess; or no session of its own | Per-session cancellation, per-session history, and session-scoped permission requests already exist. A subprocess would have to rebuild all three over IPC, and could not use the parent's permission dialog |
| 7 | Cancelling a sub-agent reports back to the coordinator instead of failing the turn | Cancel aborts the whole turn | Makes the button safe to press. The coordinator decides what to do about the loss |
| 8 | A sub-agent may use an external CLI as its engine (`delegate: "claude"`) | Internal agents only | From the coordinator's view both are the same: send a task, receive an answer |

**Decision 8 softens decision 1, deliberately.** If `reviewer` is backed by Claude
Code and the model may dispatch `reviewer`, the model can reach a paid
subscription indirectly. This is accepted because the user wrote that binding
into their own config — the declaration is the consent. It is different in kind
from the model choosing `@claude` on its own initiative.

## Configuration

Two new fields on `agent`; everything else already exists.

```jsonc
{
  "agent": {
    "explore": {
      "mode": "subagent",                                  // NEW
      "description": "Codebase explorer",
      "model": "9router/ant",
      "permission": { "edit": "deny", "write": "deny", "bash": "deny" },
      "skills": ["opencode:project-analyzer"]
    },
    "senior-developer": {
      "mode": "subagent",
      "model": "9router/ant",
      "permission": { "edit": "allow", "write": "allow", "bash": "ask" }
    },
    "reviewer": {
      "mode": "subagent",
      "delegate": "claude"                                 // NEW — engine is Claude Code
    },
    "build": { "mode": "primary" }                         // existing agents, unchanged
  }
}
```

**`mode` defaults to `"primary"`, not `"all"`.** This is a safety decision, not a
preference: the existing `build-auto` agent carries a permission block that
allows everything. Under a `"all"` default the model would suddenly own a
subordinate that never asks before writing, without the user typing a line.
Becoming a sub-agent must be stated.

**`delegate` and `model` are mutually exclusive.** One agent, one engine: either
Titah's own loop or one external CLI. Setting both is rejected at config load,
naming the agent.

**Write capability is read from `permission`, not `tools`.** This follows
opencode, which marks `tools` deprecated in favour of `permission`. `tools`
remains supported as an additional filter, but the scheduler looks only at
`permission.edit` / `permission.write` to classify an agent. An agent whose
`edit` and `write` are both `deny` is a **reader** and runs unthrottled;
everything else is a **writer** and queues.

`mode: "subagent"` and `mode: "all"` are both dispatchable; only `"primary"` is
refused. An agent with `"all"` is additionally selectable with Tab, exactly as
today.

Per-agent step limits (`maxSteps` in opencode) are deliberately omitted. Titah's
global `MAX_STEPS = 20` already bounds a runaway loop, and a second dial nobody
has asked for is more surface to keep correct.

## Architecture

### Child sessions

Each sub-agent runs as its own Titah session, linked to its parent by a new
`parent_id` column. Child sessions never appear in `/session` — the same
mechanism that already hides empty ones.

Three things the user asked for fall out of this for free:

- `running` is already a `Map<sessionID, AbortController>`, so cancelling one
  sub-agent without touching the others already works.
- Message history is already per-session, so the panel has a per-agent record
  with no new data structure.
- Permission requests already carry a `sessionID`, so the dialog can name the
  agent that is asking.

The honest cost of running in-process: sub-agents share the event loop with the
TUI. Their work is almost entirely waiting on the network and on subprocesses, so
the risk is small — but it is not zero, and a subprocess design would not have it.

### Parallelism comes from the model; scheduling comes from Titah

```
model emits several task() calls in one step
        ↓
   scheduler
   ├── readers → start immediately, no limit
   └── writers → queue on a per-working-directory lock
```

One new tool:

```
task(agent: "explore", instruction: "map the auth module")
```

The AI SDK already executes multiple tool calls from one step concurrently, so
parallelism appears on its own when the model decides to emit three `task` calls.
Titah does not need an orchestrator; it needs only to **hold back** the second
writer until the first finishes.

The lock is keyed on the **working directory**, not the session, because the
snapshot shadow repo is keyed per directory. That is the real boundary, not an
invented one.

### `/tim` needs almost no new machinery

`/tim {message}` is an ordinary turn with a system-prompt addendum: *"you have
the following sub-agents, split the work."* The coordinator is the model itself,
and `task` is the tool it splits with. The roster offered to it is every agent
whose `mode` allows dispatch; `/tim` takes no roster argument.

**`@` stays external-only.** `@claude` and `@opencode` reach external CLIs, as
today; internal sub-agents are reached through `task` or `/tim`, never through
`@explore`. Two syntaxes for one idea would mean explaining, in every error
message, which half of the system the user just addressed.

### Cancelling reports, it does not kill

Pressing `x` in the panel aborts that child session only. Its `task` call returns
as an ordinary tool result:

```
STOPPED BY USER after 48s. Files touched: src/auth.ts
```

The coordinator reads it like any other tool result and decides what to do —
retry with a different agent, continue without that piece, or ask the user. The
parent turn does not fail.

### What returns to the parent's context

Only the sub-agent's **final answer**, the same rule delegation already follows.
The full transcript stays in the child session. Without this bound, five
sub-agents can exhaust the parent's context window before it reaches a
conclusion.

### Permission and snapshots

The permission dialog now names the requester: **"qc-developer wants to write
src/auth.ts"**. Without the name the user is answering a question without knowing
who asked.

An "always allow" answer applies to the **whole parent turn**, not just the child
that asked. Otherwise five agents ask the same question five times and the user
stops reading the dialogs.

Each writer takes a snapshot before it starts, so the boundaries between changes
are recorded. Scope stated honestly: **`/undo` still restores the whole turn**,
not one sub-agent. The boundaries exist, so per-agent revert can be built later —
but it is not built now.

## The panel

`ctrl+x` then `↓`, matching the user's opencode muscle memory; `↓` is unused in
Titah's leader menu.

```
╭─ sub-agents ────────────────────────────╮
│ ◐ explore           12s  reading files  │
│ ◐ senior-developer  48s  writing auth.ts│
│ ∅ qc-developer      waiting for a turn  │
│ ✓ analyst           31s  done           │
╰─────────────────────────────────────────╯
  ↑↓ select · x stop · esc close
```

The `∅` row matters: it explains **why** something has not started. Without it, a
queued writer looks stuck.

The panel shows **one activity line** per agent, not a full transcript. The data
lives in the child session and a transcript view can be added later; it is not
built now.

## Error handling

| Condition | Behaviour |
|---|---|
| Sub-agent fails | `task` returns its error text; the coordinator decides — same shape as a cancellation |
| Unknown agent name in `task()` | Error result **naming the available sub-agents** |
| Agent with `mode: "primary"` dispatched | Refused; it was never meant to be a subordinate |
| `delegate` names an external agent that does not exist | Config load error naming the agent |
| `delegate` and `model` both set | Config load error |
| Parent turn cancelled | All children aborted, the writer queue discarded |

**One guard is mandatory: a sub-agent does not get the `task` tool.** Without it
a sub-agent can dispatch further sub-agents, and so on — a tree that widens
without bound, burning the user's provider tokens with no single place to stop
it. Depth is exactly one level, and that is tested.

## Testing

**Pure unit — the scheduler, driven by hand-made promises, no model at all:**
- Three readers dispatched → all three start before any finishes
- Two writers → the second does not start until the first completes
- A reader is never held back by a running writer

**Unit — config:**
- `mode: "primary"` is refused as a sub-agent
- `delegate` and `model` together are refused
- An agent with no `mode` cannot be dispatched — the safe default is proven, not assumed

**Integration with a stub model:**
- A model emitting two `task()` calls in one step creates two child sessions
- A sub-agent's tool list does not contain `task` — the depth guard
- Cancelling one child makes its `task` return `STOPPED BY USER`, and the parent
  turn keeps running
- Child sessions do not appear in `/session`

**The repository's existing hard rules still apply:** no test invokes a real
external agent or a real provider, and none reads the real `~/.claude` or
`~/.config/opencode`. Sub-agents with `delegate` are tested against the existing
`test/fixtures/stub-agent.js`.

## Out of scope

- Per-sub-agent `/undo`. The snapshot boundaries are recorded so it remains
  possible later.
- A full transcript screen in the panel.
- Discovering agents from opencode's config (decision 5).
- Nesting deeper than one level (forbidden by the depth guard, not merely unbuilt).
- Per-agent step limits.
