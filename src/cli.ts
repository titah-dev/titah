#!/usr/bin/env node
// HARUS yang pertama: modul ESM dievaluasi urut, dan peringatan `node:sqlite`
// tercetak begitu modulnya dimuat oleh salah satu impor di bawah.
import "./quiet.ts"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { isExplicit, loadConfig, redact, ConfigError } from "./core/config.ts"
import type { Json } from "./core/config.ts"
import {
  BundleError,
  exportBundle,
  mergeConfig,
  parseBundle,
  planImport,
} from "./core/portable.ts"
import { loadPlugins } from "./core/plugin.ts"
import { collectStats } from "./core/stats.ts"
import { available as sandboxAvailable } from "./core/sandbox.ts"
import {
  alive,
  findBackground,
  listBackground,
  pruneBackground,
  spawnBackground,
  stopBackground,
} from "./core/background.ts"
import {
  applySchema,
  isOutputFormat,
  OUTPUT_FORMATS,
  schemaInstruction,
  streamLine,
  turnResult,
  type OutputFormat,
} from "./core/output.ts"
import { EXAMPLE_EXTERNAL_AGENTS } from "./core/schema.ts"
import {
  authorizationUrl,
  createPkce,
  discover,
  exchangeCode,
  forgetToken,
  loopback,
  openBrowser,
  randomState,
  registerClient,
  validToken,
  writeToken,
} from "./core/mcp-oauth.ts"
import { checkPermissions, readAuth, removeCredential, setCredential } from "./core/auth.ts"
import {
  AccountError,
  accountServer,
  checkAccountPermissions,
  chooseAnonymous,
  currentAccount,
  fetchUserInfo,
  formatUserCode,
  hasChosen,
  login,
  normaliseServer,
  revokeToken,
  signOut,
  type DeviceAuthorization,
} from "./core/account.ts"
import {
  listModels,
  resolveCredential,
  smallModelWindowMissing,
  undeclaredContextWindows,
  ProviderError,
} from "./core/provider.ts"
import { effectiveReserved, reservedCollisions } from "./core/compact.ts"
import { which } from "./core/which.ts"
import {
  authFile,
  globalConfigFile,
  projectConfigFile,
  dataDir,
  sessionDbFile,
} from "./core/paths.ts"
import { listen } from "./server/index.ts"
import { bus } from "./core/event.ts"
import { prompt, AgentError } from "./core/agent.ts"
import { decide, parseRule, type Policy } from "./core/decide.ts"
import { commandSegments } from "./core/tool/bash.ts"
import {
  effectivePermission,
  neverMatchingAllowlistEntries,
  respond,
  type PermissionDecision,
  type PermissionRequest,
} from "./core/permission.ts"
import { undo, UndoError } from "./core/undo.ts"
import { gitAvailable, SnapshotError } from "./core/snapshot.ts"
import {
  buildConfig,
  detectFromEnv,
  isConfigured,
  probeLocal,
  writeOnboarding,
  type ProviderChoice,
} from "./core/onboarding.ts"
import { formatBytes, prune } from "./core/retention.ts"
import { renderSkillReport } from "./core/skill.ts"
import {
  createSession,
  deleteSession,
  listSessions,
  pruneSessions,
} from "./core/storage/session.ts"

// `titah models | head -3` menutup stdout lebih dulu. Tanpa ini, Node melempar
// EPIPE beserta stack trace — pipe ke head/less adalah pemakaian normal, bukan
// error yang layak ditampilkan ke user.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0)
    throw error
  })
}

const VERSION: string = (() => {
  const file = path.join(import.meta.dirname, "..", "package.json")
  const pkg: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  return (pkg as { version?: string }).version ?? "0.0.0"
})()

const HELP = `titah ${VERSION} — a coding agent that can call other agents

Usage:
  titah <command> [options]

Session:
  (no arguments)           Open the interactive TUI
  attach <url>             Open the TUI against an already running server
  run <prompt>             Run a single turn and stream the answer
  undo                     Revert the changes of the last turn
  serve                    Run the headless server (HTTP + SSE)
  web [--port <n>]         Start the server and open the browser client
  sessions list            List stored sessions
  stats [--since <age>]    Tokens and cost so far, by model and by day
  sessions prune           Delete old sessions + orphaned blobs & snapshots

Account:
  login                    Sign in to your Titah account through the browser
  logout                   Sign out and revoke this machine's token
  whoami                   Show who this machine is signed in as

Configuration:
  init [-y]                First-time setup (auto-detect + wizard)
  config path              Show config, auth, and data locations
  config show              Show the merged config (credentials redacted)
  export [-o <file>]       Write a portable config bundle (no credentials) to stdout or a file
  import <file> [-y]       Show what a bundle would change; -y applies it
  plugin list              Load the configured plugins and report what each provides
  hooks list               Shell hooks from config, and which tools each matches
  bg list                  Background turns, and whether each is still running
  bg logs <id> [-f]        Read what a background turn has written so far
  bg stop <id>             Stop a background turn and everything it started
  mcp list                 Configured MCP servers, their transport, and sign-in state
  mcp login <server>       Sign in to a remote MCP server with OAuth
  mcp logout <server>      Forget a remote server's stored token
  auth list                Providers and where their credentials come from
  auth set <provider>      Store an API key in auth.json (mode 0600), read from stdin
  auth remove <provider>   Remove a provider's credentials
  models                   List configured models
  doctor                   Check environment, config, and external agents
  permission explain <kind> [argument]
                           Show what a call would be allowed to do, and which rule decides

Options:
  -v, --version            Print the version
  -h, --help               Print this help
  -m, --model <id>         Model override, in "provider/model" form
  -a, --agent <name>       Run with a specific internal agent
  -s, --session <id>       Continue an existing session (run)
      --port <n>           Server port (serve), random by default
      --hostname <h>       Server hostname (serve), 127.0.0.1 by default
      --older-than <age>   Age cutoff for prune, e.g. 30d / 12h
      --since <age>        (stats) Only count this far back, e.g. 7d / 24h
      --all                sessions list / stats: every project, not just this folder
      --server <url>       (login) Account server, overriding config and $TITAH_ACCOUNT_SERVER
      --no-browser         (login) Print the URL instead of opening a browser
      --auto               (run) Auto-approve permissions not denied by config
      --bg                 (run) Detach and return immediately; follow with \`titah bg\`
      --output-format <f>  (run) text (default) | json | stream-json
      --json-schema <file> (run) Require the answer to be JSON matching this schema
  -y, --yes                (init) Use the first detected provider, no questions
      --probe              (doctor) Also test network reachability per provider

In-session commands:
  /login  /logout  /account     Sign in, sign out, or show the current account
  /consensus <question>    Fan out to every external agent and compare
  /tim <task>              Split one task across your sub-agents
  /compact [focus]         Summarise the session so far to free up context
  /model  /agent           Switch model or agent (TUI only)
  /session  /new           Resume a previous session, or start a new one (TUI only)
  /skill                   Insert a skill into your prompt (TUI only)
  /agents  /skills  /commands   List what is available
  /exit                    Quit Titah
  /<name> <input>          Custom command from your config

  Undo is not a slash command: ctrl+x u in the TUI, or "titah undo".

Delegation:
  Type "@claude <prompt>" or "@opencode <prompt>" as an ordinary prompt.
  The answer lands in your session; the next "@claude" resumes the same session.

See DESIGN.md for the milestone plan.`

