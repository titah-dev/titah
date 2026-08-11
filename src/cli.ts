#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, redact, ConfigError } from "./core/config.ts"
import { checkPermissions, readAuth, removeCredential, setCredential } from "./core/auth.ts"
import {
  listModels,
  resolveCredential,
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
import { respond, type PermissionDecision, type PermissionRequest } from "./core/permission.ts"
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
  sessions list            List stored sessions
  sessions prune           Delete old sessions + orphaned blobs & snapshots

Configuration:
  init [-y]                First-time setup (auto-detect + wizard)
  config path              Show config, auth, and data locations
  config show              Show the merged config (credentials redacted)
  auth list                Providers and where their credentials come from
  auth set <provider>      Store an API key in auth.json (mode 0600), read from stdin
  auth remove <provider>   Remove a provider's credentials
  models                   List configured models
  doctor                   Check environment, config, and external agents

Options:
  -v, --version            Print the version
  -h, --help               Print this help
  -m, --model <id>         Model override, in "provider/model" form
  -a, --agent <name>       Run with a specific internal agent
  -s, --session <id>       Continue an existing session (run)
      --port <n>           Server port (serve), random by default
      --hostname <h>       Server hostname (serve), 127.0.0.1 by default
      --older-than <age>   Age cutoff for prune, e.g. 30d / 12h
      --all                sessions list: every project, not just this folder
      --auto               (run) Auto-approve permissions not denied by config
  -y, --yes                (init) Use the first detected provider, no questions
      --probe              (doctor) Also test network reachability per provider

In-session commands:
  /consensus <question>    Fan out to every external agent and compare
  /model  /agent           Switch model or agent (TUI only)
  /session  /new           Resume a previous session, or start a new one (TUI only)
  /skill                   Insert a skill into your prompt (TUI only)
  /agents  /skills  /commands   List what is available
  /<name> <input>          Custom command from your config

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
    case "auth":
      return cmdAuth(rest)
    case "models":
      return cmdModels()
    case "doctor":
      return cmdDoctor(values.probe === true)
    case "serve":
      return cmdServe(
        values.port === undefined ? 0 : Number(values.port),
        typeof values.hostname === "string" ? values.hostname : "127.0.0.1",
      )
    case "run":
      return cmdRun(rest.join(" "), {
        auto: values.auto === true,
        ...(typeof values.model === "string" ? { model: values.model } : {}),
        ...(typeof values.agent === "string" ? { agent: values.agent } : {}),
        ...(typeof values.session === "string" ? { session: values.session } : {}),
      })
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
  // Angka yang dilaporkan HARUS lewat `effectiveReserved`, bukan aritmetika
  // sendiri — dua rumus yang seharusnya sama bisa diam-diam menyimpang begitu
  // RESERVE_FRACTION berubah, dan doctor lalu melaporkan angka yang salah
  // sambil terlihat baik-baik saja.
  for (const clash of reservedCollisions(loaded.config)) {
    out(
      `  ! ${clash.model} — compaction.reserved (${clash.reserved}) exceeds a quarter of ` +
        `this ${clash.contextWindow}-token window; using ` +
        `${effectiveReserved(clash.contextWindow, clash.reserved)}`,
    )
  }
  out()

  // Q24: agent yang tidak terpasang tetap ditampilkan, tidak disembunyikan.
  out("External agents")
  for (const [id, agent] of Object.entries(loaded.config.externalAgent)) {
    const found = which(agent.command)
    out(`  ${id.padEnd(18)} ${found ?? `unavailable (${agent.command} not in PATH)`}`)
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
  options: { model?: string; session?: string; auto?: boolean; agent?: string },
): Promise<void> {
  if (text.trim() === "") fail('usage: titah run "<prompt>"')

  const sessionID = options.session ?? createSession(process.cwd()).id
  const controller = new AbortController()

  // Berlangganan sebelum giliran dimulai supaya tidak ada event yang lolos.
  const events = bus.subscribe({ sessionID, signal: controller.signal })
  const turn = prompt({
    sessionID,
    text,
    ...(options.auto === true ? { auto: true } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  }).catch((error: unknown) => {
    if (error instanceof AgentError) fail(error.message)
    throw error
  })

  process.stderr.write(`session: ${sessionID}\n\n`)
  const printedToolStates = new Set<string>()

  for await (const event of events) {
    switch (event.type) {
      case "text.delta":
        process.stdout.write(event.text)
        break
      case "message.updated": {
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
      case "session.error":
        process.stderr.write(`\ntitah: ${event.message}\n`)
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
  process.stdout.write("\n")
  if (assistant?.usage) {
    process.stderr.write(
      `\n${assistant.usage.input ?? "?"} in / ${assistant.usage.output ?? "?"} out\n`,
    )
  }
  process.exit(assistant?.error ? 1 : 0)
}

/**
 * Onboarding (Q27). Urutan sengaja: deteksi environment → probe endpoint lokal
 * → baru bertanya. Setiap pertanyaan yang bisa dijawab sendiri oleh Titah adalah
 * pertanyaan yang tidak perlu ditanyakan.
 */
async function cmdInit(auto: boolean): Promise<void> {
  const existing = globalConfigFile()
  if (fs.existsSync(existing)) {
    fail(`Config already exists at ${existing}. Edit it directly, or delete it to start over.`)
  }

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
