# Titah

A coding agent CLI that can **call other agent editors** to get answers.

Titah is a coding agent in its own right — it has its own LLM loop, tool set,
and session management. What sets it apart: it can delegate a question to
`claude`, `opencode`, or any other agent CLI installed on your machine, and
bring the answer back into the conversation. Including **consensus mode**: one
question fanned out to several agents at once, synthesised, with the
disagreements marked.

> **Status: 0.1.0, usable.** All milestones M0–M6 are done. What remains before
> tagging `v1.0.0` is not code: using Titah to build Titah for a full week.
> See [DESIGN.md](./DESIGN.md) and [CHANGELOG.md](./CHANGELOG.md).

## About the external agents

Titah **does not redistribute, bundle, or bypass** Claude Code, opencode, or any
other agent. It only spawns the CLI **you** installed, with **your own**
credentials, as an ordinary subprocess — exactly as if you had typed it in your
terminal. If an agent is not installed, Titah reports it as unavailable and
keeps working fully without it.

## Requirements

- Node.js ≥ 22.6 (developed on v26)
- Linux or macOS (Windows is not supported in v1 — see DESIGN.md §2)

## Getting started

```bash
npx titah init      # detect a provider, write the config
npx titah           # open the TUI
```

`titah init` looks for keys in the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`), then probes local endpoints such as
Ollama and LM Studio — and only asks about what it genuinely cannot work out on
its own. Pass `-y` to take the first thing it finds without a dialog, which
suits scripts and Dockerfiles.

From source:

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js            # open the TUI
```

> **The TUI requires a build.** Node runs `.ts` directly but not `.tsx` — JSX is
> not stripped. Headless commands (`run`, `serve`, `doctor`, …) still run from
> source with `node src/cli.ts`; the TUI only runs from `dist/`.

`titah doctor` checks your environment, config, credentials, and which external
agents were detected. Add `--probe` to also test network reachability per
provider.

## Configuration

Global config lives at `~/.config/titah/titah.json`, merged with the project's
`./titah.json`. The format is JSONC — comments and trailing commas are fine.
Point `$schema` at `config.schema.json` for editor autocomplete.

```jsonc
{
  "$schema": "./node_modules/titah/config.schema.json",
  "model": "ollama/qwen3.5:27b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen3.5:27b": { "name": "Qwen3.5 27B" } }
    }
  }
}
```

Any provider that speaks OpenAI-compatible is a first-class citizen —
self-hosted endpoints, routers, Ollama, LM Studio. Anthropic is available
through `"npm": "@ai-sdk/anthropic"`.

### Credentials

Do not put API keys in the config as plaintext. There are two paths:

```bash
# 1. a separate auth.json, automatically mode 0600
titah auth set 9router      # the key is read from stdin

# 2. an environment variable, referenced from the config
#    "apiKey": "${env:VAR_NAME}"
```

Resolution order: `provider.options.apiKey` in the config → `auth.json` → a
conventional environment variable (`ANTHROPIC_API_KEY`, or
`TITAH_<PROVIDER>_API_KEY`).

An unset `${env:...}` does **not** fail config loading — the key is dropped and
recorded, and only complained about if the model you actually use needs it. A
config may name five providers while you use only one.

## Commands

| Command | Purpose |
|---|---|
| `titah init [-y]` | First-time setup (auto-detect + wizard) |
| `titah` | Open the interactive TUI (spawns a local server) |
| `titah attach <url>` | Open the TUI against a running server |
| `titah run "<prompt>"` | Run one turn and stream the answer |
| `titah undo` | Revert every change from the last turn |
| `titah serve [--port N]` | Headless HTTP + SSE server |
| `titah sessions list [--all]` | Sessions for this folder; `--all` for every project |
| `titah sessions prune --older-than 30d` | Delete old sessions plus orphaned blobs and snapshots |
| `titah config path` \| `show` | File locations / merged config (redacted) |
| `titah auth list` \| `set <p>` \| `remove <p>` | Manage credentials in `auth.json` (0600) |
| `titah models` | List configured models |
| `titah doctor [--probe]` | Check environment, config, external agents |

Frequently used options: `-m/--model <provider/model>`, `-a/--agent <name>`,
`-s/--session <id>`, `--auto`.

> `titah run` runs the core **in process**, not over HTTP. It uses the exact
> same agent loop and storage, just skipping the network layer. `titah` (the
> TUI) spawns a server and attaches to it.

## The TUI

`titah` with no arguments spawns a local server on a random port and attaches
the TUI to it. It feels like a single process, but the architecture has been
client/server from the start — which is why `titah attach http://host:4096`
works with no extra code.

It takes over the **alternate screen buffer**, the way nvim does: whatever was
in your terminal stays hidden while Titah runs and is restored intact on exit.

The opening screen centres the prompt beneath the ASCII logo. After your first
prompt the layout switches to an info panel on top, history in the middle, and
the prompt pinned to the bottom, with a spinner above it while work runs.

### Markdown

Assistant answers are rendered as markdown: headings, bold, italics, inline
code, fenced code blocks, lists, quotes, and rules.

```
Hasil
• Item satu
• Item dua
┌ ts
  const a = 1
└
```