function fail(message: string): never {
  process.stderr.write(`titah: ${message}\n`)
  process.exit(1)
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`)
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      probe: { type: "boolean" },
      model: { type: "string", short: "m" },
      session: { type: "string", short: "s" },
      port: { type: "string" },
      hostname: { type: "string" },
      "older-than": { type: "string" },
      all: { type: "boolean" },
      auto: { type: "boolean" },
      agent: { type: "string", short: "a" },
      yes: { type: "boolean", short: "y" },
      server: { type: "string" },
      out: { type: "string", short: "o" },
      "no-browser": { type: "boolean" },
      "output-format": { type: "string" },
      "json-schema": { type: "string" },
      since: { type: "string" },
      bg: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
    },
  })

  if (values.version === true) return out(VERSION)
  if (values.help === true) return out(HELP)

  // `titah` tanpa argumen membuka TUI (Q5): server lokal di-spawn lalu di-attach.
  if (positionals.length === 0) {
    return cmdTui({
      ...(typeof values.model === "string" ? { model: values.model } : {}),
      ...(typeof values.session === "string" ? { sessionID: values.session } : {}),
    })
  }

  const [command, ...rest] = positionals

  switch (command) {
    case "config":
      return cmdConfig(rest)
    case "export":
      return cmdExport(typeof values.out === "string" ? values.out : undefined)
    case "import":
      return cmdImport(rest[0], values.yes === true)
    case "plugin":
    case "plugins":
      return cmdPlugin(rest)
    case "mcp":
      return cmdMcp(rest, values["no-browser"] !== true)
    case "auth":
      return cmdAuth(rest)
    case "models":
      return cmdModels()
    case "permission": {
      process.exitCode = cmdPermission(rest)
      return
    }
    case "doctor":
      return cmdDoctor(values.probe === true)
    case "serve":
      return cmdServe(
        values.port === undefined ? 0 : Number(values.port),
        typeof values.hostname === "string" ? values.hostname : "127.0.0.1",
      )
    case "run": {
      const format = typeof values["output-format"] === "string" ? values["output-format"] : "text"
      if (!isOutputFormat(format)) {
        fail(`unknown --output-format "${format}". Use one of: ${OUTPUT_FORMATS.join(", ")}`)
      }
      return cmdRun(rest.join(" "), {
        auto: values.auto === true,
        background: values.bg === true,
        format,
        ...(typeof values.model === "string" ? { model: values.model } : {}),
        ...(typeof values.agent === "string" ? { agent: values.agent } : {}),
        ...(typeof values.session === "string" ? { session: values.session } : {}),
        ...(typeof values["json-schema"] === "string" ? { schemaPath: values["json-schema"] } : {}),
      })
    }
    case "web":
      return cmdWeb(values.port === undefined ? 0 : Number(values.port))
    case "hooks":
      return cmdHooks()
    case "bg":
      return cmdBackground(rest, { follow: values.follow === true })
    case "stats":
      return cmdStats({
        all: values.all === true,
        ...(typeof values.since === "string" ? { since: values.since } : {}),
      })
    case "login":
      return cmdLogin({
        ...(typeof values.server === "string" ? { server: values.server } : {}),
        browser: values["no-browser"] !== true,
      })
    case "logout":
      return cmdLogout()
    case "whoami":
      return cmdWhoami()
    case "init":
      return cmdInit(values.yes === true)
    case "undo":
      return cmdUndo(typeof values.session === "string" ? values.session : undefined)
    case "attach":
      if (!rest[0]) fail("usage: titah attach <url>")
      return cmdTui({
        attach: rest[0],
        ...(typeof values.model === "string" ? { model: values.model } : {}),
        ...(typeof values.session === "string" ? { sessionID: values.session } : {}),
      })
    case "sessions":
      return cmdSessions(
        rest,
        typeof values["older-than"] === "string" ? values["older-than"] : undefined,
        values["all"] === true,
      )
    default:
      fail(`unknown command: "${command}". Run \`titah --help\`.`)
  }
}

function cmdConfig(args: string[]): void {
  const sub = args[0] ?? "path"

  if (sub === "path") {
    const rows: [string, string][] = [
      ["global config", globalConfigFile()],
      ["project config", projectConfigFile()],
      ["auth", authFile()],
      ["data", dataDir()],
      ["session db", sessionDbFile()],
    ]
    for (const [label, value] of rows) {
      out(`${label.padEnd(15)} ${value}${fs.existsSync(value) ? "" : "  (not yet)"}`)
    }
    return
  }

  if (sub === "show") {
    const loaded = loadConfig()
    if (loaded.sources.length === 0) {
      process.stderr.write("titah: no config file; showing defaults.\n\n")
    } else {
      process.stderr.write(`titah: sources → ${loaded.sources.join(" → ")}\n\n`)
    }
    out(JSON.stringify(redact(loaded.config), null, 2))
    return
  }

  fail(`Unknown config subcommand: "${sub}". Options: path, show.`)
}

/**
 * Mengekspor config yang bisa dipasang di mesin lain.
 *
 * Yang keluar adalah yang user TULIS, bukan config yang sudah dilengkapi nilai
 * bawaan — alasannya ada di portable.ts, dan ia menentukan: mengekspor bawaan
 * berarti membekukannya, dan mesin yang mengimpor tidak akan pernah ikut ketika
 * Titah mengubahnya nanti.
 */
function cmdExport(outFile: string | undefined): void {
  const loaded = loadConfig()
  const bundle = exportBundle(loaded.raw, VERSION, new Date())
  const text = `${JSON.stringify(bundle, null, 2)}\n`

  if (outFile === undefined) {
    // Ke stdout supaya bisa disalurkan: `titah export | ssh lain "titah import -"`.
    process.stdout.write(text)
  } else {
    fs.writeFileSync(outFile, text)
    process.stderr.write(`titah: wrote ${outFile}\n`)
  }

  if (loaded.sources.length === 0) {
    process.stderr.write("titah: no config file was found; the bundle carries defaults only.\n")
  }

  /*
   * Rahasia yang dibuang DISEBUTKAN, bukan didiamkan.
   *
   * Orang yang memasang bundel ini di mesin lain harus tahu persis apa yang
   * masih harus ia isi sendiri. Menemukannya sebagai kegagalan pada giliran
   * pertama jauh lebih mahal daripada membacanya di sini.
   */
  if (bundle.secretsDropped.length > 0) {
    process.stderr.write(
      `titah: ${bundle.secretsDropped.length} secret(s) left out — set them on the other machine:\n`,
    )
    for (const path of bundle.secretsDropped) process.stderr.write(`  ${path}\n`)
    process.stderr.write("  (use `titah auth set <provider>`, or \"${env:VAR}\" in the config)\n")
  }
}

/**
 * Memasang bundel ke config global, setelah memperlihatkan apa yang berubah.
 *
 * Bundelnya MENANG per kunci daun tapi tidak menghapus apa pun yang tidak ia
 * sebut — impor yang mengganti seluruh berkas akan membuang kredensial lokal
 * yang justru sengaja tidak ikut diekspor.
 */
