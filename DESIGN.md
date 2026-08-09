# Titah — Design Document

A coding agent CLI that can delegate questions to other agent editors
(`claude`, `opencode`, and others). This document is the outcome of a design
interview and is the single reference for M0–M6.

Status: **M0–M6 ✅ · version 0.1.0**
Remaining before `v1.0.0`: use Titah to build Titah for a full week.
License: Apache-2.0

---

## 1. Identity & position

Titah is a **complete coding agent**, not a wrapper over other agents. It has
its own LLM loop, tool set, and session management. Calling external agents is
*one extra capability* — the differentiator, not the foundation. If `claude` and
`opencode` are not installed, Titah still works fully.

v1 delegation targets: **`claude` + `opencode`**, through a config-driven
adapter registry, so adding a third agent means editing configuration rather
than touching the core.

Titah **does not** redistribute or bypass any agent. It spawns the CLI the user
installed, with the user's own credentials. The README states this plainly.

---

## 2. Technical foundation

| Area | Decision |
|---|---|
| Language/runtime | TypeScript + Node (developed on Node v26, `node:sqlite` built in) |
| Topology | **Client/server.** The core is an HTTP server. `titah` spawns a local server on a random port and attaches the TUI to it |
| Protocol | **HTTP REST + SSE.** Client→server: POST. Server→client: SSE |
| Streaming | **Hybrid.** `text.delta` per token for assistant text; whole-message snapshots for tool state changes |
| Storage | **SQLite** (`node:sqlite`) for metadata and messages. Large blobs go to `tool-output/<id>` on disk; the DB keeps a pointer and a summary |
| Retention | `titah sessions prune --older-than 30d` exists from v1 |
| Providers | **AI SDK v7** (`ai@7`). `@ai-sdk/openai-compatible` is first-class; Anthropic/OpenAI are merely presets |
| Credentials | `${env:VAR}` in config **plus** `auth.json` with mode `0600`, kept **separate** from the config |
| Config | **JSONC + `$schema`**. Global `~/.config/titah/titah.json` merged with the project's `./titah.json` |
| Distribution | **A single npm package**, `titah`, with clean internal boundaries: `src/core`, `src/tui`, `src/server` |
| Platform | **Linux + macOS** for v1. The code stays platform-neutral so Windows later is a day of work |

### Why SQLite plus blobs on disk

The opencode install on the development machine had a 580 MB `opencode.db`,
while every other directory held only hundreds of kilobytes. Agent transcripts
are dominated by tool output — file contents, grep results, build logs — that
nobody reads again after the turn ends. Titah separates blobs from the start and
ships retention in v1; adding retention after a user already has a 600 MB
database is too late.

### Why client/server from day one

Splitting a monolith into client/server later is open-heart surgery. Starting
from a server is cheap and immediately opens the door to `attach`, a web UI, and
remote use. To the user it still feels like one process, because `titah` spawns
its own server.

---

## 3. Agent loop & tools

### v1 tool set

`read`, `list`, `glob`, `grep`, `edit`, `write`, `bash`, plus delegation.

Deferred to v2: `task`/subagent spawning, `webfetch`, MCP, plugin loader.

### The `edit` tool

**Exact string replace** (`oldString`/`newString`), must be unique, **fails hard**
on no match. Failing hard is the feature: better that the tool refuses than
silently writes in the wrong place. A `replaceAll` flag covers deliberate
multi-replacements.

Before each batch of writes, Titah takes a **git snapshot** so `undo` is always
possible. That is what makes "always allow write" feel safe.

### Permission model

**Deny by default** for `write`/`edit`/`bash`, with a per-session allowlist
("always allow `git *`") and an `--auto` flag for automation.

Because the topology is client/server, permission travels across processes: the
server emits `permission.request` → the TUI shows a dialog → the user answers →
a POST comes back → the server continues.

