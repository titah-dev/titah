# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/).

## Unreleased

### Extension — panel samping yang disumbang paket npm

Titah punya `plugin` dan `hooks` untuk mengubah **perilaku**. Yang belum tertutup
adalah hal yang tidak berbentuk perilaku sama sekali: melihat branch git tanpa
keluar dari sesi, membaca daftar worktree, menengok diff yang baru ditulis agent.
Sebelum ini, semuanya berarti terminal kedua.

- **`extension` di config**, bentuk kunci yang sama dengan `plugin` (npm, path,
  `market:<id>`). Disebut satu per satu; tidak ada penemuan otomatis.
- **Panel kiri dan kanan**, `<leader>←` / `<leader>→`, dengan lantai: di bawah
  `panel.floor` kolom panel tertutup sendiri alih-alih membuat riwayat tidak
  terbaca. `<leader>e` menyegarkan, `<leader>x` membuka picker.
- **Permukaan publik `titah-code/extension`** — hanya tipe dan pemeriksa versi.
  `exports` di `package.json` menolak jalur lain, jadi `core/permission.js` dan
  `core/auth.js` tidak bisa di-`import` extension sama sekali. Batasnya
  ditegakkan resolver Node, bukan dokumen.
- **`engines.titah` diperiksa saat load.** Extension tanpa itu ditolak: selama
  API 0.x, paket yang tidak menyatakan versi targetnya tidak bisa dibedakan dari
  paket yang ditulis dua rilis lalu.
- **Dipasang ke `~/.local/share/titah/extension/`**, bukan ke `node_modules`
  proyek user — extension adalah preferensi orang, bukan dependency proyek.
  Lockfile di `~/.config/titah/extension-lock.json` mengunci versi persis dan
  integrity hash, dan ia berkas yang memang ingin dibawa ke dotfiles.
- **Kegagalan tidak menjatuhkan TUI.** Panel yang melempar menampilkan pesannya
  di tempatnya; yang menggantung dibatalkan pada dua detik. Aturan yang sama
  dengan `plugin`.
- **`titah extension list|install|remove`**, dan `titah upgrade` yang MENCETAK
  perintah pemasangan alih-alih menjalankannya.

Batas yang disengaja: extension hanya sisi TUI, jadi `attach`, `serve`, dan `web`
tidak punya panel. `titah.panel` adalah satu field di antara beberapa yang
mungkin, supaya sisi server nanti jadi field baru — bukan perubahan bentuk yang
memutus config orang.

Rujukan implementasi: `@titah/extension-git`, repo terpisah, memakai hanya
permukaan publik. Index picker: `titah-dev/titah-extensions`.

### Diperbaiki

- String menu leader yang masih Bahasa Indonesia diterjemahkan. `AGENTS.md` sudah
  mewajibkan UI berbahasa Inggris; sembilan baris `LEADER_ACTIONS` tertinggal.


## [Unreleased]

## [0.2.1] — 2026-08-22

### Packaging

- Published on npm as **`titah-code`**, not `titah`. npm's typosquat filter
  rejects the shorter name as too similar to `tiag` — a `create-next-app`
  scaffold published once in March 2024 and never touched since. `titah` itself
  is unclaimed, so this is a false positive; a dispute is open with npm support.
- **The command did not change.** `bin` is still `titah`, `~/.config/titah/`
  is still the config directory, and no migration is needed. Only the install
  name moved: `npm i -g titah-code`, or `npx titah-code` for a one-off run.
- Code-identical to `titah-code@0.2.0` on the registry, which went out before
  this tag existed. This release exists so that the git tag and the published
  version finally describe the same tree — everything below shipped in `0.2.0`
  on npm despite living under `[Unreleased]` here.

### Tracking

- `tracking` — the CLI finally reports to the dashboard it has had since 0.1.0.
  titah-web's endpoints, models and pages were built and tested; nothing ever
  called them, so `/dashboard/projects/` stayed empty for everyone who signed
  in. Metadata only: name, language, git, and the figures `titah stats` already
  prints. No file contents, no transcripts, no tool output.
- Four ways off, widest first: not signed in, `tracking.enabled: false`
  globally, the same key in a project's `./titah.json`, or a path in
  `tracking.exclude`. The per-project one is free — config merging already did
  it — and travels with the repo.
- `exclude` reuses `permission.allowlist`'s matcher. One glob dialect in the
  config, not two.