function cmdImport(source: string | undefined, yes: boolean): void {
  if (source === undefined) {
    fail("Usage: titah import <bundle.json> [-y]. Produce one with `titah export`.")
  }
  if (!fs.existsSync(source)) fail(`No such file: ${source}`)

  let bundle
  try {
    bundle = parseBundle(fs.readFileSync(source, "utf8"))
  } catch (error) {
    fail(error instanceof BundleError ? error.message : String(error))
  }

  const target = globalConfigFile()
  const current: Json = fs.existsSync(target)
    ? (JSON.parse(fs.readFileSync(target, "utf8")) as Json)
    : {}

  const changes = planImport(current, bundle.config)
  out(`Bundle from titah ${bundle.titah}, exported ${bundle.exportedAt}.`)

  if (changes.length === 0) {
    out("Nothing to change — your config already matches it.")
    return
  }

  out(`\n${changes.length} key(s) would change in ${target}:\n`)
  for (const change of changes) {
    const before = change.before === undefined ? "(unset)" : JSON.stringify(change.before)
    out(`  ${change.path}\n    ${before}  →  ${JSON.stringify(change.after)}`)
  }

  if (bundle.secretsDropped.length > 0) {
    out(`\nThe bundle carries no credentials. Still to set here:`)
    for (const path of bundle.secretsDropped) out(`  ${path}`)
  }

  if (!yes) {
    /*
     * Tanpa `-y` tidak ada yang ditulis, dan itu berlaku juga di terminal.
     *
     * Menanyakan y/n secara interaktif berarti perilakunya berbeda antara
     * terminal dan pipa — dan yang kedua justru tempat impor paling sering
     * dijalankan (skrip provisioning, Dockerfile). Satu jalur, satu perilaku.
     */
    out("\nNothing written. Re-run with -y to apply.")
    return
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(mergeConfig(current, bundle.config), null, 2)}\n`)
  out(`\nWrote ${target}.`)
}

/**
 * Memperlihatkan plugin yang benar-benar termuat, dan yang gagal.
 *
 * Memuatnya SUNGGUHAN, bukan sekadar membaca config. Plugin yang tertulis di
 * config tapi tidak bisa di-`import` terlihat sama saja dengan yang bekerja
 * kalau yang dicetak hanya daftar dari berkas — dan justru selisih itu yang
 * dicari orang ketika kaitnya tidak berjalan.
 */
async function cmdPlugin(args: string[]): Promise<void> {
  const sub = args[0] ?? "list"
  if (sub !== "list") fail(`Unknown plugin subcommand: "${sub}". Options: list.`)

  const loaded = loadConfig()
  const specs = Object.keys(loaded.config.plugin)
  if (specs.length === 0) {
    out("No plugins configured.")
    out("")
    out("A plugin is an npm module or a local file that customises behaviour —")
    out("hooks that run before and after every tool call. Declare one like this:")
    out('  {"plugin": {"@acme/titah-audit": {"options": {"file": "audit.log"}}}}')
    out("")
    out("Plugins run in this process with no sandbox, so naming one is the same")
    out("trust decision as npm install. Nothing is ever discovered automatically.")
    return
  }

  const { plugins, failures } = await loadPlugins(loaded.config, process.cwd())

  for (const plugin of plugins) {
    const hooks = (["tool.before", "tool.after"] as const).filter((key) => plugin.hooks[key])
    out(`✓ ${plugin.spec}`)
    out(`    name    ${plugin.name}`)
    out(`    source  ${plugin.source.kind}`)
    out(`    hooks   ${hooks.length > 0 ? hooks.join(", ") : "(none — it does nothing)"}`)
  }

  for (const failure of failures) {
    out(`✗ ${failure.spec}`)
    for (const line of failure.reason.split("\n")) out(`    ${line}`)
  }

  const disabled = specs.length - plugins.length - failures.length
  if (disabled > 0) out(`\n${disabled} disabled with "enabled": false.`)
}

/**
 * Login OAuth ke satu server MCP remote.
 *
 * Alirannya authorization code + PKCE lewat loopback, karena itu yang
 * ditetapkan spesifikasi MCP — bukan device flow yang dipakai akun Titah
 * sendiri. Konsekuensinya jujur disebutkan di bawah: loopback butuh browser di
 * MESIN INI, dan di dalam SSH atau container itu tidak ada.
 */
async function cmdMcp(args: string[], browser: boolean): Promise<void> {
  const sub = args[0] ?? "list"
  const loaded = loadConfig()

  if (sub === "list") {
    const entries = Object.entries(loaded.config.mcp)
    if (entries.length === 0) return out("No MCP servers configured.")
    for (const [id, entry] of entries) {
      const where = entry.url ?? `${entry.command} ${entry.args.join(" ")}`.trim()
      const auth = entry.url === undefined ? "" : entry.oauth ? (validToken(id) ? "  signed in" : "  needs login") : "  static"
      out(`${entry.enabled === false ? "·" : "✓"} ${id.padEnd(14)} ${entry.url ? "http" : "stdio"}  ${where}${auth}`)
    }
    return
  }

  if (sub === "logout") {
    const id = args[1]
    if (!id) fail("Usage: titah mcp logout <server>")
    out(forgetToken(id) ? `Forgot the token for "${id}".` : `No stored token for "${id}".`)
    return
  }

  if (sub !== "login") fail(`Unknown mcp subcommand: "${sub}". Options: list, login, logout.`)

  const id = args[1]
  if (!id) fail("Usage: titah mcp login <server>")
  const entry = loaded.config.mcp[id]
  if (!entry) fail(`No MCP server named "${id}" in the config.`)
  if (entry.url === undefined) fail(`"${id}" is a stdio server — it has nothing to sign in to.`)

  const metadata = await discover(entry.url)
  const pkce = createPkce()
  const state = randomState()
  const handle = await loopback(state)

  try {
    const clientId = await registerClient(metadata, handle.redirectUri)
    const url = authorizationUrl({
      metadata,
      clientId,
      redirectUri: handle.redirectUri,
      pkce,
      state,
      resource: entry.url,
      ...(metadata.scopes_supported ? { scope: metadata.scopes_supported.join(" ") } : {}),
    })

    const opened = browser && openBrowser(url)
    process.stderr.write(
      opened
        ? `titah: opened your browser to sign in to "${id}".\n`
        : `titah: open this URL to sign in to "${id}":\n\n  ${url}\n\n`,
    )
    /*
     * Disebut apa adanya, karena ia batas nyata: redirect ke 127.0.0.1 mengarah
     * ke loopback MESIN YANG MENJALANKAN BROWSER. Lewat SSH itu mesin yang
     * berbeda, dan halamannya akan gagal dimuat tanpa menjelaskan kenapa.
     */
    process.stderr.write("titah: the redirect lands on this machine — forward the port if you are over SSH.\n")

    const code = await handle.code
    const token = await exchangeCode({
      metadata,
      clientId,
      redirectUri: handle.redirectUri,
      code,
      verifier: pkce.verifier,
      resource: entry.url,
    })

    writeToken(id, token)
    out(`Signed in to "${id}".`)
    if (token.expiresAt !== undefined) {
      out(
        token.refreshToken
          ? "The token expires, and Titah refreshes it automatically."
          : "The token expires and no refresh token was issued — you will need to sign in again.",
      )
    }
  } finally {
    handle.close()
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

async function cmdAuth(args: string[]): Promise<void> {
  const sub = args[0] ?? "list"

  if (sub === "list") {
    const { config } = loadConfig()
    const providers = Object.entries(config.provider)
    if (providers.length === 0) return out("No providers configured yet.")
    for (const [id, provider] of providers) {
      const { source } = resolveCredential(id, provider)
      const label = source === "none" ? "no credentials" : `from ${source}`
      out(`${id.padEnd(20)} ${provider.npm.padEnd(30)} ${label}`)
    }
    const perms = checkPermissions()
    if (perms) {
      process.stderr.write(
        `\ntitah: WARNING — ${perms.file} has mode ${perms.mode}, should be 600.\n`,
      )
    }
    return
  }

  if (sub === "set") {
    const providerId = args[1]
    if (!providerId) fail("usage: titah auth set <provider>  (key is read from stdin)")
    if (process.stdin.isTTY) {
      process.stderr.write(`Paste the API key for "${providerId}", then Ctrl-D:\n`)
    }
    const key = await readStdin()
    if (!key) fail("no key was read from stdin.")
    setCredential(providerId, key)
    out(`Stored in ${authFile()} (mode 0600).`)
    return
  }

  if (sub === "remove") {
    const providerId = args[1]
    if (!providerId) fail("usage: titah auth remove <provider>")
    out(
      removeCredential(providerId)
        ? `Credentials for "${providerId}" removed.`
        : `No stored credentials for "${providerId}".`,
    )
    return
  }

  fail(`Unknown auth subcommand: "${sub}". Options: list, set, remove.`)
}

function cmdModels(): void {
  const { config } = loadConfig()
  const models = listModels(config)
  if (models.length === 0) {
    return out("No models configured. Add a `provider` block to titah.json.")
  }
  for (const model of models) {
    const marker = model.isDefault ? "*" : " "
    const cred = model.credential === "none" ? "  (no credentials)" : ""
    const name = model.displayName ? `  — ${model.displayName}` : ""
    out(`${marker} ${model.id}${name}${cred}`)
  }
  if (!config.model) {
    process.stderr.write("\ntitah: no default model. Set `model` in titah.json.\n")
  }
}

async function probe(baseURL: string): Promise<string> {
  const url = new URL("models", baseURL.endsWith("/") ? baseURL : `${baseURL}/`)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return `HTTP ${response.status}`
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError"
      ? "timeout"
      : "unreachable"
  }
}

/**
 * `titah permission explain <kind> [argument]`
 *
 * Wajib ada, bukan pemanis. Dengan enam sakelar user bisa memegang postur
 * keamanannya di kepala; dengan tiga dimensi ia tidak bisa. Presisi yang tidak
 * bisa diaudit hanyalah rasa aman.
 *
 * Ia memanggil `decide()` yang SAMA dengan yang dipakai `ask()` saat giliran
 * berjalan — bukan salinan yang menjelaskan. Penjelas yang punya logikanya
 * sendiri akan menyimpang, dan yang menyimpang justru dipercaya.
 */
function cmdPermission(argv: string[]): number {
  const [action, kind, ...rest] = argv
  if (action !== "explain" || kind === undefined) {
    process.stderr.write('Usage: titah permission explain <kind> [argument]\n')
    process.stderr.write('  e.g. titah permission explain bash "git push origin main"\n')
    process.stderr.write("       titah permission explain network https://example.com/a\n")
    return 1
  }

  const loaded = loadConfig(process.cwd())
  const effective = effectivePermission(loaded.config)
  const classPolicy = (effective as unknown as Record<string, Policy>)[kind]
  if (classPolicy === undefined) {
    process.stderr.write(`Unknown permission kind: ${kind}\n`)
    return 1
  }

  const argument = rest.join(" ")
  // bash dinilai PER SEGMEN, sama seperti saat sungguhan. Menjelaskan perintah
  // berantai sebagai satu kesatuan akan memberi jawaban yang berbeda dari yang
  // akan terjadi — persis kegagalan yang perintah ini ada untuk mencegahnya.
  const candidates =
    kind === "bash"
      ? (commandSegments(argument) ?? []).map((value) => ({ value }))
      : argument === ""
        ? []
        : [{ value: argument }]

  const rules = [
    ...effective.rules,
    ...effective.allowlist.map((pattern) => parseRule(`bash(${pattern})`, "allow")),
  ]
  const verdict = decide({ kind, classPolicy, rules, candidates })

  const out = (line = "") => process.stdout.write(`${line}\n`)
  out(`${kind}${argument === "" ? "" : `: ${argument}`}`)
  out()
  out(`  class policy   ${kind} = "${classPolicy}"`)
  if (kind === "bash") {
    out(
      `  segments       ${candidates.length === 0 ? "(none — cannot be judged, so never auto-allowed)" : candidates.map((c) => JSON.stringify(c.value)).join(", ")}`,
    )
  }
  out(`  decided by     ${verdict.rule ? `rule "${verdict.rule.source}"` : "the class policy"}`)
  for (const other of verdict.alsoMatched) {
    out(`  also matched   "${other.source}" = ${other.policy} (less specific)`)
  }
  out()
  out(`  → ${verdict.policy.toUpperCase()}`)
  out(`    ${verdict.reason}`)
  if (verdict.policy === "ask") {
    out("    With no client connected (headless, CI), an ask becomes a deny.")
  }
  return 0
}

async function cmdDoctor(withProbe: boolean): Promise<void> {
  out(`titah ${VERSION}`)
  out(`node  ${process.version} · ${process.platform}/${process.arch}`)
  out()

  let loaded
  try {
    loaded = loadConfig()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  out("Config")
  if (loaded.sources.length === 0) {
    out("  no config file — using defaults")
  } else {
    for (const source of loaded.sources) out(`  ${source}`)
  }
  for (const missing of loaded.missingEnv) {
    out(`  ! \${env:${missing.variable}} is not set (used at ${missing.at})`)
  }
  out()

  out("Credentials")
  const perms = checkPermissions()
  if (perms) out(`  ! ${perms.file} has mode ${perms.mode}, should be 600`)
  const stored = Object.keys(readAuth())
  out(`  auth.json: ${stored.length === 0 ? "empty" : stored.join(", ")}`)
  out()

  out("Account")
  const accountPerms = checkAccountPermissions()
  if (accountPerms) out(`  ! ${accountPerms.file} has mode ${accountPerms.mode}, should be 600`)
  const account = currentAccount()
  if (!account) {
    out(
      hasChosen()
        ? "  not signed in (chosen) — `titah login` to sign in"
        : "  not signed in — you will be asked once when you next open the TUI",
    )
    out(`  server: ${accountServer(loaded.config)}`)
  } else {
    out(`  signed in as ${account.user.email}`)
    out(`  server: ${account.server}`)
    out(`  device: ${account.deviceName}`)
    if (withProbe) {
      // Hanya dengan --probe: doctor tanpa jaringan harus tetap selesai cepat,
      // dan ini satu-satunya baris di sini yang butuh server hidup.
      try {
        const user = await fetchUserInfo(account)
        out(`  verified: yes, as ${user.email}`)
      } catch (error) {
        out(`  verified: NO — ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      out("  verified: not checked (pass --probe)")
    }
  }
  out()

  out("Providers")
  const providers = Object.entries(loaded.config.provider)
  if (providers.length === 0) out("  no providers configured")
  for (const [id, provider] of providers) {
    const { source } = resolveCredential(id, provider)
    const baseURL = provider.options?.baseURL
    const reach = withProbe && baseURL ? `  ${await probe(baseURL)}` : ""
    out(`  ${id.padEnd(18)} ${(baseURL ?? provider.npm).padEnd(46)} key: ${source}${reach}`)
  }
  out()

  out("Context windows")
  const undeclared = undeclaredContextWindows(loaded.config)
  if (undeclared.length === 0) {
    out("  all configured models declare one")
  } else {
    for (const id of undeclared) {
      const slash = id.indexOf("/")
      const providerId = id.slice(0, slash)
      const modelId = id.slice(slash + 1)
      out(`  ! ${id} — no contextWindow, automatic compaction is off for it`)
      out(`      add provider.${providerId}.models."${modelId}".contextWindow`)
    }
  }
  // `smallModel` dilaporkan TERPISAH dari daftar di atas, walau modelnya juga
  // muncul di sana: yang dibatasi jendela ini adalah prompt PERINGKAS, dan
  // akibat hilangnya berbeda dari model giliran. Model giliran tanpa jendela
  // berarti pemadatan otomatis mati; peringkas tanpa jendela berarti batasnya
  // jatuh ke jendela model giliran — masih aman, tapi lebih longgar dari yang
  // user maksud, dan tanpa disebutkan ia tidak punya cara mengetahuinya.
  const smallMissing = smallModelWindowMissing(loaded.config)
  if (smallMissing !== undefined) {
    out(
      `  ! smallModel ${smallMissing} — no contextWindow; the summariser's prompt is ` +
        "bounded by the turn model's window instead",
    )
  }
  // Angka yang dilaporkan HARUS lewat `effectiveReserved`, bukan aritmetika
  // sendiri — dua rumus yang seharusnya sama bisa diam-diam menyimpang begitu
  // RESERVE_FRACTION berubah, dan doctor lalu melaporkan angka yang salah
  // sambil terlihat baik-baik saja.
  //
  // `!` HANYA untuk angka yang user tulis sendiri. Bawaan 8192 lebih besar dari
  // seperempat SETIAP jendela di bawah 32768, jadi tanpa pembedaan ini doctor
  // menandai temuan pada config yang bahkan tidak punya blok `compaction` —
  // dan satu-satunya yang user pelajari adalah bahwa Titah tidak menyetujui
  // bawaannya sendiri.
  const reservedSet = isExplicit(loaded, ["compaction", "reserved"])
  for (const clash of reservedCollisions(loaded.config)) {
    const capped = effectiveReserved(clash.contextWindow, clash.reserved)
    out(
      reservedSet
        ? `  ! ${clash.model} — compaction.reserved (${clash.reserved}) exceeds a quarter of ` +
            `this ${clash.contextWindow}-token window; using ${capped}`
        : `  ${clash.model} — the default compaction.reserved (${clash.reserved}) exceeds a ` +
            `quarter of this ${clash.contextWindow}-token window; using ${capped}. Nothing to fix.`,
    )
  }
  out()

  // Hanya dirender kalau user memang memakai allowlist. Bagian yang selalu
  // berbunyi "0 entri" pada config yang tidak punya allowlist cuma menambah
  // baris yang tidak pernah berubah.
  const allowlists: { where: string; entries: string[] }[] = [
    { where: "permission.allowlist", entries: loaded.config.permission.allowlist },
    ...Object.entries(loaded.config.agent)
      .map(([id, agent]) => ({
        where: `agent.${id}.permission.allowlist`,
        entries: agent.permission?.allowlist ?? [],
      }))
      .filter((entry) => entry.entries.length > 0),
  ].filter((entry) => entry.entries.length > 0)

  if (allowlists.length > 0) {
    out("Bash allowlist")
    let dead = 0
    for (const { where, entries } of allowlists) {
      // Pencocokan berjalan per segmen perintah, dan segmen tidak pernah
      // mengandung operator shell — jadi entri yang mengandungnya tidak akan
      // pernah menyala. Diam soal ini persis kegagalan yang issue #12 catat.
      for (const entry of neverMatchingAllowlistEntries(entries)) {
        dead += 1
        out(`  ! ${where}: "${entry}" can never match — it contains a shell operator`)
        out("      allowlist entries are matched against one command at a time")
      }
    }
    if (dead === 0) {
      const total = allowlists.reduce((sum, entry) => sum + entry.entries.length, 0)
      out(`  ${total} ${total === 1 ? "entry" : "entries"}, all of them matchable`)
    }
    out("  each part of a chained command must match on its own")
    out()
  }

  out("Web search")
  {
    const search = loaded.config.search
    const needsKey = search.backend !== "ddg"
    const hasKey = (search.apiKey ?? "") !== ""
    if (needsKey && !hasKey) {
      out(`  ! backend ${search.backend} needs an API key, and none is set`)
      out("      set search.apiKey, or switch search.backend to \"ddg\"")
    } else if (search.backend === "ddg") {
      // Kerapuhannya dinyatakan, bukan disembunyikan: backend yang diam-diam
      // berhenti bekerja lebih buruk daripada yang menyatakan dirinya rapuh.
      out("  ddg — no API key needed; it scrapes HTML, so it can break without warning")
    } else {
      out(`  ${search.backend} — API key present`)
    }
  }
  out()

  const mcpIds = Object.keys(loaded.config.mcp)
  const lspIds = Object.keys(loaded.config.lsp)
  if (mcpIds.length > 0 || lspIds.length > 0) {
    out("MCP & language servers")
    for (const [id, entry] of Object.entries(loaded.config.mcp)) {
      // Server remote tidak punya biner untuk dicari di PATH; yang bisa
      // dilaporkan tentangnya adalah URL-nya dan apakah ia sudah punya token.
      if (entry.url !== undefined) {
        const auth = entry.oauth ? (validToken(id) ? "signed in" : "needs `titah mcp login`") : "static headers"
        out(`  mcp ${id.padEnd(14)} ${entry.enabled === false ? "disabled" : `${entry.url}  ${auth}`}`)
        continue
      }
      const command = entry.command as string
      const found = which(command)
      out(
        `  mcp ${id.padEnd(14)} ${entry.enabled === false ? "disabled" : (found ?? `! ${command} not in PATH`)}`,
      )
    }
    for (const [id, entry] of Object.entries(loaded.config.lsp)) {
      const found = which(entry.command)
      out(
        `  lsp ${id.padEnd(14)} ${entry.enabled === false ? "disabled" : (found ?? `! ${entry.command} not in PATH`)}` +
          `  ${entry.extensions.join(" ")}`,
      )
    }
    // Jabat tangannya TIDAK dilakukan di sini. `doctor` harus cepat dan tidak
    // punya efek samping; menyalakan setiap server MCP untuk memeriksanya
    // berarti doctor menjalankan kode pihak ketiga, dan itu bukan yang user
    // minta ketika ia mengetik "doctor".
    out("  (not started here — doctor never runs third-party code)")
    out()
  }

  // Q24: agent yang tidak terpasang tetap ditampilkan, tidak disembunyikan.
  out("Super agents")
  {
    const registered = Object.entries(loaded.config.externalAgent)
    for (const [id, agent] of registered) {
      const found = which(agent.command)
      const where = found ?? `unavailable (${agent.command} not in PATH)`
      // Spesialis disebut karena ia yang menentukan apakah agent ini ikut /tim.
      const spec = agent.specialist ? `  · ${agent.specialist}` : "  · no specialist — /tim skips it"
      out(`  ${id.padEnd(18)} ${where}${spec}`)
    }

    /*
     * Blok siap-salin untuk CLI yang BENAR-BENAR ada di mesin ini.
     *
     * Titah tidak lagi menyuntik `claude` dan `opencode` ke config siapa pun —
     * daftar itu murni milik user sekarang. Tapi menemukan CLI-nya terpasang
     * lalu diam saja berarti membiarkan orang menulis argumen yang sudah
     * diverifikasi di sini, dari ingatan.
     */
    const suggestions = Object.entries(EXAMPLE_EXTERNAL_AGENTS).filter(
      ([id, preset]) => loaded.config.externalAgent[id] === undefined && which(preset.command as string),
    )
    if (registered.length === 0 && suggestions.length === 0) {
      out("  (none registered — /tim needs at least one)")
    }
    for (const [id, preset] of suggestions) {
      out("")
      out(`  ${id} is installed but not registered. Add this to titah.json:`)
      out(`    "externalAgent": { ${JSON.stringify(id)}: ${JSON.stringify(preset)} }`)
    }
  }
  out()

  /*
   * Sandbox dilaporkan di sini karena keadaannya bisa BERBEDA dari yang
   * dikira user: config menyalakannya, tapi mesinnya tidak punya. Tanpa baris
   * ini, satu-satunya cara mengetahuinya adalah perintah bash pertama yang
   * ditolak — jauh setelah ia mengira dirinya terlindungi.
   */
  const kind = sandboxAvailable()
  out("Sandbox")
  if (!loaded.config.sandbox.bash) {
    out(`  off — bash runs with your full permissions (${kind} is available here)`)
  } else if (kind === "none") {
    out(`  ON, but this platform has none — bash will be REFUSED`)
  } else {
    out(`  on — ${kind}; writes confined to the project and temp`)
    out(`  network inside the sandbox: ${loaded.config.sandbox.network ? "allowed" : "denied"}`)
  }
  out()

  out("Skills")
  for (const line of renderSkillReport(loaded.config, process.cwd()).split("\n")) out(`  ${line}`)
  out()
  out('Delegation is live: type "@<agent> <prompt>" inside a session.')
}

