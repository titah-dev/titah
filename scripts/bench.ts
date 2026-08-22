import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

/**
 * Benchmark tiga agent CLI pada tugas yang sama: titah, claude, opencode.
 *
 *   node scripts/bench.ts                      # semua tier, semua agent
 *   node scripts/bench.ts --tier T1,T2         # sebagian tier
 *   node scripts/bench.ts --agent titah        # sebagian agent
 *   node scripts/bench.ts --repeat 1           # lebih cepat, lebih berisik
 *   node scripts/bench.ts --dry-run            # cetak perintahnya, jangan jalankan
 *
 * Env: $TITAH_BENCH_BASE_URL mengarahkan provider opencode ke gateway lain —
 * kosongkan untuk memakai config opencode global apa adanya.
 *
 * Yang diukur, dan definisinya — karena tanpa definisi angkanya tidak bisa
 * dibandingkan:
 *
 *   latency  Wall-clock dari luar: proses lahir sampai proses mati. Bukan angka
 *            yang dilaporkan agent-nya sendiri (`duration_ms` milik Claude Code
 *            tidak menghitung waktu startnya), supaya satuannya sama bertiga.
 *
 *   token    Σ input + Σ output atas SELURUH panggilan model dalam satu giliran,
 *            cache read/write ikut dihitung sebagai input karena tetap dikirim
 *            lewat kabel. Ini yang menentukan tagihan, bukan ukuran konteks.
 *
 *   tool     Nama tool yang benar-benar dipanggil, bukan yang tersedia.
 *
 * Setiap agent jalan di git worktree-nya sendiri: repo yang sama persis, dan
 * tugas T4 yang menulis file tidak pernah menyentuh working tree Anda.
 */

const ROOT = resolve(import.meta.dirname, "..")
const WORKDIR = join(tmpdir(), "titah-bench")

interface Tier {
  id: string
  label: string
  prompt: string
  /** Tugas ini menulis file, jadi hanya sekali jalan dan hasilnya diperiksa. */
  writes?: boolean
  timeoutMs: number
}

const TIERS: Tier[] = [
  {
    id: "T1",
    label: "biaya tetap (tanpa tool)",
    prompt:
      "Reply with exactly the word OK and nothing else. Do not use any tool.",
    timeoutMs: 180_000,
  },
  {
    id: "T2",
    label: "satu round-trip tool",
    prompt:
      'What is the "version" field in package.json in this repository? Answer with the version string only.',
    timeoutMs: 240_000,
  },
  {
    id: "T3",
    label: "loop tool read-only",
    prompt:
      "List every CLI subcommand that src/cli.ts dispatches on, and for each one the line number where it is dispatched. Do not modify any file.",
    timeoutMs: 420_000,
  },
  {
    id: "T4",
    label: "menulis kode + test",
    prompt:
      "Create src/core/format-duration.ts exporting `formatDuration(ms: number): string`, " +
      "which renders a millisecond count as a compact human string: " +
      "under a second as `940ms`, under a minute as `1.2s`, otherwise as `3m 04s`. " +
      "Add test/format-duration.test.ts using node:test and node:assert covering those three shapes. " +
      "Then run `npm test` and make sure it passes before you finish.",
    writes: true,
    timeoutMs: 1_200_000,
  },
]

interface Parsed {
  text: string
  inputTokens?: number
  outputTokens?: number
  /** Konteks pada panggilan terakhir, kalau agent-nya melaporkannya. */
  contextTokens?: number
  costUsd?: number
  tools: string[]
  model?: string
  /** Angka durasi versi agent itu sendiri, untuk dibandingkan dengan wall-clock. */
  selfReportedMs?: number
}

interface AgentSpec {
  id: string
  /** Diisi saat runtime dari `--version`. */
  version?: string
  model: string
  argv: (tier: Tier) => string[]
  command: string
  env?: () => Record<string, string>
  parse: (stdout: string, stderr: string) => Parsed
}

/** Baris NDJSON yang bisa diurai; sisanya dibuang tanpa mengorbankan seluruh run. */
function ndjson(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Baris terpotong di ujung stream. Diabaikan.
    }
  }
  return out
}

/** Override baseURL provider opencode; kosong berarti pakai config global. */
const OPENCODE_BASE_URL = process.env.TITAH_BENCH_BASE_URL
const MODEL_9ROUTER = "9router/ant"

