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
- Custom agents (prompt + tool filter + permission override + model override).
- Custom commands (`/review src/a.ts`) with `{{.Input}}` placeholders.
- Markdown skills from `skills.paths`, in two supported layouts.

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