async function cmdServe(port: number, hostname: string): Promise<void> {
  const handle = await listen(VERSION, port, hostname)
  out(`titah serve ${VERSION}`)
  out(`  ${handle.url}`)
  out()
  out("  GET  /health")
  out("  GET  /event?session=<id>          SSE stream of all events")
  out("  POST /session                     create a session")
  out("  GET  /session                     list sessions")
  out("  GET  /session/:id/message         message history")
  out("  POST /session/:id/message         send a prompt (Accept: text/event-stream to stream)")
  out("  POST /session/:id/abort           cancel the running turn")
  out()
  out("Ctrl-C to stop.")

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.stderr.write("\nshutting down...\n")
      void handle.close().then(resolve)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

/**
 * Dialog izin versi terminal. Tanpa TTY tidak ada yang bisa menjawab, jadi
 * ditolak — sejalan dengan aturan "tanpa klien = tolak" di Q17.
 */
async function askPermission(request: PermissionRequest): Promise<PermissionDecision> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `\n  ⚠ ${request.agent ? `${request.agent} · ` : ""}${request.title} — denied: stdin is not a terminal, nobody can answer.\n` +
        "    Use --auto, or add a pattern to permission.allowlist.\n",
    )
    return "reject"
  }

  const readline = await import("node:readline/promises")
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    // Nama peminta ikut dicetak: satu giliran `/tim` bisa memunculkan tiga
    // dialog `bash` yang identik dari tiga sub-agent berbeda, dan tanpa nama
    // itu user menjawab pertanyaan tanpa tahu siapa yang bertanya.
    const who = request.agent ? `${request.agent} · ` : ""
    process.stderr.write(`\n  ⚠ ${who}Permission requested (${request.kind}): ${request.title}\n`)
    for (const line of request.detail.split("\n").slice(0, 20)) {
      process.stderr.write(`    │ ${line}\n`)
    }
    const answer = (
      await rl.question(`    [y] allow once  [a] always (${request.pattern})  [n] deny › `)
    )
      .trim()
      .toLowerCase()
    if (answer === "y" || answer === "yes") return "once"
    if (answer === "a") return "always"
    return "reject"
  } finally {
    rl.close()
  }
}