- **No client connected** (bare `serve` mode) → **auto-deny and log the reason.**
  Blocking forever hangs the agent in CI; auto-allowing turns headless mode into
  a silent security hole. The right path for automation is an explicit
  `--auto`/allowlist.
- **`Esc`** → **abort the whole turn**, not just the running tool. A half abort
  leaves a `tool_call` without its `tool_result`, corrupting history and causing
  errors on the next request.

### Context

Instruction files are read in order: `AGENTS.md` → `CLAUDE.md` → `TITAH.md`
(the last as a Titah-specific override).

### Modes and custom agents

An agent is a **prompt + tool filter + permission override + model override**
behind a name, selected with `Tab` or `--agent`. **No** subagent spawning in v1,
so there is no recursive concurrency.

Three modes ship built in: **Plan** (refuses every change), **Build Manual**
(confirm each step, the default), and **Build Auto** (no confirmations).

Plan locks changes through **permissions**, not by removing the tools. When the
tools were removed entirely the model simply gave up without a word — measured,
not assumed. With an explicit refusal it receives a reason it can pass on. The
safety is identical: permission is checked before execution.

### Commands & skills

Custom commands (a prompt template plus a target agent) and skills (markdown
loaded into context on demand) are in v1. **The plugin loader is deferred to
v2** — shipping a plugin API before the core hardens locks you into an API that
may well be wrong.

---

## 4. Delegation — the differentiator

### Mechanism

**Subprocess + JSON streaming**, uniform across both targets:

| | `claude` | `opencode` |
|---|---|---|
| Command | `claude -p "<prompt>" --output-format stream-json --verbose` | `opencode run "<msg>" --format json` |
| Continuity | `--session-id <uuid>` to create, `--resume <uuid>` to continue | `--session <id>` |
| Other protocol | — | `opencode acp` (ACP) available |

The internal adapter interface is **deliberately shaped like ACP**
(`prompt`, `sessionUpdate`, `requestPermission`, `cancel`), so adding an ACP
transport in v2 means writing one new adapter rather than rebuilding the core.

Two things that are easy to get wrong, both verified against the installed CLIs
rather than guessed from documentation: Claude Code **rejects**
`--output-format stream-json` without `--verbose`, and passing the same
`--session-id` twice is **not** how you resume.

### Control

**Explicit, by the user** — `@claude please review this`. No LLM-driven
delegation in v1: a model deciding for itself could call Claude Code repeatedly
within one turn and blow up cost without anyone noticing.

### Adapter contract

1. **Working directory**: the same cwd. An isolated worktree sounds safer but
   makes the agent's answer irrelevant to the work actually in progress.
2. **Write access**: **read-only** by default. External agents answer; if a
   change is needed, Titah applies it through its own permission model.
3. **What enters Titah's context**: **only the final answer plus metadata**
   (cost, duration, session id). The full transcript goes to `tool-output/` and
   is referenced by path. Injecting whole transcripts would blow out the context
   window within two or three delegations.
4. **Session continuity**: the external session id is persistently mapped to the
   Titah session, so the second `@claude` resumes the same conversation.

### Consensus mode

`/consensus <prompt>` fans one prompt out in parallel to every available
external agent, then Titah synthesises the answers and **marks where they
disagree**.

This violates the "no concurrency" stance above, but the concurrency is **flat
and bounded** by the number of agents rather than recursive. That distinction is
what makes it safe. It is also the one thing that makes Titah more than a less
mature opencode, so it belongs in v1.

### Failure handling

| Failure | Behaviour |
|---|---|
| CLI not installed | Detect via `which` at startup. **Show it as unavailable, with the command that is missing** — never hide it |
| Timeout | Default **10 minutes**, configurable per adapter, with progress pulses so the user can see the agent is alive. A silent timeout is the worst possible experience |
| Output does not match the schema | Tolerant parsing plus a known-good minimum version. Raw stderr is saved to `tool-output/` when parsing fails |
| Cost | **Shown separately** in the footer (`ext 8k tok ≈$0.09`). Never summed — mixing them makes the cost figure a lie. The `$` figure is passed through from the external agent and is an **API-price equivalent, not a bill**: subscription users pay in rate-limit quota, not money per call |