Two deliberate choices:

- **Your own prompts are never rendered.** What you typed is not markdown, and
  rendering it would hide characters you meant to write — for instance when
  asking about markdown syntax itself.
- **Underscores are never emphasis.** Coding-agent answers are full of
  `snake_case_name` and `__init__`; treating `_` as emphasis turns identifiers
  into wrong-looking italics. `*italic*` and `**bold**` still work.

Code blocks are not parsed as markdown either — `*` and `_` inside code are
code, not emphasis.

The header panel carries the Titah mark beside the session information. On short
terminals (under 26 rows) the mark is dropped — conversation history is worth
more than decoration when space is scarce.

### Command palette

`Ctrl+P` opens the palette without typing anything — the same key as opencode:

```
│ Commands · 10 · ↑↓ move · tab/enter select · esc close │
│ › /model  Switch the model for this session            │
│   /agent  Switch the agent for this session            │
│   /skill  Insert a skill into your prompt              │
│   /consensus  Fan one question out to every agent      │
```

Commands that need no arguments **run immediately** when you select them, and
those with sub-options drill into a second menu. Picking `/model` opens the list
of models from your config; picking one switches the model for this session
right away:

```
│ Switch model · 6 · ↑↓ move · tab/enter select · esc close │
│ › 9router/ocode  nemotron-3-ultra (via ocode)             │
│   9router/gapis  gemini-3-flash (via gapis)               │
│   ollama/qwen3.5:27b  Qwen3.5 27B                         │
```

Commands that take arguments (`/consensus`, your own custom commands) are
inserted into the prompt instead, so you can type the argument.

`/session` lists your saved sessions newest first, with the current one marked.

**Sessions belong to the folder you opened Titah in.** A conversation is nearly
always tied to the code being worked on, so a list mixing every project on the
machine buries the one you actually want. `titah sessions list` follows the same
rule; pass `--all` to see every project, which also prints each session's path.

The match is on the **exact** directory, so `~/proj` and `~/proj/src` are separate
projects. Paths are normalised first, so a trailing slash or a relative path finds
the same sessions — losing your history to a stray `/` would be indefensible.
Picking one loads its history and points the stream at it; `/new` starts a fresh
session in the same directory. Both clear whatever you had half-typed — carrying
a draft into a different conversation is never what you meant.

### Popups while typing

| Trigger | Shows |
|---|---|
| `@` | External agents, internal agents, and files in the working directory |
| `/` | Every command, built-in and custom |

`↑↓` moves, `Tab` or `Enter` selects, `Esc` closes. Triggers only fire at the
start of a word, so `akil@gmail.com` and `/etc/hosts` never open a popup nobody
asked for.

### Keys

Keybindings follow **opencode's defaults**, with `ctrl+x` as the leader:

| Key | Action |
|---|---|
| `Enter` | Send the prompt |
| `Ctrl+J` | Newline inside the prompt |
| `Esc` | **Cancel the running turn** |
| `Ctrl+P` | Open the command palette |
| `↑` / `↓` | Recall the previous / next prompt (moves the cursor first on a multi-line draft) |
| `Shift+↑` / `Shift+↓` | Scroll the history one line |
| `Tab` | Switch agent (or select inside a popup) |
| `Ctrl+X` `D` | Expand/collapse every tool block — works mid-turn, and a running tool shows its arguments |
| `End` / `Ctrl+X` `B` | Jump to the newest message |
| `Ctrl+X` `M` | Toggle mouse capture — turn it **off** to select and copy text |
| `Ctrl+X` `↓` | Toggle the sub-agent panel — it owns the keyboard while open: `↑`/`↓` select, `x` `x` cancels the selected sub-agent, `Esc` closes |
| Click a tool line | Expand/collapse just that block |
| Mouse wheel | Scroll the history |
| `Ctrl+X` `U` | Undo the last turn's changes |
| `Ctrl+X` `?` | Short help |
| `Ctrl+X` `Q` / `Ctrl+C` | Quit (`Ctrl+C` clears the input first if it has content) |
| `Ctrl+Alt+U` / `Ctrl+Alt+D` | Scroll half a page |
| `PageUp` / `PageDown` | Scroll a page |
| `Ctrl+G` / `End` | Jump to start / end |
| `y` / `a` / `n` | Answer a permission dialog: once / always / deny |

**Selecting text to copy.** While Titah tracks the mouse, the terminal stops
using clicks to highlight text — the two cannot both be on. `Ctrl+X` `M` turns
tracking off so normal selection works, and the footer keeps saying `✂ mouse off`
until you turn it back on. Most terminals also let you hold `Shift` while
dragging to bypass tracking without toggling anything.

All of it is configurable through `keybinds`; `"none"` disables an action.

```jsonc
{ "keybinds": { "session_interrupt": "ctrl+g", "tool_details": "none" } }
```

Two honest notes about "1:1 with opencode":

- opencode defines **184 actions**; Titah implements the subset that matters
  here, with identical keys.
- `tool_details` is left **unbound** by opencode. Titah binds it to `Ctrl+X D`,
  because a collapsible tool block with no key to collapse it is a feature
  nobody can find.