async function cmdRun(
  text: string,
  options: {
    model?: string
    session?: string
    auto?: boolean
    agent?: string
    format?: OutputFormat
    schemaPath?: string
    background?: boolean
  },
): Promise<void> {
  if (text.trim() === "") fail('usage: titah run "<prompt>"')

  const format = options.format ?? "text"
  /*
   * Dalam mode json, stdout milik DATA — tidak satu pun karakter untuk manusia
   * boleh menyentuhnya. Satu baris "session: ..." di depan objeknya membuat
   * `JSON.parse` gagal, dan pemanggilnya tidak punya cara menebak bahwa yang
   * salah adalah barisnya, bukan datanya.
   */
  const quiet = format !== "text"

  let schema: unknown
  if (options.schemaPath !== undefined) {
    try {
      schema = JSON.parse(fs.readFileSync(options.schemaPath, "utf8"))
    } catch (error) {
      fail(`cannot read --json-schema ${options.schemaPath}: ${(error as Error).message}`)
    }
  }

  const sessionID = options.session ?? createSession(process.cwd()).id

  /*
   * Cabang latar diambil SEBELUM apa pun yang mahal.
   *
   * Sesinya dibuat lebih dulu supaya idnya bisa dicetak sekarang — orang yang
   * melepas pekerjaan ke latar butuh sesuatu untuk dipegang, dan menyuruhnya
   * mencari sendiri di `bg list` beberapa detik kemudian adalah cara paling
   * mudah kehilangan giliran yang baru saja ia mulai.
   */
  if (options.background === true) {
    const passthrough: string[] = ["--session", sessionID]
    if (options.auto === true) passthrough.push("--auto")
    if (options.model) passthrough.push("--model", options.model)
    if (options.agent) passthrough.push("--agent", options.agent)
    if (options.schemaPath) passthrough.push("--json-schema", options.schemaPath)
    if (format !== "text") passthrough.push("--output-format", format)

    const turn = spawnBackground({
      prompt: text,
      directory: process.cwd(),
      sessionID,
      args: passthrough,
    })
    out(`${turn.id}  ${sessionID}`)
    process.stderr.write(`Running in the background. Follow it with \`titah bg logs ${turn.id} -f\`.\n`)
    return
  }

  const controller = new AbortController()
  const notices: string[] = []

  // Berlangganan sebelum giliran dimulai supaya tidak ada event yang lolos.
  const events = bus.subscribe({ sessionID, signal: controller.signal })
  const turn = prompt({
    sessionID,
    // Bentuknya diminta lewat PROMPT, bukan system prompt: system prompt ikut
    // di-cache sebagai awalan stabil, dan skema yang berubah tiap pemanggilan
    // akan mematahkan cache itu untuk setiap permintaan.
    text: schema === undefined ? text : `${text}${schemaInstruction(schema)}`,
    ...(options.auto === true ? { auto: true } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  }).catch((error: unknown) => {
    if (error instanceof AgentError) fail(error.message)
    throw error
  })

  if (!quiet) process.stderr.write(`session: ${sessionID}\n\n`)
  const printedToolStates = new Set<string>()

  for await (const event of events) {
    /*
     * `stream-json` sengaja BUKAN format baru: ia persis `Event` milik Titah,
     * satu per baris. Format kedua berarti dua bentuk yang harus dijaga tetap
     * sama, dan yang kedua selalu tertinggal begitu event baru ditambahkan.
     */
    if (format === "stream-json") process.stdout.write(streamLine(event))
    if (event.type === "session.notice") notices.push(event.message)

    switch (event.type) {
      case "text.delta":
        if (!quiet) process.stdout.write(event.text)
        break
      case "message.updated": {
        // Glyph tool adalah kemajuan untuk MATA. Dalam mode json ia sudah
        // terkirim sebagai data — di `stream-json` lewat eventnya sendiri, di
        // `json` lewat daftar `tools` di akhir.
        if (quiet) break
        // message.updated adalah SNAPSHOT (Q22): setiap kali dikirim ia memuat
        // seluruh part. Tanpa penjejak ini, satu tool tercetak berkali-kali.
        for (const part of event.message.parts) {
          if (part.type !== "tool") continue
          const key = `${part.callID}:${part.state.status}`
          if (printedToolStates.has(key)) continue
          printedToolStates.add(key)
          if (part.state.status === "completed") {
            // Sama seperti riwayat TUI: `task` yang gagal atau dihentikan
            // selesai tanpa melempar, jadi glyph-nya tidak boleh diambil dari
            // status "completed" saja.
            const glyph =
              part.state.outcome === "failed" ? "✗" : part.state.outcome === "stopped" ? "⊘" : "✓"
            process.stderr.write(`  ${glyph} ${part.state.title}\n`)
          }
          if (part.state.status === "error")
            process.stderr.write(`  ✗ ${part.tool}: ${part.state.error}\n`)
          if (part.state.status === "denied")
            process.stderr.write(`  ⊘ ${part.state.title} — ${part.state.reason}\n`)
        }
        break
      }

      case "permission.request": {
        respond(event.request.id, await askPermission(event.request))
        break
      }
      /*
       * Notice ikut dicetak, sama seperti di TUI.
       *
       * Sebelum ini `titah run` diam-diam membuangnya — tidak ada `case`, jadi
       * ia jatuh ke `default`. Akibatnya setiap kabar sekali-per-sesi hilang
       * dari CLI: peringatan contextWindow, laporan berkas yang dibuat, deteksi
       * perulangan, dan yang paling merugikan — kabar bahwa giliran berhenti
       * karena kehabisan langkah atau anggaran. Persis kegagalan diam yang baru
       * saja diperbaiki, masih diam di separuh antarmuka.
       *
       * Ke stderr, bukan stdout: stdout milik jawaban model, dan `titah run`
       * dipakai dalam pipa.
       */
      case "session.notice":
        if (!quiet) process.stderr.write(`\n  · ${event.message}\n`)
        break
      case "session.error":
        if (!quiet) process.stderr.write(`\ntitah: ${event.message}\n`)
        break
      case "session.idle":
        controller.abort()
        break
      default:
        break
    }
    if (event.type === "session.idle") break
  }

  const assistant = await turn

  if (format === "text") {
    process.stdout.write("\n")
    if (assistant?.usage) {
      process.stderr.write(
        `\n${assistant.usage.input ?? "?"} in / ${assistant.usage.output ?? "?"} out\n`,
      )
    }
    process.exit(assistant?.error ? 1 : 0)
  }

  const result = turnResult(sessionID, assistant, notices)

  /*
   * Skema yang tidak cocok GAGAL, dan dengan kode keluar sendiri.
   *
   * Membiarkannya lolos sebagai teks biasa akan membuat skrip pemanggil
   * memproses jawaban yang bentuknya bukan yang ia minta — kegagalan yang baru
   * terlihat beberapa langkah kemudian, jauh dari sebabnya. Kode 2 memisahkannya
   * dari 1 (giliran yang gagal): keduanya butuh penanganan yang berbeda.
   */
  const { result: final, exit } = applySchema(result, schema)

  /*
   * Di `stream-json` hasilnya tetap dicetak sebagai baris terakhir.
   *
   * Pemanggil yang mengikuti aliran tetap butuh satu tempat yang memuat
   * kesimpulannya — merakit ulang dari puluhan event adalah pekerjaan yang
   * seharusnya tidak dibebankan padanya, dan tiap klien akan merakitnya sedikit
   * berbeda.
   */
  process.stdout.write(
    format === "stream-json"
      ? `${JSON.stringify({ type: "result", result: final })}\n`
      : `${JSON.stringify(final, null, 2)}\n`,
  )
  process.exit(exit)
}

/**
 * Onboarding (Q27). Urutan sengaja: deteksi environment → probe endpoint lokal
 * → baru bertanya. Setiap pertanyaan yang bisa dijawab sendiri oleh Titah adalah
 * pertanyaan yang tidak perlu ditanyakan.
 */
/**
 * Menyatakan server yang dituju hanya ketika bukan yang biasa.
 *
 * Mencetak URL server di setiap login adalah kebisingan; TIDAK mencetaknya saat
 * server memang berbeda adalah cara paling mudah membuat orang login ke tempat
 * yang salah tanpa pernah tahu.
 */
function serverNote(server: string): string {
  return `Server: ${server}`
}

function printLoginPrompt(authorization: DeviceAuthorization, opened: boolean): void {
  const code = formatUserCode(authorization.userCode)
  out()
  out(`  Your code:  ${code}`)
  out()
  if (opened) {
    out("  A browser window should have opened. Confirm the code there.")
    out(`  If it did not: ${authorization.verificationUri}`)
  } else {
    out("  Open this URL in any browser, on any machine:")
    out(`    ${authorization.verificationUriComplete ?? authorization.verificationUri}`)
  }
  out()
  out("  Waiting for approval… (Ctrl+C to cancel)")
}

async function cmdLogin(options: { server?: string; browser: boolean }): Promise<void> {
  const { config } = loadConfig()
  let server: string
  try {
    server = options.server ? normaliseServer(options.server) : accountServer(config)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const existing = currentAccount()
  if (existing && existing.server === server) {
    out(`Already signed in as ${existing.user.email}.`)
    out("Run `titah logout` first to sign in as somebody else.")
    return
  }

  out(`Signing in to Titah.`)
  out(serverNote(server))

  try {
    const account = await login(
      server,
      {
        onPrompt: printLoginPrompt,
        onSlowDown: () => process.stderr.write("titah: the server asked us to poll more slowly.\n"),
      },
      { openBrowser: options.browser },
    )
    out()
    out(`Signed in as ${account.user.name ? `${account.user.name} <${account.user.email}>` : account.user.email}.`)
    out(`This machine is listed as "${account.deviceName}" — revoke it any time from the dashboard.`)
  } catch (error) {
    if (error instanceof AccountError) fail(error.message)
    throw error
  }
}

async function cmdLogout(): Promise<void> {
  const account = currentAccount()
  if (!account) {
    // Membedakan "tidak login" dari "gagal keluar" — keduanya berakhir dengan
    // tidak login, tapi hanya satu yang perlu ditindaklanjuti.
    out("Not signed in.")
    return
  }

  const revoked = await revokeToken(account)
  signOut()

  out(`Signed out ${account.user.email}.`)
  if (!revoked) {
    out(
      `The server at ${account.server} could not be reached, so the token is gone locally but may ` +
        "still be listed on your dashboard. Revoke it there.",
    )
  }
}

async function cmdWhoami(): Promise<void> {
  const account = currentAccount()
  if (!account) {
    out("Not signed in. Run `titah login`, or keep using Titah without an account.")
    process.exitCode = 1
    return
  }

  out(`Email:   ${account.user.email}`)
  if (account.user.name) out(`Name:    ${account.user.name}`)
  out(`Server:  ${account.server}`)
  out(`Device:  ${account.deviceName}`)
  out(`Since:   ${new Date(account.signedInAt).toISOString()}`)

  // Berkas lokal hanya mengatakan apa yang PERNAH benar. Yang menentukan sesi
  // masih sah adalah server, dan token yang dicabut lewat dashboard hanya
  // ketahuan dengan bertanya.
  try {
    const user = await fetchUserInfo(account)
    out(`Status:  verified as ${user.email}`)
  } catch (error) {
    if (error instanceof AccountError) {
      out(`Status:  ${error.message}`)
      if (error.code === "revoked") process.exitCode = 1
      return
    }
    throw error
  }
}

/**
 * Pertanyaan pembuka di mesin yang belum pernah memakai Titah.
 *
 * Dua pilihan, dan "lanjut tanpa akun" adalah pilihan yang sah — bukan jalan
 * memutar. Titah bekerja penuh tanpa akun: yang dibuka oleh login adalah
 * dashboard web, bukan kemampuan agent-nya. Memaksa login untuk sesuatu yang
 * tidak membutuhkannya adalah cara tercepat membuat orang menutup terminal.
 */
async function askAccountChoice(): Promise<void> {
  if (hasChosen()) return
  if (!process.stdin.isTTY) {
    // Non-interaktif: jangan bertanya, dan jangan pula merekam pilihan yang
    // tidak pernah dibuat user. Skrip lanjut tanpa akun; manusia tetap ditanya
    // saat membuka Titah sendiri.
    return
  }

  const { config } = loadConfig()
  out(`Welcome to Titah ${VERSION}.`)
  out()
  out("  1. Sign in to your Titah account")
  out("  2. Continue without an account")
  out()
  out("  Titah works fully either way — an account only adds the web dashboard.")
  out()

  const readline = await import("node:readline/promises")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let answer: string
  try {
    answer = (await rl.question("Choose [1-2] › ")).trim()
  } finally {
    rl.close()
  }

  if (answer !== "1") {
    chooseAnonymous()
    out()
    out("Continuing without an account. Run `titah login` whenever you change your mind.")
    out()
    return
  }

  const server = accountServer(config)
  out()
  out(serverNote(server))
  try {
    const account = await login(server, { onPrompt: printLoginPrompt })
    out()
    out(`Signed in as ${account.user.email}.`)
    out()
  } catch (error) {
    // Login yang gagal tidak boleh menghentikan sesi. User datang untuk memakai
    // agent-nya, bukan untuk login — jadi catat pilihannya sebagai "tanpa akun"
    // dan lanjutkan, dengan alasan kegagalannya disebutkan.
    chooseAnonymous()
    process.stderr.write(
      `titah: sign-in failed — ${error instanceof AccountError ? error.message : String(error)}\n` +
        "titah: continuing without an account. Run `titah login` to try again.\n\n",
    )
  }
}

async function cmdInit(auto: boolean): Promise<void> {
  const existing = globalConfigFile()
  if (fs.existsSync(existing)) {
    fail(`Config already exists at ${existing}. Edit it directly, or delete it to start over.`)
  }

  // Tidak bertanya dua kali: kalau `titah` sudah menanyakannya barusan,
  // hasChosen() sudah true dan ini tidak melakukan apa-apa.
  if (!auto) await askAccountChoice()

  out("Setting up Titah.")
  out()

  const fromEnv = detectFromEnv()
  const local = await probeLocal()

  interface Option {
    label: string
    make: () => ProviderChoice
  }

  const options: Option[] = [
    ...fromEnv.map((preset) => ({
      label: `${preset.label} — key detected in $${preset.envVar}`,
      make: (): ProviderChoice => ({
        id: preset.id,
        label: preset.label,
        npm: preset.npm,
        ...(preset.baseURL ? { baseURL: preset.baseURL } : {}),
        ...(preset.envVar ? { envVar: preset.envVar } : {}),
        model: preset.defaultModel,
        models: preset.models,
      }),
    })),
    ...local.map((found) => ({
      label: `${found.label} — live, ${found.models.length} models, no key needed`,
      make: (): ProviderChoice => ({
        id: found.id,
        label: found.label,
        npm: "@ai-sdk/openai-compatible" as const,
        baseURL: found.baseURL,
        model: found.models[0] as string,
        models: found.models.slice(0, 12),
      }),
    })),
  ]

  for (const [index, option] of options.entries()) out(`  ${index + 1}. ${option.label}`)
  if (!auto) out(`  ${options.length + 1}. Another OpenAI-compatible endpoint (enter manually)`)
  out()

  // Jalur non-interaktif. Tanpa ini, `titah init` di dalam skrip atau Dockerfile
  // menabrak stdin yang sudah tertutup dan mati dengan stack trace.
  if (auto || !process.stdin.isTTY) {
    const first = options[0]
    if (!first) {
      fail(
        "No provider could be detected automatically.\n" +
          "Set one of ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, " +
          "run a local endpoint, or run `titah init` in an interactive terminal.",
      )
    }
    if (!auto) {
      process.stderr.write(
        "titah: stdin is not a terminal — using the first option. Pass --yes to make this explicit.\n",
      )
    }
    return finishInit(first.make())
  }

  const readline = await import("node:readline/promises")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = (await rl.question(`Choose [1-${options.length + 1}] › `)).trim()
    const picked = Number(answer)

    let choice: ProviderChoice
    if (Number.isInteger(picked) && picked >= 1 && picked <= options.length) {
      choice = (options[picked - 1] as Option).make()
    } else {
      const baseURL = (await rl.question("Base URL (e.g. https://host/v1) › ")).trim()
      if (baseURL === "") fail("base URL is required.")
      const id = (await rl.question("Short provider name [custom] › ")).trim() || "custom"
      const model = (await rl.question("Model id › ")).trim()
      if (model === "") fail("model id is required.")
      const key = (await rl.question("API key (leave empty if not needed) › ")).trim()

      choice = {
        id,
        label: id,
        npm: "@ai-sdk/openai-compatible",
        baseURL,
        model,
        models: [model],
        ...(key ? { apiKey: key } : {}),
      }
    }

    finishInit(choice)
  } finally {
    rl.close()
  }
}

function finishInit(choice: ProviderChoice): void {
  const schemaPath = path.join(import.meta.dirname, "..", "config.schema.json")
  const result = writeOnboarding(choice, fs.existsSync(schemaPath) ? schemaPath : undefined)

  out()
  out(`Config written: ${result.configFile}`)
  if (result.wroteCredential) out(`Key stored in ${authFile()} (mode 0600).`)
  out(`Default model: ${choice.id}/${choice.model}`)
  out()
  out("Run `titah` to start a session, or `titah doctor` to check things.")
}

async function cmdTui(options: {
  model?: string
  sessionID?: string
  attach?: string
}): Promise<void> {
  if (!process.stdin.isTTY) {
    fail('The TUI needs an interactive terminal. For scripts use `titah run "<prompt>"`.')
  }

  // Mesin yang belum pernah memakai Titah ditanya SEKALI: login, atau lanjut
  // tanpa akun. Sebelum setup provider, karena ini pertanyaan tentang siapa
  // kamu, bukan tentang model mana yang dipakai — dan yang kedua tidak menarik
  // kalau yang pertama belum dijawab.
  await askAccountChoice()

  const { config } = loadConfig()
  if (!isConfigured(config) && options.model === undefined) {
    // Mesin bersih: jangan lempar error, tuntun (Q27).
    process.stderr.write("Titah is not configured yet. Running first-time setup.\n\n")
    await cmdInit(false)
    return
  }

  const model = options.model ?? config.model
  if (!model) {
    fail(
      "No default model. Set `model` in titah.json or pass --model.\n" +
        "See the options with `titah models`.",
    )
  }

  // Dynamic import: modul TUI berisi JSX, dan Node tidak bisa memuat .tsx
  // langsung. Perintah headless tetap jalan dari sumber tanpa build.
  const { start } = await import("./tui/index.tsx")
  await start({
    version: VERSION,
    cwd: process.cwd(),
    model,
    config,
    keybinds: config.keybinds,
    agents: Object.keys(config.agent),
    ...(config.defaultAgent ? { defaultAgent: config.defaultAgent } : {}),
    ...(options.attach ? { attach: options.attach } : {}),
    ...(options.sessionID ? { sessionID: options.sessionID } : {}),
  })
}

async function cmdUndo(sessionID: string | undefined): Promise<void> {
  // Sesi TERAKHIR DI FOLDER INI. Tanpa penyaringan, `titah undo` di satu
  // proyek bisa memulihkan snapshot milik proyek lain yang baru saja dipakai.
  const target = sessionID ?? listSessions(1, process.cwd())[0]?.id
  if (!target) fail("no sessions yet. Run `titah run` first.")
  if (!gitAvailable()) fail("git is not available, so there is no snapshot to restore.")

  try {
    const result = await undo(target)
    out(`Restored to snapshot ${result.snapshot.slice(0, 8)} (${result.files.length} files):`)
    for (const file of result.files) out(`  ${file}`)
  } catch (error) {
    if (error instanceof UndoError || error instanceof SnapshotError) fail(error.message)
    throw error
  }
}

/** "30d" / "12h" / "45m" / "90s" → milidetik. */
function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim())
  if (!match) fail(`unrecognised age: "${value}". Examples: 30d, 12h, 45m.`)
  const amount = Number(match[1])
  const unit = match[2] as "s" | "m" | "h" | "d"
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
  return amount * multiplier
}

