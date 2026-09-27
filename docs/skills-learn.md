# Learned skills

Titah can write skills on its own. After a turn that finished normally and used
at least `minTools` tool calls, one call to `smallModel` reads a short digest of
the turn — the request, the sequence of tool calls, the final answer — and
decides whether it was a procedure worth keeping. Most turns are not.

    { "skills": { "learn": { "enabled": true, "minTools": 8, "max": 30 } } }

Off by default: every qualifying turn pays for one small-model call without
asking.

- Files: `~/.config/titah/skills/learned/<name>/SKILL.md`, namespace `learned:`.
- Titah only ever updates files whose frontmatter says `source: titah-learn`.
  Remove that line and the skill is yours: Titah will not touch it again.
- Delete a folder to forget a skill.
- Every decision, including "none", is one line in `~/.config/titah/learn.log`
  with the tokens it used.
- Never from sub-agents, failed or cancelled turns, turns stopped at a limit,
  or turns that auto-continue.
- `titah run` never learns: the process exits as soon as the answer is
  printed.
- Learned skills are written from what happened in a turn, which can include
  text from fetched pages or files; they are marked in the catalog, and you
  should read a new skill (the notice gives its path) before relying on it.