`input_newline` in opencode is `shift+return,ctrl+return,alt+return,ctrl+j`.
Most terminals cannot tell `Shift+Enter` from `Enter`, so the one that actually
works is **`Ctrl+J`**.

## HTTP API

`titah serve` exposes a server that holds the entire core. The TUI is just one
of its clients — and `curl` is another, which is what makes the core testable
without a TUI at all.

| Route | Purpose |
|---|---|
| `GET /health` | Status, version, pid |
| `GET /event?session=<id>` | SSE stream of all events (optional per-session filter) |
| `POST /session` | Create a session (`{"directory": "..."}`) |
| `GET /session` | List sessions |
| `GET /session/:id/message` | Message history |
| `POST /session/:id/message` | Send a prompt (`{"text": "...", "auto": false}`) |
| `POST /session/:id/abort` | Cancel the running turn |
| `GET /session/:id/permission` | Pending permission requests |
| `POST /session/:id/permission/:permID` | Answer (`{"decision": "once"\|"always"\|"reject"}`) |
| `POST /session/:id/undo` | Revert the last turn's changes |

Send `Accept: text/event-stream` on `POST .../message` to receive the answer as
a stream:

```bash
SID=$(curl -s -X POST localhost:4096/session -d "{\"directory\":\"$PWD\"}" | jq -r .id)
curl -N -X POST "localhost:4096/session/$SID/message" \
  -H 'accept: text/event-stream' \
  -d '{"text":"How many .ts files are in src/? Use glob."}'
```

Events follow a hybrid model: `text.delta` per token for assistant text, and
`message.updated` carrying a **whole-message snapshot** for every tool state
change. A client that renders tool status must track what it has already shown —
snapshots resend every part each time.

## Tools

| Tool | Purpose | Permission |
|---|---|---|
| `read` | Read a text file with line numbers, supports `offset`/`limit` | — |
| `list` | Recursive directory listing, skipping `node_modules`/`.git`/`dist`/… | — |
| `glob` | Find files by pattern, newest first | — |
| `grep` | Search contents by regex, results as `file:line: text` | — |
| `edit` | Exact text replace; must be unique; **fails hard** on no match | yes |
| `write` | Write full file contents, creating parent directories | yes |
| `bash` | Run a shell command with a timeout | yes |

All filesystem access is confined to the session working directory — paths that
escape it are refused. Tool output larger than 32 KB is written to
`~/.local/share/titah/tool-output/`, and only the head plus a pointer enters the
context.

`edit` fails hard on purpose: if `oldString` is missing or appears more than
once, the tool refuses and **writes nothing**. Refusing is far better than
silently writing in the wrong place.

## Permissions & undo

Every tool that changes something goes through the permission engine. Checks, in
order:

1. `permission.<tool>` from the active agent, then from the config — `"deny"`
   refuses, `"allow"` skips the dialog