/**
 * Angka besar dibuat bisa dibaca sekilas, tapi TIDAK dibulatkan diam-diam.
 *
 * "30,2 jt" cukup untuk menilai skala; totalnya tetap dicetak utuh di bawah,
 * karena angka yang dibulatkan adalah angka yang tidak bisa dicocokkan dengan
 * tagihan.
 */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function money(n: number): string {
  return n >= 10 ? n.toFixed(2) : n.toFixed(4)
}

/**
 * Kait yang terpasang, beserta pola yang tidak sah.
 *
 * Pola regex yang salah ketik TIDAK PERNAH cocok, dan itu keputusan yang benar
 * di jalur panas — menolak seluruh giliran karena satu pola rusak jauh lebih
 * merugikan daripada kait yang tidak menyala. Tapi kait yang diam karena
 * polanya rusak tidak bisa dibedakan dari kait yang memang tidak cocok, dan di
 * sinilah bedanya disebutkan.
 */
/** Umur yang bisa dibaca sekilas: 3m, 2h, 4d. */
function since(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/**
 * Server plus browser, satu perintah.
 *
 * `titah serve` sudah menyajikan kliennya di `/` — ini hanya menghapus dua
 * langkah yang selalu sama: membaca portnya dari keluaran, lalu menempelkannya
 * ke bilah alamat.
 *
 * Membuka browser TIDAK PERNAH menggagalkan perintahnya. Mesin tanpa browser —
 * server, kontainer, SSH — tetap mendapat servernya, dan URL-nya dicetak untuk
 * disalin sendiri.
 */
async function cmdWeb(port: number): Promise<void> {
  const handle = await listen(VERSION, port, "127.0.0.1")
  const url = handle.url
  out(url)
  process.stderr.write("Web client ready. Press ctrl+c to stop.\n")

  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    const { spawn } = await import("node:child_process")
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref()
  } catch {
    // Tidak ada browser di sini. Servernya tetap jalan, dan URL-nya sudah
    // dicetak — itu seluruh yang dibutuhkan.
  }
}