- Sent after a turn, at most once per five minutes per project, and **never
  blocking or failing a turn**. The debounce lives in SQLite, not memory:
  `titah run` is one process per turn, so an in-memory window never fires
  exactly where a script runs it a hundred times.
- **Silent, succeeding or failing.** A "heartbeat sent" line would break
  `--output-format json` for the caller. One line per attempt goes to
  `~/.config/titah/tracking.log`, and `titah doctor` grew a `Tracking` section
  naming which switch is in effect.
- Defaults **on** when signed in, which is a deliberate exception to "every new
  axis is off by default": signing in is itself the opt-in, and demanding a
  second step leaves the dashboard empty for someone who already took the only
  step that looks like consent.

### Session sync

- `tracking.sync` — transcripts reach the dashboard, and it takes **two**
  switches: this one and the per-project toggle on the server. A dashboard
  toggle is remote policy; anyone who reaches the account can flip it and cannot
  edit a file on your machine.
- **Off by default**, unlike `tracking.enabled`. Signing in is consent to be
  counted, not consent to be read.
- Prompts, answers, and the *order of tool names*. Never tool arguments, never
  tool output, never reasoning. Tool output is where secrets live, and a secret
  filter you can rely on does not exist — one that catches `AKIA…` and misses an
  internal token is worse than none, because it manufactures confidence.
- 32 KB per message (the number already used for tool output) and 512 KB per
  transcript. Over that the oldest messages go, and a marker says how many: a
  silently truncated transcript looks complete.
- The server toggle is learned from the **heartbeat response**, which already
  returned it. Without that the only way to know would be attempting an upload
  and being refused — one wasted request per turn, for the life of a project
  that never turns it on. A `403` also switches the stored flag off, so it stops
  trying until told otherwise.
- Only sessions that get a turn after you switch it on go up. No backfill.
- `titah doctor` reports which of the switches is holding it.

### Fixed

- `Session.session_id` on titah-web was `max_length=36` while a Titah session id
  is `ses_` + a UUID = 40 characters. It would have failed on the first real
  upload; the column is 64 now. Trimming the prefix to fit would have been the
  wrong direction — a trimmed id matches nothing the user can look up locally.
- The tracking request timeout went from 5s to 10s. Measured: a warm request
  finishes in ~200ms, but the first HTTPS connection on a cold machine (DNS plus
  TLS) exceeded five seconds and failed silently.
- `bus.subscribe` grew `client: false` for observers. `listenerCount` decides
  auto-deny with no client attached (Q17), and it counted every subscriber — so
  a purely observing subscriber would have made `titah run` in CI stop
  auto-denying and hang waiting for an answer nobody could give.

## [0.2.0] — 2026-08-19

Two days of closing the distance to the other terminal agents, measured against
`opencode` 1.18.4 and Claude Code 2.1.233 rather than guessed. Six gaps were
written down; all six are closed here.

Nothing in 0.1.0 changed shape. Every new axis is off or absent by default,
except the turn budget — which is derived from a number you already declared.

### Structured output

- `titah run --output-format json` — one object at the end, carrying `ok`,
  `agent`, `model`, `text`, `tools` (with both `status` and `outcome`), `usage`,
  and `notices`. In json modes nothing human touches stdout.
- `--output-format stream-json` — one `Event` per line as it happens, then a
  final `{"type":"result",…}`. Deliberately not a new format: it is Titah's own
  event union, so a second shape cannot drift from the first.
- `--json-schema <file>` — requires the answer to be JSON matching a **subset**
  of JSON Schema (`type`, `required`, `properties`, `items`, `enum`). Unknown
  keywords are skipped, not failed. Asked for in the prompt and checked locally,
  because most openai-compatible endpoints have no native structured output.
- Exit codes split: `0` done, `1` the turn failed, `2` the answer was the wrong
  shape. The fixes are different, so the codes are too.

### Cost and limits

- `titah stats [--since 7d] [--all]` — tokens and cost by model and by day.
  Titah has recorded per-turn usage since the first version and never had a way
  to read it back; 30.2M tokens were sitting in one database unreadable.
- `provider.<p>.models.<m>.price` — per 1M tokens, **declared, never guessed**.
  Titah ships no price table: prices change by region and contract, and a stale
  table produces numbers that look official and are wrong. Unpriced models still
  have their tokens counted and are named separately rather than counted free.
- `limits.turnTokens` — a token budget for one turn, replacing step count as the
  real bound. **Defaults to 5× the model's `contextWindow`.** Declaring a window
  also lifts the step ceiling from 40 to 200.
