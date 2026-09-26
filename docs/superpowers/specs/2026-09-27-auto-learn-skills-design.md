# Auto-learn skills — Design Spec

**Date:** 2026-09-27
**Status:** Approved for implementation

---

## 1. Purpose

Titah writes reusable skills on its own. After a substantial turn finishes, one
cheap model call decides whether the work contained a procedure worth keeping
(a deploy sequence, a debugging routine, a project-specific build dance). If it
did, Titah writes a `SKILL.md` that later turns can load like any other skill.

Fully automatic: no permission dialog, no confirmation. The user is told after
the fact, with the path, and can delete the file.

### Non-goals

- Skills inside the repo. Learned skills never touch the working tree.
- Editing skills the user wrote. Titah only updates files it created itself.
- Facts. A single fact ("the API runs on port 8080") belongs in `memory`, not
  in a skill.
- Learning from sub-agents, or from `titah run` when the process exits before
  the reflection finishes. Best effort, not a guarantee.

---

## 2. Config

```jsonc
"skills": {
  "learn": {
    "enabled": false,  // off by default: it spends tokens without asking
    "minTools": 8,     // tool calls a turn needs before it is considered
    "max": 30          // cap on learned skills; at the cap only updates happen
  }
}
```

`enabled` defaults to `false`, following the rule that every new axis that
spends money is off until switched on. Schema lives next to the existing
`skills` object in `src/core/schema.ts`; `config.schema.json` is regenerated.

The reflection uses `smallModel ?? model`, the same choice compaction makes.

---

## 3. Gate

Reflection runs only when **all** of these hold, evaluated in the `finally` of
the turn in `src/core/agent.ts`, after `willContinue` is known:

| Condition | Why |
|---|---|
| `skills.learn.enabled` | off by default |
| top-level session (`!isChild`) | sub-agents report to a parent that may learn instead |
| not aborted, `assistant.error === undefined` | a failed procedure is not one to repeat |
| `!stoppedAtLimit` | a turn cut off mid-way has no finished procedure |
| `!willContinue` | the work is not done yet |
| tool calls in this turn `>= minTools` | chat and short answers never cost a call |

The gate is a pure function `shouldReflect(input): boolean` so it can be tested
without running a turn.

---

## 4. Digest

The model sees a digest, never the transcript. `buildDigest()` in a new
`src/core/learn.ts`:

- the user's request that started the turn, first 2,000 characters;
- each tool call in order: tool name, a one-line summary of its input (first
  200 characters of the JSON), and `ok` / `error`;
- the final assistant text, first 2,000 characters;
- the existing learned skills: `name: description`, one per line.

The whole digest is capped at 24,000 characters (about 6k tokens). When over,
the middle tool calls are dropped first and replaced by one line saying how many
were omitted: the start and the end of a procedure carry the most information.

---

## 5. Decision

One `generateText` call with a fixed system prompt. The answer must be JSON:

```json
{ "action": "none" | "create" | "update",
  "name": "kebab-case-name",
  "description": "Use when ... (≤160 chars)",
  "body": "markdown steps" }
```

The prompt's rules, stated so `"none"` is the expected common answer:

- keep only a multi-step procedure that is likely to recur and is not obvious;
- never a single fact (that is `memory`), never a one-off task;
- never secrets, tokens, passwords, or hostnames with credentials;
- `update` only when an existing learned skill covers the same procedure and
  this turn improved it; `name` must then be that skill's name;
- body is instructions to a future agent: when to use, steps, pitfalls seen.

Parsing reuses `parseStructured()` from `src/core/output.ts`, the extraction behind `--json-schema` (tolerates a fenced
block). Anything unparseable is treated as `"none"`.

---

## 6. Validation

Before anything is written, `validateLearned()` rejects:

| Check | Rule |
|---|---|
| name | `^[a-z0-9][a-z0-9-]{1,48}$` — no `/`, no `..`, no dots at all |
| description | 1–160 characters |
| body | 1 byte – 8 KiB |
| secrets | body or description matches common key shapes (`sk-…`, `ghp_…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `Bearer <long token>`, `password=`/`token=` with a value) |
| cap | `create` when learned count `>= max` |
| ownership | `update` of a file that lacks `source: titah-learn` in its frontmatter, or of a name that does not exist |

A rejected decision writes nothing and logs one line (§8).

---

## 7. Storage and discovery

- Path: `~/.config/titah/skills/learned/<name>/SKILL.md` (under
  `XDG_CONFIG_HOME` when set).
- Frontmatter:
  ```yaml
  ---
  name: <name>
  description: <description>
  source: titah-learn
  created: 2026-09-27T10:00:00Z
  updated: 2026-09-27T10:00:00Z
  session: ses_…
  ---
  ```
- Written atomically: temp file in the same directory, then `rename`.
- When `learn.enabled`, the directory is added to the skill sources with
  namespace `learned`, after the user's `skills.paths` and before the
  auto-detected sources. Since `buildSkillIndex()` runs per turn, a new skill
  is in the catalog of the next turn with no restart.
- `parseFrontmatter()` learns to read `source`, so ownership can be checked.

No permission dialog: like the `memory` tool, this is Titah writing to its own
directory, not the model writing to the user's files.

---

## 8. Running it, and what the user sees

- Runs after `session.idle` is published, detached from the turn: the answer is
  already on screen and the turn's promise does not wait for it.
- Honours the session's abort: `Esc` on the next turn cancels a reflection still
  in flight. A reflection never runs concurrently with another for the same
  session; a second one while the first is running is skipped.
- On `create` / `update`: one `session.notice`:
  `Learned a skill: learned:<name> → <path>` (or `Updated learned:<name>`).
- On `none`, rejection, or any error: no notice. One line goes to
  `~/.config/titah/learn.log` (timestamp, session, outcome, reason), the same
  pattern as `tracking.log`.
- Token usage of the call is recorded like compaction's, so `titah stats`
  counts it.

---

## 9. Files

| File | Change |
|---|---|
| `src/core/learn.ts` | new: `shouldReflect`, `buildDigest`, `decide`, `validateLearned`, `writeLearned`, `reflect` |
| `src/core/schema.ts` | `skills.learn` |
| `src/core/skill.ts` | read `source` from frontmatter |
| `src/core/skill-sources.ts` | add the learned directory as a source when enabled |
| `src/core/agent.ts` | call `reflect()` from the turn's `finally` when the gate passes |
| `src/cli.ts` (`doctor`) | one line: learning on/off, count of learned skills, path |
| `config.schema.json` | regenerated |
| `docs/` + `CHANGELOG.md` | document the switch and where files go |

---

## 10. Testing

`test/learn.test.ts`, with `XDG_CONFIG_HOME` / `XDG_DATA_HOME` in a temp dir and
the model stubbed:

- gate: each failing condition alone keeps `shouldReflect` false; all passing
  makes it true;
- digest: cap holds; start and end survive, middle is summarised;
- decision: fenced JSON parsed; garbage → `none`;
- validation: path traversal, uppercase / dotted names, oversize body, each
  secret shape, cap reached, update of a user-written skill, update of a
  missing name — all rejected, nothing on disk;
- write: atomic, frontmatter complete, `update` keeps `created` and bumps
  `updated`;
- discovery: after a write, `buildSkillIndex()` lists `learned:<name>`; with
  `enabled: false` the directory is not a source;
- end to end: a stubbed turn with 8 tool calls and a stubbed model answering
  `create` produces the file and one notice; with 7 tool calls, no model call
  is made at all.