function cmdBackground(args: string[], options: { follow?: boolean }): void {
  const sub = args[0] ?? "list"

  if (sub === "list") {
    /*
     * Membersihkan lebih dulu, tapi HANYA catatan yang tidak menunjuk apa pun
     * lagi. Giliran yang sudah selesai dan lognya masih ada sengaja tetap
     * terdaftar: itulah satu-satunya cara membaca hasil pekerjaan yang selesai
     * saat kamu tidak di depan layar.
     */
    pruneBackground()
    const turns = listBackground()
    if (turns.length === 0) {
      out("No background turns. Start one with `titah run --bg \"…\"`.")
      return
    }
    for (const turn of turns) {
      const state = turn.alive ? "running" : "done"
      out(
        `${turn.id}  ${state.padEnd(7)} ${since(turn.started).padStart(4)} ago  ` +
          `${turn.prompt.replace(/\s+/g, " ").slice(0, 48)}`,
      )
      out(`         ${turn.sessionID}  ${turn.directory}`)
    }
    return
  }

  const id = args[1]
  if (id === undefined) fail(`usage: titah bg ${sub} <id>`)
  const turn = findBackground(id)
  if (!turn) fail(`no background turn matches "${id}". Run \`titah bg list\`.`)

  if (sub === "logs") {
    if (!fs.existsSync(turn.log)) fail(`its log is gone: ${turn.log}`)
    if (options.follow !== true) {
      process.stdout.write(fs.readFileSync(turn.log, "utf8"))
      return
    }
    /*
     * `-f` berhenti sendiri saat prosesnya mati.
     *
     * Tail yang menggantung selamanya di giliran yang sudah selesai memaksa
     * user menekan ctrl+c untuk sesuatu yang sudah beres — dan menekan ctrl+c
     * pada pekerjaan latar adalah gerakan yang tepat untuk MEMBATALKAN, jadi
     * kebiasaan itu berbahaya untuk dilatih.
     */
    let read = 0
    const pump = (): void => {
      const size = fs.statSync(turn.log).size
      if (size > read) {
        const chunk = Buffer.alloc(size - read)
        const handle = fs.openSync(turn.log, "r")
        fs.readSync(handle, chunk, 0, chunk.length, read)
        fs.closeSync(handle)
        process.stdout.write(chunk)
        read = size
      }
      if (!turn.alive && size === read) {
        clearInterval(timer)
        return
      }
      turn.alive = alive(turn.pid)
    }
    const timer = setInterval(pump, 300)
    pump()
    return
  }

  if (sub === "stop") {
    if (!turn.alive) {
      out(`${turn.id} already finished.`)
      return
    }
    out(stopBackground(turn) ? `${turn.id} stopped.` : `${turn.id} could not be stopped.`)
    return
  }

  fail(`unknown: titah bg ${sub}. Use list, logs, or stop.`)
}