/**
 * Config opencode dengan `baseURL` provider yang bisa dijangkau.
 *
 * Kalau $TITAH_BENCH_BASE_URL diset, salinan config global ditulis ke direktori
 * kerja benchmark dengan baseURL itu, lalu dipakai lewat $OPENCODE_CONFIG —
 * yang di-MERGE di atas config global, bukan menggantikannya. Config milik
 * pengguna tidak pernah disentuh.
 *
 * Kalau tidak diset, config global dipakai apa adanya. Perlu diketahui: kalau
 * config itu menunjuk host yang tidak menjawab, opencode mencoba ulang
 * diam-diam sampai timeout — bukan error. Tier yang TIMEOUT tanpa sebab lain
 * biasanya ini, bukan agent-nya yang lambat.
 */
function opencodeConfig(): string | undefined {
  if (!OPENCODE_BASE_URL) return undefined
  const source = join(homedir(), ".config", "opencode", "opencode.json")
  const patched = join(WORKDIR, "opencode-bench.json")
  const config = (existsSync(source)
    ? JSON.parse(readFileSync(source, "utf8"))
    : {}) as { provider?: Record<string, { options?: Record<string, unknown> }> }
  const provider = MODEL_9ROUTER.split("/")[0]!
  config.provider ??= {}
  const entry = (config.provider[provider] ??= {})
  entry.options = { ...entry.options, baseURL: OPENCODE_BASE_URL }
  writeFileSync(patched, JSON.stringify(config, null, 2))
  return patched
}

const AGENTS: AgentSpec[] = [
  {
    id: "titah",
    model: MODEL_9ROUTER,
    command: process.execPath,
    argv: (_tier) => [
      join(ROOT, "dist", "cli.js"),
      "run",
      _tier.prompt,
      "--model",
      MODEL_9ROUTER,
      "--output-format",
      "json",
      "--auto",
    ],
    parse: (stdout) => {
      const start = stdout.indexOf("{")
      const result = start < 0 ? {} : (JSON.parse(stdout.slice(start)) as {
        text?: string
        model?: string
        tools?: { tool: string }[]
        usage?: { input?: number; output?: number; context?: number }
      })
      return {
        text: result.text ?? "",
        model: result.model,
        tools: (result.tools ?? []).map((t) => t.tool),
        inputTokens: result.usage?.input,
        outputTokens: result.usage?.output,
        contextTokens: result.usage?.context,
      }
    },
  },
  {
    id: "claude",
    // Sesuai keputusan "as-configured": langganan Anthropic milik pengguna,
    // bukan diarahkan ke gateway. Nama modelnya dibaca dari hasil, bukan ditebak.
    model: "(as configured)",
    command: "claude",
    argv: (tier) => [
      "-p",
      tier.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Auto-approve di SEMUA tier, bukan hanya yang menulis: kalau satu agent
      // meminta izin sementara dua lainnya tidak, yang terukur adalah kebijakan
      // izinnya, bukan biaya kerjanya. Semuanya jalan di worktree buangan.
      "--permission-mode",
      "bypassPermissions",
    ],
    parse: (stdout) => {
      const events = ndjson(stdout) as Record<string, any>[]
      const tools: string[] = []
      let text = ""
      let parsed: Parsed | undefined

      for (const event of events) {
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use") tools.push(String(block.name))
          }
        }
        if (event.type === "result") {
          const usage = event.usage ?? {}
          const input =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
          text = String(event.result ?? "")
          parsed = {
            text,
            tools,
            inputTokens: input,
            outputTokens: usage.output_tokens,
            costUsd: event.total_cost_usd,
            model: Object.keys(event.modelUsage ?? {})[0],
            selfReportedMs: event.duration_ms,
          }
        }
      }
      return parsed ?? { text, tools }
    },
  },
  {
    id: "opencode",
    model: MODEL_9ROUTER,
    command: "opencode",
    env: () => {
      const config = opencodeConfig()
      return config ? { OPENCODE_CONFIG: config } : {}
    },
    argv: (tier) => [
      "run",
      tier.prompt,
      "--model",
      MODEL_9ROUTER,
      "--format",
      "json",
      "--auto",
    ],
    parse: (stdout) => {
      const events = ndjson(stdout) as Record<string, any>[]
      const tools: string[] = []
      const texts: string[] = []
      let input = 0
      let output = 0
      let context: number | undefined
      let cost = 0

      for (const event of events) {
        const part = event.part ?? {}
        if (part.type === "tool" && part.tool) tools.push(String(part.tool))
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text)
        if (part.type === "step-finish" && part.tokens) {
          // Setiap langkah melaporkan konteksnya sendiri; yang ditagih adalah
          // jumlahnya, yang mengisi jendela adalah langkah terakhir.
          input += (part.tokens.input ?? 0) + (part.tokens.cache?.read ?? 0) +
            (part.tokens.cache?.write ?? 0)
          output += (part.tokens.output ?? 0) + (part.tokens.reasoning ?? 0)
          context = part.tokens.input ?? context
          cost += part.cost ?? 0
        }
      }
      return {
        text: texts.join(""),
        tools,
        inputTokens: input,
        outputTokens: output,
        contextTokens: context,
        costUsd: cost,
      }
    },
  },
]

