import { z } from "zod"

/**
 * Sumber kebenaran tunggal untuk bentuk konfigurasi. `config.schema.json`
 * digenerate dari sini (`npm run schema`) supaya schema yang dipublikasikan
 * tidak pernah melenceng dari validasi runtime.
 */

export const ProviderOptions = z
  .object({
    baseURL: z.string().optional().describe("Endpoint base URL, e.g. https://host/v1"),
    apiKey: z
      .string()
      .optional()
      .describe(
        "API key. Prefer `${env:VAR_NAME}` or auth.json — do not put plaintext here.",
      ),
    headers: z.record(z.string(), z.string()).optional(),
    includeUsage: z
      .boolean()
      .default(true)
      .describe(
        "Ask for token usage while streaming (stream_options.include_usage). " +
          "Turn off if your endpoint rejects that field.",
      ),
  })
  .describe("Options passed to the AI SDK provider factory")

export const ProviderModel = z.object({
  name: z.string().optional().describe("Display name for this model"),
})

export const Provider = z.object({
  name: z.string().optional().describe("Provider display name"),
  npm: z
    .enum(["@ai-sdk/openai-compatible", "@ai-sdk/anthropic"])
    .default("@ai-sdk/openai-compatible")
    .describe("AI SDK package to use. openai-compatible is the default."),
  options: ProviderOptions.optional(),
  models: z.record(z.string(), ProviderModel).default({}),
})

/**
 * Registry agent eksternal (Q7). Menambah agent ketiga = menyunting blok ini,
 * bukan menyentuh core. Dipakai penuh mulai M4.
 */
export const ExternalAgent = z.object({
  command: z.string().describe("Executable to invoke, e.g. \"claude\""),
  args: z
    .array(z.string())
    .default([])
    .describe("Arguments for the FIRST call. `{prompt}` and `{session}` are substituted."),
  resumeArgs: z
    .array(z.string())
    .default([])
    .describe("Arguments for resuming a session. Empty means reuse `args`."),
  sessionMode: z
    .enum(["generate", "discover"])
    .default("discover")
    .describe(
      '"generate": Titah creates a UUID and hands it to the CLI (Claude Code style). ' +
        '"discover": the session id is read from the first call\'s output (opencode style).',
    ),
  format: z
    .enum(["stream-json", "json", "text"])
    .default("stream-json")
    .describe("Output format expected from the CLI"),
  timeout: z
    .number()
    .int()
    .positive()
    .default(600_000)
    .describe("Timeout in milliseconds. Defaults to 10 minutes."),
  enabled: z.boolean().default(true),
})

/**
 * Definisi agent internal (Q21): prompt + filter tool + override model per nama.
 * TANPA subagent spawning — tidak ada konkurensi rekursif di v1.
 */
export const Agent = z.object({
  description: z.string().optional().describe("Shown in the agent picker"),
  prompt: z.string().optional().describe("Appended to the system prompt"),
  model: z.string().optional().describe("Model override, in \"provider/model\" form"),
  tools: z
    .record(z.string(), z.boolean())
    .default({})
    .describe('Tool filter, e.g. {"write": false}. Tools not listed stay enabled.'),
  skills: z
    .array(z.string())
    .default([])
    .describe("Skill names whose full content is loaded into this agent's system prompt"),
  permission: z
    .object({
      edit: z.enum(["ask", "allow", "deny"]).optional(),
      write: z.enum(["ask", "allow", "deny"]).optional(),
      bash: z.enum(["ask", "allow", "deny"]).optional(),
      allowlist: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "Permission override for this agent, on top of the global `permission`. " +
        "This is what separates Build Auto from Build Manual.",
    ),
})

/** Custom command: template prompt yang dipanggil dengan `/nama <input>`. */
export const Command = z.object({
  template: z
    .string()
    .describe('Prompt template. `{{.Input}}` or `$ARGUMENTS` is replaced with the argument.'),
  description: z.string().optional(),
  agent: z.string().optional().describe("Agent that runs this command"),
  model: z.string().optional(),
})

const SkillPath = z.union([
  z.string(),
  z.object({
    path: z.string(),
    as: z.string().optional().describe("Namespace override; derived from the folder when omitted"),
  }),
])

export const Skills = z.object({
  discover: z
    .array(z.enum(["claude", "opencode"]))
    .default(["claude", "opencode"])
    .describe("Read Claude Code and opencode registries so installed skills work without configuration"),
  paths: z
    .array(SkillPath)
    .default([])
    .describe("Directories containing skills. Supports <dir>/<name>/SKILL.md and <dir>/<name>.md"),
  always: z
    .array(z.string())
    .default([])
    .describe('Skill ids loaded in full every turn, e.g. "superpowers:using-superpowers"'),
})

export const Permission = z
  .object({
    edit: z.enum(["ask", "allow", "deny"]).default("ask"),
    write: z.enum(["ask", "allow", "deny"]).default("ask"),
    bash: z.enum(["ask", "allow", "deny"]).default("ask"),
    allowlist: z
      .array(z.string())
      .default([])
      .describe("Command patterns that are always allowed, e.g. \"git *\""),
  })
  .describe("Deny by default. With no client connected, every ask becomes a deny.")

export const Config = z.object({
  $schema: z.string().optional(),
  model: z
    .string()
    .optional()
    .describe("Default model, in \"provider/model\" form. Nothing is guessed."),
  smallModel: z
    .string()
    .optional()
    .describe("Cheap model for light work (session titles, compaction summaries)"),
  provider: z.record(z.string(), Provider).default({}),
  externalAgent: z.record(z.string(), ExternalAgent).default({}),
  agent: z.record(z.string(), Agent).default({}),
  command: z.record(z.string(), Command).default({}),
  skills: Skills.default({ discover: ["claude", "opencode"], paths: [], always: [] }),
  defaultAgent: z
    .string()
    .optional()
    .describe("Agent used when none is selected"),
  permission: Permission.default({ edit: "ask", write: "ask", bash: "ask", allowlist: [] }),
  keybinds: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'TUI keybinding overrides, e.g. {"session_interrupt": "ctrl+g"}. ' +
        'Defaults follow opencode; "none" disables an action.',
    ),
  instructions: z
    .array(z.string())
    .default([])
    .describe("Extra instruction file paths, beyond AGENTS.md/CLAUDE.md/TITAH.md"),
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
})