---

## 5. Interface

An Ink TUI with **opencode's default keybindings** (`ctrl+x` as leader), running
on the alternate screen buffer so the terminal underneath stays untouched and is
restored on exit.

The opening screen centres the prompt beneath an ASCII logo, the way nvim opens.
After the first prompt the layout switches: an info panel on top, history in the
middle, and the prompt pinned to the bottom, with a spinner above it while work
runs.

Autocomplete popups: `@` for agents and files, `/` for commands, `/model` for a
model picker, `/skill` to insert a skill. Triggers only fire at the start of a
word, so email addresses and absolute paths never open a popup nobody asked for.

> The keybinding table lives at **`opencode.ai/tui.json`** (184 actions), with
> defaults documented at `opencode.ai/docs/keybinds/`. Titah implements the
> relevant subset with identical keys. One deliberate deviation: `tool_details`,
> which opencode leaves unbound, is bound to `<leader>d` — a collapsible tool
> block with no key to collapse it is a feature nobody can find.

### Startup

Detect environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), probe
local endpoints, and only then ask. Telling a user to write a `provider` block
with `npm`, `baseURL`, and a `models` map from scratch is the wall that makes
people give up in the first minute.

The default model must be **explicit in the config**. If none is chosen, show a
picker — never guess.

---

## 6. Verification

**Thorough unit tests** for the parts that fail silently: `edit` (string
matching, non-unique cases, hard failure), `bash` (timeout, cancel), the
permission engine, and **delegation adapters against a stubbed external CLI** —
that last one matters, because tests that burn tokens never get run.

**Three to five end-to-end scenarios** against a small fixture repo, run
manually before a release rather than in CI. Jumping to a full eval before the
core is stable means debugging the harness instead of the product.

---

## 7. Milestones

| | Milestone | Definition of Done |
|---|---|---|
| **M0** | Foundation: repo, config loader + `$schema`, `auth.json` 0600, AI SDK provider layer | `titah --version` works; one real LLM call succeeds from a script |
| **M1** | Headless core loop: HTTP+SSE server, SQLite sessions, read tools | `curl -X POST` a prompt → SSE streams an answer that genuinely read a file |
| **M2** | Write tools + permissions + snapshots | The agent fixes a bug in a fixture repo; `undo` restores it exactly; permission is denied with no client attached |
| **M3** | Ink TUI: attach, chat view, collapsible tool blocks, footer, opencode keys | A full interactive session; `Esc` cancels a turn without corrupting history |
| **M4** | Delegation: `claude` + `opencode` adapters, `@claude`, session mapping | `@claude explain module X` → the answer enters context; a second `@claude` resumes the same session |
| **M5** | Consensus + custom agents + commands + skills | `/consensus` works; `Tab` switches agents; custom commands run |
| **M6** | Onboarding wizard, retention `prune`, docs, Apache-2.0 npm release | Clean machine → installed → first session without touching a config editor |

**v1 is done when M0–M6 are complete and Titah has been used to build Titah for
a full week** before tagging `v1.0.0`. That is the only test that finds the
defects the test suite does not.

### The ordering, and why the TUI is not first

A TUI on top of an unstable core means every core bug shows up as a render bug,
and you debug two layers at once. A headless server can be tested with `curl` —
the difference between a ten-minute debug and a two-hour one.

Delegation is deliberately not pulled earlier either, despite being the most
interesting feature: without a mature tool loop (M1–M2) there is no way to tell
"the Claude adapter is broken" from "my tool loop is broken". M4 is the earliest
point where `@claude` can be judged honestly.

**The most honest exit point is M2.** If the core still feels fragile after M2,
stop and fix it rather than moving on to the TUI. The commonly underestimated
milestone is not M3 but M2 — permissions plus snapshot/undo.