interface RunResult {
  agent: string
  tier: string
  attempt: number
  ok: boolean
  latencyMs: number
  timedOut: boolean
  exitCode: number | null
  parsed: Parsed
  /** Hanya untuk T4: apakah hasilnya benar-benar lulus. */
  verdict?: { fileExists: boolean; testExists: boolean; npmTest: boolean }
  stderrTail?: string
}

function sh(command: string, args: string[], cwd = ROOT): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/**
 * Worktree bersih per agent, dengan node_modules dipinjam lewat symlink supaya
 * `npm test` di T4 tidak perlu install ulang tiga kali.
 */
function makeWorktree(agent: string): string {
  const path = join(WORKDIR, `wt-${agent}`)
  if (existsSync(path)) removeWorktree(path)
  sh("git", ["worktree", "add", "--detach", "--force", path, "HEAD"])
  const modules = join(path, "node_modules")
  if (!existsSync(modules)) symlinkSync(join(ROOT, "node_modules"), modules, "dir")
  return path
}

function removeWorktree(path: string): void {
  try {
    sh("git", ["worktree", "remove", "--force", path])
  } catch {
    rmSync(path, { recursive: true, force: true })
    try {
      sh("git", ["worktree", "prune"])
    } catch {
      // Tidak ada yang bisa dilakukan lagi; direktorinya sudah hilang.
    }
  }
}

/** Kembalikan worktree ke keadaan HEAD, tanpa membuang symlink node_modules. */
function resetWorktree(path: string): void {
  sh("git", ["checkout", "--", "."], path)
  sh("git", ["clean", "-fdx", "-e", "node_modules"], path)
}