2. `permission.allowlist` from the config, then the session allowlist built from
   "always" answers — except for a dialog raised by a **sub-agent**, whose
   "always" is scoped to the coordinator's turn instead (see
   [Sub-agents](#sub-agents))
3. `--auto` mode
4. **no client connected → auto-denied**
5. only then is the dialog shown

Point 4 is non-negotiable. Hanging while waiting for an answer would freeze the
agent in CI; auto-allowing would turn headless mode into a silent security hole.
For automation the path is `--auto` or an explicit allowlist.

```jsonc
{
  "permission": {
    "edit": "ask",
    "write": "ask",
    "bash": "ask",
    "allowlist": ["git *", "npm test"]
  }
}
```

Before the **first** change of every turn, Titah takes a snapshot into a
**shadow** git repo under `~/.local/share/titah/snapshot/` — a separate git dir
whose work tree points at your project. Your own `.git` is never touched: no
stray commits, no disturbed staging area, no surprise stashes.

```bash
titah undo            # revert the entire last turn
titah undo -s <id>    # for a specific session
```

One snapshot per turn means one `undo` reverts the whole turn, not a single
tool. Files the agent **created** are deleted too — a half undo that leaves new
files behind is not an undo.

## Modes: Plan, Build Manual, Build Auto

Titah ships three built-in modes. `Tab` switches between them (the same key as
opencode), or `-a/--agent` from the CLI.

| Mode | Id | Behaviour |
|---|---|---|
| **Plan** | `plan` | Drafts a plan only. Every attempt to change a file or run a command is **refused** |
| **Build Manual** | `build` | Does the work, but **every** change asks for your confirmation. **The default** |
| **Build Auto** | `build-auto` | Works to completion on its own, **no** confirmations |

```bash
titah -a plan            # open the TUI straight into planning mode
titah run -a build-auto "fix the failing tests"
```

Change the default with `"defaultAgent": "plan"` in the config.

Plan mode locks changes through **permissions**, not by removing the tools. The
difference is visible: the model can still try, is refused with a clear reason,
and passes that on to you —

```
⊘ create result.txt (1 lines) — Denied by agent "plan": write = "deny".
Refused — plan mode cannot change files. Switch to Build mode
(Tab in the TUI, or --agent build) to use write.
```

When the tools were removed entirely, the model instead stopped without a single
word. The safety is identical — permission is checked before execution, so
nothing ever runs.

Build Auto still takes **snapshots**, so `titah undo` still reverts the whole
turn even though you were not watching it happen.

## Custom agents

The three modes above are ordinary agents — you can override them by id, or add
your own. An agent is a **prompt + tool filter + permission override + model
override** behind a name. `mode` and `delegate` give it a second role — being
dispatched as a sub-agent by the coordinator's own model — covered next.

```jsonc
{
  "defaultAgent": "explore",
  "agent": {
    "explore": {
      "description": "Codebase explorer — read only",
      "prompt": "Always verify with tools, never guess. Answer very briefly.",
      "tools": { "write": false, "edit": false, "bash": false }
    },
    "qc": {
      "description": "Run tests and report",
      "model": "9router/gapis",
      "permission": { "bash": "allow", "edit": "ask" },
      "skills": ["team:project-analyzer"]
    }
  }
}
```

Two ways to restrict an agent, both applied before anything runs:

- **`tools`** removes a tool from the list the model can see. Tools not listed
  stay enabled — the list is an exception list, not an allowlist.
- **`permission`** leaves the tool visible but refuses its use, overriding the
  global `permission`. Fields not mentioned inherit the global value.

Use `permission` when you want the model to know why it was refused; use `tools`
when you do not want it thinking about the tool at all.

`steps` caps how many tool-calling iterations one turn may take for this agent —
five for a scout, sixty for a refactor. The default is 20. When the cap is
reached, the final iteration runs with no tools at all, so the model has to
report what it found rather than stopping mid-air.

**`skills`** loads those skills into this agent's system prompt in full, and
takes fully-qualified ids (`namespace:name`), exactly like `skills.always` —
see [Skills](#skills). A bare name such as `"project-analyzer"` never resolves;
run `/skills` or `titah doctor` to see the ids you have and which configured
ids were not found.

## Sub-agents

Titah's own model can run several of its own configured agents as sub-agents,
in parallel, inside one turn — without leaving the process or spawning an
external CLI.

```jsonc
{
  "agent": {
    "explore": {
      "mode": "subagent",
      "description": "Codebase explorer — read only",
      "permission": { "edit": "deny", "write": "deny", "bash": "deny" }
    },
    "qc-developer": {
      "mode": "all",
      "permission": { "bash": "allow" }
    }
  }
}
```

`mode` decides whether the coordinator's own model may hand an agent work:
only `"subagent"` and `"all"` are ever offered to the `task` tool; a
`"primary"` agent is refused outright if something tries to dispatch it
anyway. The default is `"primary"`, **not** `"all"` — flipping that default
would have quietly handed every agent already in your config, including ones
with a wide-open `permission`, to the model the moment this feature shipped,
without you writing a single line asking for it. `mode` does not otherwise
change an agent: it is still selectable as your own top-level agent with `Tab`
or `--agent`, exactly as before sub-agents existed.

`delegate` routes a sub-agent through an external CLI listed in
`externalAgent` (see [Delegation](#delegation)) instead of Titah's own loop —
the same engine `@claude` uses, reached from `task`/`/tim` instead of a
mention. It is **mutually exclusive with `model`**: an agent has one engine,
and config setting both is rejected when it loads.

**`permission` does nothing to a delegating agent.** The external CLI runs
under its own policy and never asks Titah for anything, so Titah's `edit` /
`write` / `bash` settings are not applied to it, and no permission dialog will
appear on its behalf. Because Titah cannot know what that CLI will touch, a
delegating agent is **always treated as a writer** — see below — no matter what
its `permission` block says. If you want to restrain it, restrain it in that
CLI's own configuration.

### Readers run together, writers take turns

Whether a sub-agent may run *at the same time* as others is read from its
`permission`, never from `tools`: an agent counts as a reader only when
`edit`, `write`, **and** `bash` are all explicitly `"deny"`, and it does not
`delegate`. Everything else — an agent whose config never mentions
`permission` at all, and every agent with `delegate` set, whatever its
permission block says — is treated as a writer. `bash` counts as writing on purpose: an allowed shell can
run `sed -i` just as well as the `edit` tool can, and treating it as read-only
would open exactly the hole this rule exists to close.

Readers run with no limit on how many are concurrent. Writers are serialised
on a queue keyed by working directory, so two sub-agents editing the same
project never race over the same shadow-git snapshot — one waits its turn
while the panel below shows it "waiting for a turn". This is why `/tim` tells
the model not to order writers itself: Titah already does.

### `task` and `/tim`

The coordinator hands work to a sub-agent with the `task` tool; several calls
in the same step run concurrently. The prompt asks the model for one call per
agent, but nothing enforces it: the same agent named twice in one step is two
sub-agents, and if it can write, the second waits for the first on the write
lock below. `/tim <task>` is not a
separate orchestration engine — it is an **ordinary turn**, with one extra
system-prompt section listing the current dispatchable roster and instructing
the model to split the work and dispatch it with `task`, doing any leftover
work itself rather than inventing an agent for it. The model does the actual
coordinating; Titah only tells it who is on the roster.

Running `/tim` with no dispatchable agent configured does not hang or guess —
it answers directly with what to add: an `agent` block with `"mode":
"subagent"` (or `"all"`) in `titah.json`.

A sub-agent never gets the `task` tool itself, no matter its own `mode` —
dispatch depth is capped at exactly one level, so nothing can spawn a tree of
sub-agents that burns through your provider quota with no way to stop it.

### A sub-agent is not bound by the coordinator's mode

A dispatched sub-agent's tool calls are checked against **its own**
`permission`, resolved by the same rules, in the same order, as your top-level
agent (see [Permissions & undo](#permissions--undo)) — never against the
coordinator's. One rule differs, deliberately, and in both directions:

> **"Always" from a sub-agent lasts the turn, not the session.** Answering `a`
> to a dialog raised by a sub-agent adds the pattern to an allowlist that is
> discarded when the coordinator's turn ends — unlike the same answer at
> top level, which lasts the whole session. And for that turn it covers
> **every** sub-agent, not only the one that asked: five agents doing the same
> job would otherwise ask the same question five times, and dialogs that
> repeat are dialogs that stop being read.

This includes **Plan mode**: Plan's own turn refuses every change, but the
`task` tool itself carries no permission check of its own, so a Plan-mode
coordinator can still call it, and the sub-agent it dispatches runs under
whatever `permission` *that agent's own config* gives it. With the
`qc-developer` example above (`"bash": "allow"`), typing `/tim …` while in
Plan mode gets its shell command run with **no confirmation**, even though
Plan mode's own description says every command is refused. This is not
something `/tim` added — it follows from how `task` was designed, with no
gate of its own — but it means Plan mode is not a boundary sub-agents respect.

### Watching them work

`Ctrl+X` then `↓` **toggles** a panel listing every sub-agent of the **current
turn**, with each row's status (queued, running, done, failed, stopped). Rows
that have started show a running clock; a queued row shows none, on purpose —
a clock on something that has not begun reads exactly like something stuck.

The list is cleared when you send your next message, so it is always about the
work in front of you. It lives in the TUI's memory, not in the session: quit
and come back, or switch away with `/session` and back, and the panel starts
empty even though the sub-agents' own child sessions are still on disk.

While the panel is open it **owns the keyboard** — `↑` / `↓` select a row,
`Esc` closes it, and everything else is swallowed rather than typed into your
prompt behind it. `Ctrl+X` chords, `Ctrl+C`, and `Ctrl+D` still reach through —
the last one quits, same as everywhere else in the TUI.

`x` cancels the selected sub-agent, and asks first: the first press arms that
row and says so in the panel's title, a second `x` on the same row does it,
and any other key — including moving the selection — disarms it. Stopping
cannot be undone, so a single keystroke is not allowed to do it.

A cancelled sub-agent **reports** rather than fails. Its `task` call returns
`STOPPED BY USER after 48s.` as an ordinary tool result, the coordinator reads
it like any other result and carries on with the rest of the team, and the
history line is marked `⊘`, not `✓`. This holds for both engines: a sub-agent
running an external CLI has that CLI killed, exactly as an internal one has
its turn stopped.

### `/undo` can revert more than the `/tim` turn — read this before relying on it

Sub-agents change nothing about the *mechanism* of `/undo`: it still reverts
to the last assistant message, in the given session, that actually took a
snapshot — never a single tool call in isolation (see
[Permissions & undo](#permissions--undo)). The part that changes is which
message that turns out to be. A sub-agent's own writes take their snapshot on
the **sub-agent's own (child) session**, not on the coordinator's turn — so if
a `/tim` turn's coordinator dispatches work and writes nothing itself, its own
turn has no snapshot at all. `/undo` does not stop there: it walks the
session's messages for the most recent one that *does* have a snapshot, which
skips straight past the empty `/tim` turn to whatever the coordinator last
wrote **in an earlier turn** — reverting that older turn as well, silently,
in the same `undo`.

Concretely: edit a file in Build mode, then run `/tim …` where only sub-agents
write a dozen new files, then press `Ctrl+X` `U`. It does not report "nothing
to undo." It reverts the Build-mode edit **and** deletes all twelve files the
sub-agents just created — files created after a snapshot are removed, same as
any other undo — and reports it as one ordinary "undo: N files restored."
There is no way to undo just one sub-agent's slice of a `/tim` run, and no way
to undo a `/tim` turn in isolation if its own coordinator wrote nothing: you
either revert back to the coordinator's last real write, however far back
that is, or there is nothing to revert at all.

`Ctrl+X` `U` and a bare `titah undo` never reach into a sub-agent's session
directly — they operate on the session you're in (`Ctrl+X` `U`) or, for a bare
`titah undo`, on the most recently updated top-level session in the current
directory (`titah undo -s <id>` targets a specific one; a child session is
never picked automatically).

## Custom commands

```jsonc
{
  "command": {
    "review": {
      "template": "Review the code in {{.Input}} and suggest improvements",
      "description": "Quick code review",
      "agent": "explore"
    }
  }
}
```

Call it with `/review src/core/agent.ts`. The `{{.Input}}` placeholder follows
opencode; Claude Code's `$ARGUMENTS` is accepted too.

Built-in commands — `/consensus`, `/tim`, `/compact`, `/model`, `/skill`,
`/agents`, `/skills`, `/commands` — cannot be overridden, because they change
the execution flow rather than merely expanding a prompt.

### Context management

Titah compacts automatically once the context approaches the model's window, and
`/compact` runs the same thing on demand.

```
/compact                        # summarise everything but the last turns
/compact the database schema    # same, but keep that material in full detail
```

This is about correctness, not tidiness. When history exceeds the window,
providers do not reject the request — they **truncate the oldest part**, and the
model then answers confidently about decisions it can no longer see. ollama
truncates at `num_ctx` (4096 by default) without a single warning.

Automatic compaction needs to know how large the model's window is, and nothing
is guessed. Declare it per model:

```jsonc
"provider": { "ollama": { "models": { "qwen3:14b": { "contextWindow": 32768 } } } }
```

Without it, automatic compaction is off for that model — `titah doctor` lists
every model missing one, and the TUI says so once per session, quietly. That
notice is information, not a failure: the turn runs normally. `/compact` still
works either way.

Tuning, with the defaults shown:

```jsonc
"compaction": {
  "auto": true,        // turn the whole thing off with false
  "reserved": 8192,    // tokens held back for the next answer and the summary itself
  "tailTurns": 2,      // recent turns kept verbatim, never summarised
  "prune": true        // drop old tool output first — free, and usually enough
}
```

`reserved` is a headroom, not a hard token count. It covers **two** things, both
of which are absolute rather than proportional to the conversation: the next
response, and the summarisation call itself. It does **not** cover the growth of
the next step — one more tool result. That is budgeted separately and
automatically, from the largest tool result seen so far in the running turn, and
it is forgotten as soon as the turn ends. The trigger is therefore

```
contextWindow - reserved - (largest tool result this turn)
```

with both subtractions capped at a quarter of the window each. Without the cap on
`reserved`, the 8192 default would equal the whole window on a common 8k local
model, push the threshold to zero, and fire compaction on every single turn
regardless of how little context was actually in use. The cap on the growth
margin exists for the mirror-image reason: a single result larger than a quarter
of the budget will not fit after any compaction, so reserving room for it would
move the overflow rather than prevent it. `titah doctor` reports every model
where the `reserved` cap is biting, and the value actually in effect for it.

What it does, precisely:

- Only what is **sent to the model** shrinks. The transcript on screen and in
  SQLite is untouched — scroll up and the real conversation is still there.
- The last few turns (`tailTurns`) are kept **verbatim**, so the reply right
  after compacting does not lose the detail you just typed.
- The cut always lands on a user message. Cutting between a tool call and its
  result would leave an orphaned result that providers reject.
- Compacting again re-summarises the previous summary rather than stacking a new
  one on top, so the summary cannot grow without bound.
- When the context fills up, old tool output is dropped first (`prune`),
  because it is the bulk of an agentic turn and costs nothing to discard — the
  model can re-read a file. Only if that is not enough is a summary written.
- This happens **mid-turn** too, not just between turns. One long turn reading
  thirty files is the case that overflows most often, and there is no user
  message in the middle of it where a between-turns check could fire.
- Mid-turn, the recent messages kept verbatim are bounded by **size**, not only
  by how many there are: at most a quarter of the available budget, and at least
  one message whatever its size. Counting messages alone bounds nothing when one
  `read` of a 22 KB file *is* a message — measured, that single case sent 2.4×
  the window for an entire turn.
- If pruning outside the kept tail and summarising are both still not enough, old
  tool output **inside** the tail is pruned too, as a last resort. Pruning never
  removes a message, so nothing is orphaned; the model can re-read the file.
  That last resort is measured against the **window itself**, not the threshold:
  `reserved` is headroom for the answer, not a wall, and a result that still
  fits is delivered rather than thrown away. A 22 KB file on an 8k window
  reaches the model; a 30 KB one cannot and is replaced by a marker saying so.
- The trigger counts what has **already arrived**. A tool result that landed
  after the last measurement is part of the next request whether or not the
  provider has counted it yet, so it is added before comparing against the
  threshold. Without that, a single result larger than the growth margin slipped
  in unnoticed and the next request was already over the window — measured at
  110% of an 8k window with a 30 KB read.
- "Was pruning enough?" is answered by **measuring the request that is about to
  be sent** — the messages plus the system prompt — not by subtracting an
  estimate from a number the provider reported for a different request one step
  ago. That arithmetic could not be right, and it was wrong in the direction that
  costs money: measured, at a 28 KB result on an 8k window the request that would
  actually go out was 490 tokens — 6% of the window — while the summariser fired
  on 29 of 30 steps. One ruler now answers both this and "will it fit".
- Sub-agent results are **exempt** from ordinary pruning. The marker tells the
  model to re-run the tool, which is right for `read` and wrong for `task`:
  recovering a sub-agent's answer costs another full nested turn. Summarisation
  handles them instead — lossy, but not destructive. In the last-resort tail
  prune nothing is exempt, because a silently truncated request is worse still,
  but there the marker says what was lost and what it costs to get back.
- The summariser's own prompt is bounded too, by the window of the model that
  writes it. A transcript larger than that window is summarised in **chunks** —
  each chunk small enough to fit, then the chunk summaries summarised in turn.
  Without this the prompt was unbounded: measured at 78,964 tokens against a
  `smallModel` declaring 4,096 — 19.3× — and providers do not reject that, they
  truncate it. `titah doctor` names a `smallModel` with no declared
  `contextWindow`, because the bound cannot be enforced without one.
- If any chunk comes back empty — a provider error, or `Esc` — the whole
  summarisation is abandoned and nothing is saved. A summary missing one chunk,
  stored as though complete, is exactly the failure this feature exists to
  prevent.
- A failed compaction — a broken `smallModel`, a provider error — never fails
  the turn. That step's compaction is simply skipped and the turn continues
  with whatever context it already had.
- The summary is written by `smallModel` when one is configured, falling back to
  the turn's model. `/compact` makes the same choice, so a session's automatic
  and manual summaries are never written by two different models.
- Compaction is cancellable. Because it now runs unbidden, `Esc` reaches the
  summariser itself — a `smallModel` that hangs ends the turn instead of holding
  the session open.

The summariser is instructed, above everything else, never to invent: identifiers
are copied verbatim, and anything it cannot confirm is recorded as unresolved. A
summary that drifts is worse than no summary, because it reads as an agreed
record that the model has no way to check.

A command name must be followed by whitespace or end of line, so pasting an
absolute path like `/home/user/notes.md` into a prompt is never misread as a
command.

## Skills

A skill is a markdown file with frontmatter, loaded into context when used.
Two layouts are recognised: `<dir>/<name>/SKILL.md` (superpowers/Claude Code
style) and `<dir>/<name>.md`. `name` and `description` are read from the
frontmatter.

### Config

```jsonc
{
  "skills": {
    "discover": ["claude", "opencode"],       // read installed registries automatically
    "paths": ["~/.config/opencode/skills", { "path": "./.titah/skills", "as": "team" }],
    "always": ["superpowers:using-superpowers"] // loaded in full every turn, not just catalogued
  }
}
```

- `discover` reads the Claude Code (`~/.claude`) and opencode
  (`~/.config/opencode`) skill/plugin registries so anything already installed
  there works with zero configuration. Set it to `[]` in tests or in any setup
  that must not touch those directories.
- `paths` adds explicit directories, either as a bare string or as `{ path,
  as }` to override the namespace that directory would otherwise get.
- `always` names skill ids that are loaded in full on every turn, rather than
  only appearing one line each in the catalogue. An agent's own `skills: [...]`
  is the per-agent counterpart and takes the same fully-qualified ids.

### Ids and namespaces

A skill's id is always fully qualified as `namespace:name` — the bare name
alone is never accepted, since two different sources can otherwise define the
same name. The namespace comes from, in order:

1. the plugin manifest's `name` (`.claude-plugin/plugin.json`), if one exists
   for that directory or its parent;
2. otherwise the skill directory's own folder name;
3. except when that folder is literally called `skills`, which tells you
   nothing on its own — in that case the *parent* directory's name is used
   instead. This is what turns `~/.config/opencode/skills` into the `opencode`
   namespace rather than `skills`.

### Invoking a skill

Type `/plugin:skill <message>` to run one directly, e.g.
`/superpowers:brainstorming a new caching layer`. The transcript shows the
command you typed, not the skill's full body — the model receives the skill's
instructions followed by your message.

The model can also load a skill on its own, without being asked, via the
`skill` tool: it passes a fully qualified id (as seen in the `/skills`
catalogue) and the skill's instructions are inserted into the conversation.
This is how a skill whose description matches the current task gets used
without a slash command.

A skill **assigned to an agent** through that agent's `skills: [...]` (see
[Custom agents](#custom-agents)) is loaded in full into its system prompt from
the start. Every other skill is only catalogued one line each — loading
everything up front would exhaust the context window before any work begins.

### When something is misconfigured

Two situations are tolerated rather than treated as fatal, because a
misconfigured skill should not take down a session: a duplicate id (same
`namespace:name` from two sources) keeps the first one found and drops the
second, and an id in `always` or in an agent's `skills` that resolves to
nothing is simply skipped. Both are silent at the point they happen — but
`/skills` and `titah doctor` report the skill count per namespace and, only
when there is something to flag, list every conflict, every configured path
that yielded no skills, and every unresolved id together with where it was
configured.

### Two things skills do **not** do

- **opencode *plugins* are not supported.** opencode has two different
  extension mechanisms that share a folder structure but are not the same
  thing: *skills* are plain markdown files, and Titah reads those like any
  other skill source. *Plugins* are JavaScript modules written against
  opencode's own runtime API (hooks, event handlers, etc.) — there is no
  markdown to load, so Titah cannot run them and does not try to.
- **A skill cannot make Titah do anything by itself.** A skill is text
  inserted into a prompt — instructions, not code. It cannot open a browser,
  call an API, or perform any action beyond what the model can already do
  with the tools it has. Any new capability requires a tool, not a skill.

## Delegation

Type `@<agent>` at the start of a prompt:

```
@claude please review the changes in src/core/agent.ts
@opencode how many .ts files are in this repo?
```

Delegation is always **triggered explicitly by you**. Titah's model never
decides on its own to call another agent — one turn could call Claude Code
repeatedly and blow up cost without anyone noticing.

What happens:

| | |
|---|---|
| **Working directory** | The same as your session. The external agent sees the code you are working on |
| **What enters context** | **Only the final answer.** The full transcript goes to `tool-output/` and is referenced by path — injecting it whole would blow out the context window within two or three delegations |
| **Continuity** | The external session id is mapped to yours, so the second `@claude` resumes the same conversation |
| **Cost** | Shown **separately** in the footer (`ext 1.2k/45 ≈$0.093`). Summing it with Titah's own tokens would make the number a lie |
| **The `$` figure** | Passed through from the external agent (Claude Code's `total_cost_usd`). It is an **API-price equivalent, not a bill**. On a subscription, what you spend is rate-limit quota, not money |
| **Credentials** | Its own. Titah never forwards its provider keys into the subprocess |

An agent whose CLI is not installed is still **listed** as unavailable rather
than silently hidden. Check with `titah doctor`.

### Adding a third agent

One config block, no code:

```jsonc
{
  "externalAgent": {
    "aider": {
      "command": "aider",
      "args": ["--message", "{prompt}", "--no-stream"],
      "format": "text",
      "timeout": 600000
    }
  }
}
```

`sessionMode` decides who owns the session id:

- **`generate`** — Titah creates a UUID and hands it to the CLI. This is Claude
  Code's way: `--session-id <uuid>` to create, `--resume <uuid>` to continue.
- **`discover`** — the id is read from the first call's output and sent back
  afterwards. This is opencode's way.

The default arguments were verified directly against the installed CLIs rather
than guessed from documentation. Two things that are easy to get wrong: Claude
Code **rejects** `--output-format stream-json` without `--verbose`, and passing
the same `--session-id` twice is **not** how you resume.

Failures are handled explicitly: a 10-minute default timeout with a status pulse
so you can see the agent is alive, parsing that tolerates format changes, and
raw stderr always saved when something cannot be read.

## Consensus mode

One question, every external agent at once, then compared:

```
/consensus Is the caching approach in src/core/storage safe for concurrent writes?
```

Titah runs each agent **in parallel**, shows each answer as its own block, then
uses its own model to synthesise: what they agree on, **where they differ**, and
which is wrong.

Disagreement is the most valuable information here — it is the reason you asked
several agents at once — so the synthesis prompt explicitly forbids inventing
agreement that is not there.

An honest note on cost: `/consensus` calls **every** available agent, so the `$`
shown is the sum of what each reported. For Claude Code on a subscription that
figure is an API-price equivalent; what is actually consumed is rate-limit
quota. What you will feel more is **time** — consensus waits for the slowest
agent. Disable agents you do not want with `"enabled": false`.

If only one agent answers, Titah says so rather than pretending it was a
consensus. Agents that fail are still reported, never silently dropped.

## Project instructions

Titah reads `AGENTS.md`, then `CLAUDE.md`, then `TITAH.md`, walking up from the
working directory to the git root. The closest to the working directory is read
last, so it wins.

## Maintenance

Agent transcripts are dominated by tool output nobody reads again after the turn
ends. Titah separates it onto disk from the start, and `prune` sweeps all three
at once:

```bash
titah sessions prune --older-than 30d
# 4 sessions deleted (older than 30d).
# 12 orphaned tool-output blobs and 1 snapshots swept.
# Space reclaimed: 8.4 MB.
```

**Sessions with no conversation are never kept.** The TUI has to create a session
when it starts, not when you send the first prompt, because the event stream needs
an id up front. So `titah` opened and closed again would otherwise leave an
`(untitled)` row behind every time. Instead the session is discarded on exit, on
`/new`, and when you switch away from it — and a session that has no messages is
never listed even if a crash left it behind. `prune` sweeps any stragglers older
than an hour; the grace period is there because a *freshly* empty session is
probably open in another window, waiting for its first prompt.

Discarding always goes through a check on the server that the session is really
empty. The caller is throwing away a session it *believes* is unused, and one
miscount must never cost a real conversation.

Deleting database rows alone is not enough — it just moves the growth into the
directory next door.

## Development

```bash
npm run typecheck
npm test                     # 292 tests, no real LLM calls
npm run watch                # rebuild on save
npm run schema               # regenerate config.schema.json from zod
node scripts/smoke.ts        # one real LLM call (needs a live provider)
node src/cli.ts doctor       # headless commands run from source, no build
```

`npm test` builds `dist/` first: the TUI tests render real Ink components, and
Node cannot load `.tsx` directly.

`config.schema.json` is **generated** from `src/core/schema.ts` — do not edit it
by hand. Run `npm run schema` after changing the schema.

Code comments in this repository are written in Indonesian; the user-facing
interface and all documentation are in English.

## License

Apache-2.0. See [LICENSE](./LICENSE).