function cmdHooks(): void {
  const { config } = loadConfig(process.cwd())
  const events = ["tool.before", "tool.after"] as const
  let total = 0

  for (const event of events) {
    const hooks = config.hooks[event]
    if (hooks.length === 0) continue
    total += hooks.length
    out(`${event}`)
    for (const hook of hooks) {
      let scope = "all tools"
      if (hook.match !== undefined) {
        try {
          new RegExp(hook.match)
          scope = `/${hook.match}/`
        } catch (error) {
          scope = `INVALID regex — never matches: ${(error as Error).message}`
        }
      }
      out(`  ${scope}`)
      out(`    ${hook.run}`)
      if (hook.timeout !== undefined) out(`    timeout ${hook.timeout}ms`)
    }
  }

  if (total === 0) {
    out('No shell hooks configured. Add them under "hooks" in titah.json.')
    out('  e.g. "tool.after": [{ "match": "edit|write", "run": "npm run format" }]')
  }
}

function cmdStats(options: { since?: string; all?: boolean }): void {
  const { config } = loadConfig(process.cwd())
  const query = {
    ...(options.since ? { from: Date.now() - parseDuration(options.since) } : {}),
    ...(options.all === true ? {} : { directory: process.cwd() }),
  }
  const stats = collectStats(config, query)

  if (stats.turns === 0) {
    out(
      options.all === true
        ? "No recorded turns yet."
        : "No recorded turns in this folder. Use --all for every project.",
    )
    return
  }

  const scope = options.all === true ? "every project" : process.cwd()
  const window = options.since ? `last ${options.since}` : "all time"
  out(`${stats.turns} turns across ${stats.sessions} sessions · ${window} · ${scope}\n`)

  out("  by model")
  for (const model of stats.byModel) {
    const cost = model.cost === undefined ? "       —" : money(model.cost).padStart(8)
    out(
      `    ${model.model.padEnd(22)} ${String(model.turns).padStart(5)} turns  ` +
        `${short(model.input).padStart(7)} in  ${short(model.output).padStart(7)} out  ${cost}`,
    )
  }

  out("\n  by day")
  for (const day of stats.byDay.slice(-14)) {
    const cost = day.cost === undefined ? "       —" : money(day.cost).padStart(8)
    out(
      `    ${day.day}  ${String(day.turns).padStart(5)} turns  ` +
        `${short(day.input).padStart(7)} in  ${short(day.output).padStart(7)} out  ${cost}`,
    )
  }

  out(
    `\n  total  ${stats.input.toLocaleString()} in / ${stats.output.toLocaleString()} out` +
      (stats.cost > 0 ? `  ·  ${money(stats.cost)}` : ""),
  )

  /*
   * Model tanpa harga DISEBUT, tidak didiamkan.
   *
   * Menghitungnya sebagai nol akan membuat totalnya berbohong ke arah paling
   * berbahaya — terlihat murah — dan tidak ada satu pun tanda di layar yang
   * membedakan "gratis" dari "belum diberi harga".
   */
  if (stats.unpriced.length > 0) {
    out(
      `\n  not priced: ${stats.unpriced.join(", ")}` +
        `\n  Their tokens are counted above; their cost is not. Add ` +
        `provider.<name>.models.<id>.price to include them.`,
    )
  }
}

function cmdSessions(args: string[], olderThan: string | undefined, all = false): void {
  const sub = args[0] ?? "list"

  if (sub === "list") {
    // Default ke folder saat ini, sama seperti `/session` di TUI. Sesi terikat
    // ke kode yang sedang dikerjakan; daftar sepanjang seluruh mesin membuat
    // yang benar-benar dicari tenggelam.
    const sessions = all ? listSessions() : listSessions(50, process.cwd())
    if (sessions.length === 0) {
      return out(
        all
          ? "No sessions yet."
          : `No sessions for ${process.cwd()} yet. Use --all to list every project.`,
      )
    }
    for (const session of sessions) {
      const when = new Date(session.updated).toISOString().slice(0, 16).replace("T", " ")
      const where = all ? `  ${session.directory}` : ""
      out(`${session.id}  ${when}  ${session.title || "(untitled)"}${where}`)
    }
    return
  }

  if (sub === "prune") {
    // Retensi ada sejak v1 dengan sengaja — lihat DESIGN.md §2. Menghapus baris
    // DB saja tidak cukup: blob tool-output dan repo snapshot ikut disapu.
    const age = parseDuration(olderThan ?? "30d")
    const result = prune(age)
    out(`${result.sessions} sessions deleted (older than ${olderThan ?? "30d"}).`)
    out(`${result.files} orphaned tool-output blobs and ${result.snapshots} snapshots swept.`)
    return out(`Space reclaimed: ${formatBytes(result.bytes)}.`)
  }

  if (sub === "delete") {
    const id = args[1]
    if (!id) fail("usage: titah sessions delete <id>")
    return out(deleteSession(id) ? `Session ${id} deleted.` : `Session not found: ${id}`)
  }

  fail(`Unknown sessions subcommand: "${sub}". Options: list, prune, delete.`)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof ConfigError || error instanceof ProviderError) {
    fail(error.message)
  }
  throw error
}