function runOnce(
  agent: AgentSpec,
  tier: Tier,
  cwd: string,
  attempt: number,
  dryRun: boolean,
): Promise<RunResult> {
  const argv = agent.argv(tier)
  if (dryRun) {
    process.stdout.write(`  ${agent.command} ${argv.map((a) => JSON.stringify(a)).join(" ")}\n`)
    return Promise.resolve({
      agent: agent.id,
      tier: tier.id,
      attempt,
      ok: true,
      latencyMs: 0,
      timedOut: false,
      exitCode: 0,
      parsed: { text: "", tools: [] },
    })
  }

  return new Promise((done) => {
    const started = process.hrtime.bigint()
    const child = spawn(agent.command, argv, {
      cwd,
      // stdin DITUTUP, tidak diwariskan: `opencode run --format json` menunggu
      // stdin selamanya kalau ia masih terbuka, dan tidak pernah mengirim
      // permintaannya. Ini bukan kelambatan, ini deadlock.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(agent.env?.() ?? {}) },
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, tier.timeoutMs)

    child.on("close", (code) => {
      clearTimeout(timer)
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6
      let parsed: Parsed = { text: "", tools: [] }
      try {
        parsed = agent.parse(stdout, stderr)
      } catch (error) {
        stderr += `\n[bench] parse failed: ${String(error)}`
      }
      done({
        agent: agent.id,
        tier: tier.id,
        attempt,
        ok: code === 0 && !timedOut,
        latencyMs,
        timedOut,
        exitCode: code,
        parsed,
        ...(stderr.trim() ? { stderrTail: stderr.trim().slice(-400) } : {}),
      })
    })
  })
}

/** Apakah T4 benar-benar menghasilkan kode yang lulus, bukan sekadar selesai. */
function verdictT4(cwd: string): RunResult["verdict"] {
  const fileExists = existsSync(join(cwd, "src", "core", "format-duration.ts"))
  const testExists = existsSync(join(cwd, "test", "format-duration.test.ts"))
  let npmTest = false
  if (fileExists && testExists) {
    try {
      sh("npm", ["test", "--silent"], cwd)
      npmTest = true
    } catch {
      npmTest = false
    }
  }
  return { fileExists, testExists, npmTest }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function versionOf(agent: AgentSpec): string {
  try {
    if (agent.id === "titah") return sh(process.execPath, [join(ROOT, "dist", "cli.js"), "--version"]).trim()
    return sh(agent.command, ["--version"]).trim().split("\n")[0]!.trim()
  } catch {
    return "(unknown)"
  }
}

const { values } = parseArgs({
  options: {
    tier: { type: "string" },
    agent: { type: "string" },
    repeat: { type: "string" },
    out: { type: "string", short: "o" },
    "dry-run": { type: "boolean" },
  },
})

const dryRun = values["dry-run"] === true
const repeat = Number(values.repeat ?? 3)
const tiers = values.tier
  ? TIERS.filter((t) => values.tier!.split(",").includes(t.id))
  : TIERS
const agents = values.agent
  ? AGENTS.filter((a) => values.agent!.split(",").includes(a.id))
  : AGENTS

if (tiers.length === 0 || agents.length === 0) {
  process.stderr.write("Nothing selected. Check --tier / --agent.\n")
  process.exit(1)
}

mkdirSync(WORKDIR, { recursive: true })
for (const agent of agents) agent.version = versionOf(agent)

process.stderr.write(`workdir : ${WORKDIR}\n`)
process.stderr.write(`agents  : ${agents.map((a) => `${a.id} ${a.version}`).join(" · ")}\n`)
process.stderr.write(`tiers   : ${tiers.map((t) => t.id).join(", ")} · repeat ${repeat}\n\n`)

const results: RunResult[] = []
const worktrees = new Map<string, string>()

for (const tier of tiers) {
  const attempts = tier.writes ? 1 : repeat
  for (const agent of agents) {
    if (!worktrees.has(agent.id) && !dryRun) worktrees.set(agent.id, makeWorktree(agent.id))
    const cwd = worktrees.get(agent.id) ?? ROOT

    for (let attempt = 1; attempt <= attempts; attempt++) {
      process.stderr.write(`${tier.id} ${agent.id} #${attempt} ... `)
      if (!dryRun && tier.writes) resetWorktree(cwd)
      const result = await runOnce(agent, tier, cwd, attempt, dryRun)
      if (!dryRun && tier.writes) result.verdict = verdictT4(cwd)
      results.push(result)
      const tokens = `${result.parsed.inputTokens ?? "?"} in / ${result.parsed.outputTokens ?? "?"} out`
      const state = result.timedOut ? "TIMEOUT" : result.ok ? "ok" : `exit ${result.exitCode}`
      process.stderr.write(
        `${state} · ${(result.latencyMs / 1000).toFixed(1)}s · ${tokens} · ` +
          `${result.parsed.tools.length} tool call(s)\n`,
      )
    }
  }
}

if (!dryRun) for (const path of worktrees.values()) removeWorktree(path)

// --- ringkasan -------------------------------------------------------------

const rows: string[] = []
rows.push("| Tier | Agent | Model | Latency (median) | Token in | Token out | Tool calls | Lulus |")
rows.push("|---|---|---|---:|---:|---:|---:|---|")
for (const tier of tiers) {
  for (const agent of agents) {
    const runs = results.filter((r) => r.tier === tier.id && r.agent === agent.id)
    if (runs.length === 0) continue
    const ok = runs.filter((r) => r.ok)
    const model = ok[0]?.parsed.model ?? agent.model
    const verdict = runs[0]?.verdict
    const passed = verdict
      ? verdict.npmTest
        ? "test hijau"
        : verdict.fileExists
          ? "file ada, test merah"
          : "tidak"
      : ok.length === runs.length
        ? "—"
        : `${ok.length}/${runs.length} run`
    rows.push(
      `| ${tier.id} | ${agent.id} | ${model} | ` +
        `${(median(ok.map((r) => r.latencyMs)) / 1000).toFixed(1)}s | ` +
        `${Math.round(median(ok.map((r) => r.parsed.inputTokens ?? Number.NaN)))} | ` +
        `${Math.round(median(ok.map((r) => r.parsed.outputTokens ?? Number.NaN)))} | ` +
        `${median(ok.map((r) => r.parsed.tools.length))} | ${passed} |`,
    )
  }
}

process.stdout.write(`${rows.join("\n")}\n`)

const outPath = values.out ?? join(ROOT, "docs", "bench", "raw.json")
mkdirSync(join(outPath, ".."), { recursive: true })
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, node: process.version },
      agents: agents.map((a) => ({ id: a.id, version: a.version, model: a.model })),
      tiers: tiers.map((t) => ({ id: t.id, label: t.label, prompt: t.prompt })),
      repeat,
      results,
    },
    null,
    2,
  )}\n`,
)
process.stderr.write(`\nraw     : ${outPath}\n`)
