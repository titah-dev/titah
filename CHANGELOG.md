# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/).

## [0.1.0] — unreleased

First release. Titah works as a full coding agent, with delegation to other
agent editors as the thing that sets it apart.

### Agent & tools

- Streaming agent loop on AI SDK v7, with OpenAI-compatible providers as
  first-class citizens.
- Read tools: `read`, `list`, `glob`, `grep`. All filesystem access is confined
  to the session working directory.
- Change tools: `edit` (exact string replace, must be unique, fails hard),
  `write`, `bash` (timeout + cancel).
- Tool output above 32 KB is written to `tool-output/`; the context only ever
  receives the head plus a pointer.

### Permissions & undo

- Deny by default for `edit`/`write`/`bash`, with a per-session allowlist, a
  config allowlist, and an `--auto` mode.
- **With no client connected, permission is auto-denied** — never hanging,
  never silently allowing.
- A git snapshot is taken in a shadow repo before the first change of each turn.
  `titah undo` reverts the whole turn, including deleting files it created.
  Your own `.git` is never touched.

### Context management

- Compaction runs **automatically**, between turns and **mid-turn**, so a single
  long agentic turn cannot overflow the window on its own.
- Bounded by the model's declared `contextWindow`. Undeclared means compaction is
  off for that model, said out loud once per session and listed by
  `titah doctor` — a wrong window is more dangerous than no window, because a
  provider does not reject an oversized request, it truncates the oldest part and
  the model then answers confidently about what it can no longer see.
- Old tool output is pruned before anything is summarised — free, and usually
  enough. Sub-agent (`task`) results are exempt from ordinary pruning: re-running
  one costs a whole nested turn, unlike re-reading a file.
- The summariser's own prompt is bounded as well. A transcript larger than the
  summariser's window is summarised in chunks and the chunk summaries summarised
  in turn, rather than being silently truncated by the provider.
- Tunable: `compaction.auto`, `reserved`, `tailTurns`, `prune`. `reserved` is
  capped at a quarter of the window, so the 8192 default does not swallow an 8k
  local model's entire budget.
- `/compact` runs the same machinery on demand, and `/compact <focus>` keeps the
  named material in full detail.

### Sub-agents

- Titah's own model can dispatch several of its configured agents in parallel
  inside one turn, with the `task` tool or `/tim <task>`.
- Dispatch depth is capped at exactly one level: a sub-agent never receives
  `task`, so nothing can spawn a tree that burns quota with no way to stop it.
- Readers run concurrently; writers are serialised per working directory, so two
  sub-agents never race over the same shadow-git snapshot.
- An agent's `delegate` routes it through an external CLI instead of Titah's own
  loop — the same engine `@claude` uses, reached from `task`.
- A live panel (`ctrl+x` then `↓`) shows each sub-agent's state and can cancel one
  without killing the coordinator's turn.

### Modes

- Three modes ship built in: **Plan** (refuses every change), **Build Manual**
  (confirm each step, the default), and **Build Auto** (no confirmations).
- `Tab` switches modes, same key as opencode.
- Permissions can be overridden **per agent**, not just globally — that is what
  separates Build Auto from Build Manual.

### Interface

- Ink TUI on the alternate screen buffer, with opencode's default keybindings
  (`ctrl+x` leader). `Esc` cancels a turn without corrupting history.
- Opening screen centres the prompt under an ASCII logo, like opening nvim.
  After the first prompt the layout switches to info panel, history, and a
  prompt pinned to the bottom.
- Header panel shows the Titah mark beside session information, dropped
  automatically on short terminals.
- `/session` resumes a saved session and `/new` starts a fresh one, both from
  the palette or by typing.
- Command palette on `Ctrl+P`, with nested menus: picking `/model` lists the
  models from your config, and picking one switches the session model.
- Autocomplete popups while typing: `@` for agents and files, `/` for commands.
- `↑`/`↓` scroll the history.
- Assistant answers render as markdown: headings, bold, inline code, fenced
  code blocks, lists, and quotes. Your own prompts stay raw, and underscores are
  never treated as emphasis so `snake_case` survives intact.
- A spinner with elapsed time sits right above the prompt while work is running.
- HTTP + SSE server; the TUI is just one client, `curl` is another.
- `titah run` for headless and scripted use.

### Delegation

- `@claude` and `@opencode` as ordinary prompts. The answer joins your
  conversation; the full transcript goes to `tool-output/`.
- External sessions are mapped, so the next `@claude` resumes the same
  conversation.
- External tokens and cost are shown **separately** from Titah's own.
- Config-driven registry: adding a third agent touches no code.

### Consensus, agents, commands, skills

- `/consensus` fans one question out to every external agent in parallel, then
  synthesises and flags where they disagree.
- Custom agents (prompt + tool filter + permission override + model override, plus
  `delegate` to run one through an external CLI instead).
- Custom commands (`/review src/a.ts`) with `{{.Input}}` placeholders.
- Markdown skills from `skills.paths`, in two supported layouts — **and
  discovered from the Claude Code and opencode registries** (`~/.claude`,
  `~/.config/opencode`), so skills you already have work without configuration.
- Skills are both passive (catalogued in the system prompt, loaded by the model
  with the `skill` tool) and active (`/<skill-name>` inserts one yourself).
- Per-agent `steps` limits, and a text answer forced when the limit is reached
  rather than the misleading "the model stopped without giving an answer".

### Account (optional)

- `titah login` signs a machine in through the browser, using the **Device
  Authorization Grant** (RFC 8628) rather than a loopback redirect — because a
  coding agent is very often run over SSH or in a container, where a redirect to
  `127.0.0.1` reaches the loopback interface of the wrong machine.
- The first run on a new machine asks once: sign in, or continue without an
  account. The answer is recorded, so it is never asked again — and "without an
  account" is a real answer, because nothing in the agent needs one.
- A non-interactive run is never asked and never has a choice recorded for it,
  and a failed sign-in never stops the session.
- `titah whoami` and `titah doctor --probe` **verify against the server** rather
  than trusting the file on disk, which is the only way to notice a token
  revoked from the dashboard. `titah logout` revokes remotely, then deletes
  locally whether or not the server could be reached.
- `/login`, `/logout` and `/account` do the same from inside the TUI; `Esc`
  cancels a sign-in that is waiting.
- The token lives in `account.json` at mode 0600, kept separate from `auth.json`:
  one holds your provider keys, the other your identity, and mixing them would
  let `titah auth remove` take your login with it.
- The server is chosen from `$TITAH_ACCOUNT_SERVER`, then `account.server`, then
  the default — and a token records which server issued it, so changing servers
  asks you to sign in again instead of silently reusing one that means nothing.

### Setup & maintenance

- `titah init` detects keys from the environment and probes local endpoints
  before asking anything. `--yes` for a non-interactive path.
- `titah sessions prune` sweeps database rows, orphaned tool-output blobs, and
  orphaned snapshot repos in one command.
- `titah doctor` checks environment, config, credentials, and external agents.

### Notes

- Credentials are never written to the config; they live in `auth.json` with
  mode 0600, or are referenced through `${env:VAR}`.
- Linux and macOS. Windows is not supported yet.
- Requires Node.js ≥ 22.6.