export type Config = z.infer<typeof Config>
export type Provider = z.infer<typeof Provider>
export type ExternalAgent = z.infer<typeof ExternalAgent>
export type Agent = z.infer<typeof Agent>
export type Command = z.infer<typeof Command>

/**
 * Tiga mode bawaan, mengikuti pola opencode (`plan` / `build`) tapi memisahkan
 * mode kerja menjadi dua karena keduanya berbeda secara mendasar: yang satu
 * meminta persetujuanmu tiap langkah, yang satu tidak sama sekali.
 *
 * Config user menang per-id, jadi menimpa salah satunya cukup dengan
 * mendefinisikan ulang id yang sama.
 */
export const DEFAULT_AGENTS: Record<string, z.input<typeof Agent>> = {
  plan: {
    description: "Plan — draft a plan only, never change anything",
    prompt:
      "Your job is to draft a plan, NOT to carry it out.\n\n" +
      "Read and explore as much as you need, then write a concrete plan: which files " +
      "change, what changes inside them, and in what order.\n\n" +
      "Every attempt to change a file or run a command WILL BE REFUSED — that is the " +
      "rule of this mode. If the user asks for one, explain that they need to switch " +
      "to Build mode (Tab in the TUI, or --agent build). Do not just fall silent.\n\n" +
      "End with numbered steps someone else could execute.",
    // Ditolak lewat IZIN, bukan dengan menghapus tool-nya.
    //
    // Kalau tool-nya dihilangkan, model kehabisan cara lalu berhenti tanpa
    // sepatah kata pun — terbukti saat diuji. Dengan penolakan eksplisit, ia
    // menerima alasan yang bisa diteruskan ke user. Sama amannya: izin
    // diperiksa sebelum eksekusi, jadi tidak ada yang pernah dijalankan.
    permission: { edit: "deny", write: "deny", bash: "deny" },
  },
  build: {
    description: "Build Manual — do the work, confirm every change",
    prompt:
      "Carry out the user's request directly.\n\n" +
      "Read files before changing them. Keep changes as small and targeted as possible. " +
      "Each change is confirmed by the user one at a time — that is deliberate, so do " +
      "not batch many changes into one large step.",
    permission: { edit: "ask", write: "ask", bash: "ask" },
  },
  "build-auto": {
    description: "Build Auto — work autonomously, no confirmations",
    prompt:
      "Carry the user's request through to completion without waiting for approval.\n\n" +
      "Since nobody is checking each step, the responsibility is yours: read before " +
      "changing, run the tests after changing, and report failures exactly as they are. " +
      "Never claim success without verifying it.",
    permission: { edit: "allow", write: "allow", bash: "allow" },
  },
}

/** Default yang dipasang saat tidak ada config sama sekali. */
/**
 * Argumen di sini diverifikasi langsung terhadap CLI yang terpasang, bukan
 * ditebak dari dokumentasi:
 *
 * - Claude Code MENOLAK `--output-format stream-json` tanpa `--verbose`.
 * - Claude memakai `--session-id <uuid>` untuk membuat, `--resume <uuid>` untuk
 *   melanjutkan — memberi `--session-id` yang sama dua kali bukan cara resume.
 * - opencode tidak menerima id sesi buatan kita; id-nya dibaca dari output
 *   panggilan pertama, lalu dikirim balik lewat `--session`.
 */
export const DEFAULT_EXTERNAL_AGENTS: Record<string, z.input<typeof ExternalAgent>> = {
  claude: {
    command: "claude",
    args: [
      "-p",
      "{prompt}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "{session}",
    ],
    resumeArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--resume", "{session}"],
    sessionMode: "generate",
    format: "stream-json",
  },
  opencode: {
    command: "opencode",
    args: ["run", "{prompt}", "--format", "json"],
    resumeArgs: ["run", "{prompt}", "--format", "json", "--session", "{session}"],
    sessionMode: "discover",
    format: "json",
  },
}