- `limits.sessionTokens` — a budget across every turn in a session. Checked
  before a turn starts, never mid-turn: a turn stopped halfway leaves edited
  files and unrun tests.
- `limits.continueTurns` — continue automatically after a limit while the plan
  still has unchecked `- [ ]` items. A loop of bounded turns, not one unbounded
  turn: a fresh turn starts on a clean transcript and re-reads the whole plan.
  Default `0`.

### Hooks

- `hooks."tool.before"` and `hooks."tool.after"` — shell commands at the same
  hook points plugins already use, for rules that do not deserve an npm package.
  `match` is a regex over the tool name; the event arrives on stdin as JSON.
- `tool.before` refuses the call on a non-zero exit, and a hook that fails to
  run or hangs also refuses. `tool.after` cancels nothing but appends its stderr
  to the **tool output**, so the model learns the formatter failed.
- `titah hooks list` names invalid regexes explicitly — a hook silent because
  its pattern is broken looks exactly like a hook that did not match.

### Background turns

- `titah run --bg` detaches and returns the terminal immediately.
- `titah bg list` / `logs <id> [-f]` / `stop <id>`. There is no stored status
  column: the state is asked of the operating system on every read. `logs -f`
  stops on its own when the turn ends. `stop` kills the whole process group.

### Web client

- `titah web` starts the server and opens a browser client. **No new routes** —
  it uses exactly the API the TUI uses, embedded as a string with no build step.
- Permission requests and questions are answered on the page. Without that it
  would only be a reader, and every turn touching a file would hang.
- `/` serves HTML to browsers and JSON to everything else; `/health` stays JSON.

### Sandbox

- `sandbox.bash` — runs bash commands under Seatbelt (macOS) or bubblewrap
  (Linux). Reads stay free; **writes** are confined to the project and temp.
  This closes the one hole the permission axes cannot: `bash` never passes
  through the `delete` axis.
- **Fails closed.** Enabled where no sandbox exists, `bash` is refused rather
  than run unfenced. `titah doctor` reports which state you are in.
- Off by default. Verified on macOS/seatbelt; the bubblewrap path is written but
  has not been run on Linux yet.

### Agents, prompts, and defaults

- `delegation` (`ask` | `auto` | `always` | `never`) plus four prompt fixes.
  Delegation was measured at 1 call in 5 before, 2 in 2 with `always` after —
  the tool inventory never listed `task`, and `build` said to work "directly".
- Sub-agents inherit the **parent's** permission instead of falling back to
  global. `build-auto` used to promise no confirmations and then ask for `ls`
  through every sub-agent it spawned.
- `agent.<id>.effort` (`low` | `medium` | `high`) — how much closing analysis an
  answer ends with. Unset means the model decides. Cycle it live with `ctrl+r`.
- Every answer now ends with a conclusion: what changed, what is verified, what
  is still open. Skipped where there is nothing to conclude.
- `build` and `build-auto` ask before decisions that shape everything after —
  which datastore, how auth works, REST or GraphQL — with a recommendation and
  the reason drawn from the code just read. Measured 3/3 on a datastore choice
  and 0/3 on a trivial one.
- Turns that stop at a limit say so, to the model and to you. Measured: 13.2% of
  real turns were hitting the old 20-step wall silently.
- `instructions` accepts a string, `{ "path": … }`, or an array of either, and
  missing files are created on the first turn of a session. A starter
  `AGENTS.md` is written for projects with no instruction file at all.
- `scaffold: false` turns all of that off.

### Fixed

- `TITAH.md` lost to `AGENTS.md` in the same directory. The flat result list was
  reversed, which also reversed the order *within* a directory — so the file
  whose whole purpose is to override was read first and therefore lost.
- `titah run` dropped every `session.notice`: no case for it, so context-window
  warnings, loop detection, and limit notices were invisible outside the TUI.
- The TUI's step spinner and the running-step glyph now differ in kind, not just
  shape, so two animations on screen are told apart without being read.
- Answers are marked with the agent that produced them, and the working
  indicator names the agent actually running — which is not always the one the
  footer shows after you press Tab mid-turn.

### Notes

- Linux and macOS. Windows is still unsupported, and the sandbox is macOS-only
  in practice until the bubblewrap path is exercised.
- Requires Node.js ≥ 22.6.

## [0.1.0] — 2026-08-19

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
