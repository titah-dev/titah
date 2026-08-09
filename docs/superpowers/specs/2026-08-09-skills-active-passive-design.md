# Active and passive skills

**Date:** 2026-08-09
**Status:** approved, ready for planning
**Scope:** subsystem 1 of 4 (see *Scope and what this is not* below)

## Problem

Titah discovers skills but cannot really use them.

Today `discoverSkills` scans one directory level for `<dir>/<name>/SKILL.md`. Skills
named in `agent.skills` are injected whole into that agent's system prompt; every
other skill contributes a one-line catalog entry and a suggestion to run `/skills`.

That leaves two gaps:

1. **The model is told about skills it cannot reach.** A catalogued skill has no
   mechanism to load its body, so the model knows a skill exists and stops there.
2. **Skills the user already owns are invisible.** The two Claude Code plugins
   installed on the developer's machine nest skills two levels deep
   (`skills/productivity/grill-me/SKILL.md`), so the one-level scanner finds none
   of the 35 skills in `mattpocock-skills`.

The user wants both halves: skills the agent reaches for on its own (*active*),
and skills invoked explicitly as `/superpowers:brainstorming {message}` (*passive*).

## Measurements that shaped the design

Taken from the real plugin cache on the development machine, not estimated:

| Source | Skills | Size |
|---|---|---|
| `superpowers` 6.2.0 | 14 | 125.0 KB |
| `mattpocock-skills` 1.2.3 | 35 | 150.1 KB |
| Subtotal, measured | **49** | **275.1 KB ≈ 70k tokens** |
| `~/.config/opencode/skills` | 7 | not measured |
| **Total discovered** | **56** | ≥ 275 KB |

Name collisions across all three sources today: **0**.

Two consequences follow directly:

- **Injecting every active skill is not viable.** 70k tokens per request before
  the user's prompt. The developer's ollama runs at `num_ctx` 4096, where the
  provider truncates silently rather than erroring.
- **Namespacing is cheap insurance, not urgent triage.** Nothing collides yet,
  but today's `discoverSkills` resolves collisions by "first path wins" with no
  message, so the first collision would silently swap the skill being invoked.

Claude Code skill frontmatter is already exactly what Titah parses:

```yaml
---
name: executing-plans
description: Use when you have a written implementation plan to execute…
---
```

So Claude Code and opencode skills need no conversion. They need to be *found*.

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Hybrid delivery: `always` loaded whole, everything else catalogued and loaded on demand | Inject all active skills | 70k tokens/turn; impossible at `num_ctx` 4096 |
| 2 | Auto-detect Claude Code and opencode registries, plus manual paths | Literal paths only | Plugin paths are version-pinned (`superpowers/6.2.0/skills`); they die silently on upgrade |
| 3 | Passive invocation puts the skill body **into the conversation** | Into a session-level system prompt | Visible in the transcript, and `/compact` can shrink it later |
| 4 | Always fully-qualified names: `plugin:skill` | Short names when unambiguous | Never ambiguous, never changes meaning when a plugin is installed |
| 5 | Namespace from manifest → folder name → parent when folder is `skills`, overridable with `as` | Require a manual label everywhere | The rule produces the correct name for both real unlabelled cases |
| 6 | One load mechanism, two entry points (user command, model tool) | Separate paths for active and passive | Prevents the two paths from drifting apart |

## Architecture

### Configuration

```jsonc
{
  "skills": {
    "discover": ["claude", "opencode"],          // default; [] disables
    "paths": [
      "./skills",                                 // namespace derived
      { "path": "~/lib/skills", "as": "punyaku" } // namespace overridden
    ],
    "always": ["superpowers:using-superpowers"]   // loaded whole, every turn
  }
}
```

`agent.skills` keeps its meaning — load these whole for this agent — and now takes
fully-qualified names, the per-agent counterpart of `always`. It follows the same
not-found rule as `always`: skipped loudly, never fatal.

**Precedence when two sources yield the same id:** entries in `paths` win over
auto-discovered sources, and within each group, declaration order decides. The
user's own configuration outranks anything Titah inferred.

### Discovery pipeline

Discovery produces a list of sources `{ root, namespace }`, then scans each root.

| Source | Origin | Namespace |
|---|---|---|
| `discover: ["claude"]` | `~/.claude/plugins/installed_plugins.json` → each `installPath` → `<installPath>/skills` | `<installPath>/.claude-plugin/plugin.json` → `name` |
| `discover: ["opencode"]` | `~/.config/opencode/opencode.json` → `skills.paths[]` | folder rule |
| `paths[]` | as written | folder rule, or `as` |

**Folder rule:** the directory's own name, except when that name is `skills`, in
which case the parent's name. On the development machine this yields `opencode`
for `~/.config/opencode/skills` and `titah` for `~/Project/titah/skills`.

**Scanning becomes recursive.** This is what makes the 35 nested mattpocock skills
visible. The existing single-file layout (`<dir>/<name>.md`) stays supported.

Skill identity is `<namespace>:<name>`, where `name` comes from frontmatter and
falls back to the containing folder's name.

### Load mechanism — one operation, two callers

Passive and active are the same operation triggered by different actors, so there
is one implementation:

```
<skill name="superpowers:brainstorming" source="…/SKILL.md">
…body…
</skill>
```

**Passive** — `/superpowers:brainstorming bikin fitur X`

Titah already separates what is displayed from what is sent. In `prompt()`:

```ts
createMessage(session.id, "user", [{ text: input.text }])  // displayed
messages = [...history, { role: "user", content: text }]    // sent, expanded
```

Templated commands already use this path; passive skills reuse it unchanged. The
transcript shows the typed command; the model receives the expanded block followed
by the user's argument.

**Routing needs no precedence rules.** Because skills are always fully qualified,
`:` is decisive: a command name containing `:` is a skill. Command keys in config
are forbidden from containing `:`, so the two namespaces cannot overlap. The
command regex gains `:` while keeping the guard that stops `/home/user/notes.md`
from parsing as a command.

**Active** — tool `skill(name)`

The system prompt carries `always` skills whole, then the catalogue of every
discovered skill, then a note that the `skill` tool exists. The tool returns the
same block, which lands in the conversation as a tool result and therefore
persists in `model_message` for the rest of the session.

### Guards

**1. A skill is not loaded twice.** A second call returns a short note instead of
the body again, so a confused model cannot fill the context by re-reading the same
file.

The "already loaded" set **must be computed from the history the model can see**
(`listModelMessages`), not from the raw rows. Computed from raw rows, a skill
loaded before `/compact` would still count as loaded after compaction — even
though its body is no longer visible to the model, which would lose that skill for
the rest of the session with no way to recover it. Computed from the compacted
view, compaction naturally re-permits loading.

**2. Size cap.** Bodies are truncated at 64 KB (largest today: 9 KB) with an
explicit truncation notice rather than a silent cut.

**3. No permission prompt.** Loading a skill reads a file from a path the user
configured and places it in context — equivalent to the system prompt. Titah's
permission engine guards edit/write/bash; a dialog here would only train the user
to press `y` without reading.

### Interaction with `/compact`

The `<skill name=…>` wrapper is functional, not decorative: it lets the summariser
record *"skill X was loaded"* instead of copying 9 KB of skill text into the
summary. `COMPACT_SYSTEM` gains that instruction.

### TUI

- `/skill` currently inserts the text `Use the "X" skill.`; it now inserts
  `/namespace:name `.
- `/` autocomplete lists skills alongside commands; typing `/superpowers:`
  narrows to that plugin's 14 skills.

## Error handling

Discovery follows the precedent already set for credentials: an unset
`${env:...}` does not fail config loading — it is recorded and complained about
only where it matters.

| Condition | Behaviour |
|---|---|
| Path missing or unreadable | Skipped, recorded. Surfaced in `/skills` and `titah doctor` |
| `installed_plugins.json` missing or in an unrecognised format | `discover: ["claude"]` yields nothing; not an error. The format belongs to Claude Code and can change |
| `SKILL.md` without frontmatter | Name from folder, empty description — current behaviour, kept |
| Name in `always` or `agent.skills` not found | Skipped loudly: recorded, shown in `doctor`, noted in `/skills`. Never fatal |
| Two skills with the same id | `paths` beats auto-discovery, then declaration order; conflict recorded and displayed |
| Tool called with an unknown name | Error result naming candidates in the same namespace |

**An unresolved `always` entry does not stop startup.** The temptation is to make
it fatal, since `always` is policy and policy that vanishes silently is dangerous.
But refusing to start because a plugin was uninstalled makes Titah unusable
exactly while the user is fixing their configuration. It is skipped and announced
in three places instead.

`titah doctor` gains a skills section: counts per namespace, failed paths,
conflicts, and dangling `always` entries.

## Testing

**Pure unit tests**

- Namespace derivation: manifest → folder → `skills` promotes to parent → `as`
  override. The three real cases on the development machine form the table.
- Command regex accepts `plugin:skill` and still rejects `/home/user/notes.md`.
- System prompt assembly: `always` whole, everything else one line.

**Unit tests over a temporary tree**

- Recursive scanning finds `skills/productivity/grill-me/SKILL.md` two levels down.
- Duplicate ids record a conflict rather than swallowing it.

**The load guard**

- Load a skill → `/compact` → loading it again must be permitted. Computed from
  raw rows this test fails, which is precisely the bug it exists to catch.

**Integration**

- A stub model calls `skill()`; assert the body reaches `model_message`.
- `/plugin:skill args`: the transcript shows what was typed, `model_message`
  carries the skill body.

**One hard rule:** no test may read the real `~/.claude` or `~/.config/opencode`.
Discovery adapters are tested against a temporary `HOME` containing fake
registries. A test that depends on whichever plugins happen to be installed passes
on one machine and fails on every other.

## Scope and what this is not

This spec covers subsystem 1 of 4 identified during brainstorming:

1. **Active and passive skills** — this document
2. Plugin packages (Claude-compatible: `commands/`, `agents/`, `hooks/`)
3. Plugin install and marketplace
4. Plugin-provided tools (browser automation and similar)

Explicitly out of scope here: reading `commands/`, `agents/`, or `hooks/` from a
plugin. The plugin manifest is read **only** to obtain the plugin's name.

Two corrections to the original request, established by inspecting the installed
plugins:

- **opencode plugins cannot "just work".** They are JavaScript modules against
  opencode's runtime API (`.opencode/plugins/superpowers.js` uses a config hook and
  a message transform). Supporting them means implementing that API inside Titah
  and executing third-party code — a different problem from reading markdown, and
  a security decision that deserves its own discussion. opencode *skills* are
  plain markdown and are fully supported here.
- **"Titah can open a browser" cannot come from a skill.** A skill is text placed
  in a prompt. Opening a browser requires a new tool, which is subsystem 4.
