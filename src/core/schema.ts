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
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Context window in tokens. Required for automatic compaction on this model."),
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
 *
 * `mode` (di bawah) membuka jalur spawning sub-agent lewat tool `task` — lihat
 * `dispatchableAgents`/`runSubagent` di subagent.ts. Kedalamannya tetap
 * DIBATASI SATU TINGKAT: sub-agent tidak pernah mewarisi tool `task`, jadi
 * tidak ada konkurensi rekursif tanpa batas, meski spawning-nya sendiri ada.
 */
export const Agent = z
  .object({
    description: z.string().optional().describe("Shown in the agent picker"),
    mode: z
      .enum(["primary", "subagent", "all"])
      .default("primary")
      .describe(
        'Where this agent may run. "primary" is selectable with Tab; "subagent" can be ' +
          'dispatched by the coordinator; "all" is both.',
      ),
    delegate: z
      .string()
      .optional()
      .describe(
        'Run this agent by spawning an external CLI from `externalAgent` instead of Titah\'s ' +
          "own loop. Mutually exclusive with `model`. Titah's `permission` block is NOT " +
          "enforced on the external CLI, which applies its own policy — so a delegating " +
          "agent always counts as a writer and is serialised with the other writers.",
      ),
    prompt: z.string().optional().describe("Appended to the system prompt"),
    model: z.string().optional().describe("Model override, in \"provider/model\" form"),
    steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum agentic iterations for this agent before it is forced to answer in text",
      ),
    tools: z
      .record(z.string(), z.boolean())
      .default({})
      .describe('Tool filter, e.g. {"write": false}. Tools not listed stay enabled.'),
    skills: z
      .array(z.string())
      .default([])
      .describe(
        'Skill ids ("namespace:name", as listed by /skills) whose full content is loaded ' +
          "into this agent's system prompt. Bare names never match.",
      ),
    permission: z
      .object({
        edit: z.enum(["ask", "allow", "deny"]).optional(),
        write: z.enum(["ask", "allow", "deny"]).optional(),
        bash: z.enum(["ask", "allow", "deny"]).optional(),
        network: z.enum(["ask", "allow", "deny"]).optional(),
        delete: z.enum(["ask", "allow", "deny"]).optional(),
        mcp: z.enum(["ask", "allow", "deny"]).optional(),
        allowlist: z.array(z.string()).optional(),
      })
      .optional()
      .describe(
        "Permission override for this agent, on top of the global `permission`. " +
          "This is what separates Build Auto from Build Manual.",
      ),
  })
  .superRefine((agent, ctx) => {
    // Satu agent, satu mesin. Menyetel keduanya berarti tidak ada jawaban atas
    // "mana yang dipakai", dan diam-diam memilih salah satunya menyembunyikan
    // kesalahan konfigurasi yang nyata.
    if (agent.delegate !== undefined && agent.model !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "An agent cannot set both `delegate` and `model` — it has one engine, not two.",
      })
    }
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
    /*
     * Sumbu untuk `webfetch` dan `websearch`.
     *
     * Ia ada terpisah bukan karena berbahaya bagi berkas — ia tidak menyentuh
     * berkas sama sekali — melainkan karena ini satu-satunya kelas tool yang
     * mengirim isi repo KELUAR dari mesin. Tidak satu pun dari tiga sumbu di
     * atas menyatakan itu, dan `docs/gap-analysis.md` sudah memperingatkannya
     * sebelum tool webnya ada.
     */
    network: z.enum(["ask", "allow", "deny"]).default("ask"),
    /*
     * Sumbu untuk `remove`. Menghapus bukan menulis.
     *
     * Agent dengan `write: allow` yang dimaksudkan sebagai "boleh membuat berkas
     * baru" tidak pernah dimaksudkan sebagai "boleh menghapus berkas saya".
     */
    delete: z.enum(["ask", "allow", "deny"]).default("ask"),
    /*
     * Sumbu untuk tool yang datang dari server MCP.
     *
     * Sumbu SENDIRI karena tool MCP adalah kode yang tidak ditulis Titah dan
     * tidak bisa diklasifikasikan Titah: sebuah server boleh menulis berkas,
     * memanggil API berbayar, atau keduanya. Tidak satu pun dari sumbu di atas
     * jujur menggambarkan itu, dan memaksanya ke salah satu berarti user
     * memberi izin untuk hal yang berbeda dari yang sebenarnya terjadi.
     */
    mcp: z.enum(["ask", "allow", "deny"]).default("ask"),
    allowlist: z
      .array(z.string())
      .default([])
      .describe("Command patterns that are always allowed, e.g. \"git *\""),
  })
  .describe("Deny by default. With no client connected, every ask becomes a deny.")

export const Compaction = z
  .object({
    auto: z.boolean().default(true).describe("Compact automatically when the context fills up"),
    reserved: z
      .number()
      .int()
      .min(0)
      .default(8192)
      .describe(
        "Tokens held back from the window for the next response and for the summarisation call. " +
          "It does NOT cover the growth of the next step: one more tool result is budgeted " +
          "separately, from the largest one seen so far in the running turn. " +
          "Capped at a quarter of the window in use.",
      ),
    tailTurns: z
      .number()
      .int()
      .min(0)
      .default(2)
      .describe("Recent user turns kept verbatim, never summarised"),
    prune: z
      .boolean()
      .default(true)
      .describe("Drop old tool output before summarising — free, and tool output is the bulk of it"),
  })
  .describe("Automatic context compaction. Requires contextWindow on the model in use.")

/**
 * Backend pencarian web.
 *
 * Tidak ada mesin pencari yang bisa dipakai tanpa syarat, jadi backendnya
 * dinyatakan alih-alih ditebak. `ddg` jalan tanpa kunci dan karena itu jadi
 * bawaan — tapi ia mengurai HTML milik orang lain, dan HTML itu boleh berubah
 * kapan saja. Kerapuhan itu dinyatakan di deskripsi tool dan di `titah doctor`,
 * bukan disembunyikan: backend yang diam-diam berhenti bekerja lebih buruk
 * daripada backend yang menyatakan dirinya rapuh.
 */
export const Search = z
  .object({
    backend: z.enum(["ddg", "brave", "tavily"]).default("ddg"),
    apiKey: z
      .string()
      .optional()
      .describe("Required by brave and tavily. Prefer `${env:VAR_NAME}` over a literal."),
  })
  .describe("Web search backend for the `websearch` tool")

/**
 * Pemeriksa proyek untuk tool `diagnostics`.
 *
 * Dinyatakan, tidak pernah ditebak. Menebak `tsc` lalu gagal karena proyeknya
 * memakai `deno check` menghasilkan pesan error yang jauh lebih membingungkan
 * daripada "belum dikonfigurasi" — aturan yang sama dengan `contextWindow`.
 */
export const Diagnostics = z
  .object({
    command: z
      .string()
      .describe('Checker to run, e.g. "npm run typecheck" or "cargo clippy"'),
  })
  .describe("Project checker for the `diagnostics` tool")

/**
 * Server MCP lewat stdio.
 *
 * Hanya stdio, dan hanya `tools`. Itu yang menutup gap-nya: server MCP yang
 * dipasang orang hampir selalu stdio, dan yang dicari darinya hampir selalu
 * tool. Menyatakan batasnya lebih baik daripada membangun setengah dari
 * segalanya — yang setengah jadi terlihat sama dengan yang jadi, sampai dipakai.
 */
export const McpServerConfig = z.object({
  command: z.string().describe("Executable that speaks MCP over stdio"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
})

/**
 * Language server per bahasa, untuk diagnostics OTOMATIS setelah menyunting.
 *
 * Dinyatakan, tidak ditebak — aturan yang sama dengan `contextWindow` dan
 * `diagnostics.command`. Menebak `typescript-language-server` pada proyek yang
 * memakai `deno lsp` gagal dengan cara yang jauh lebih membingungkan daripada
 * tidak ada language server sama sekali.
 */
export const LspServerConfig = z.object({
  command: z.string().describe('Language server binary, e.g. "typescript-language-server"'),
  args: z.array(z.string()).default([]),
  extensions: z
    .array(z.string())
    .describe('File extensions it handles, e.g. [".ts", ".tsx"]'),
  enabled: z.boolean().default(true),
})

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
  command: z
    .record(z.string(), Command)
    .default({})
    .superRefine((commands, ctx) => {
      for (const name of Object.keys(commands)) {
        if (!name.includes(":")) continue
        ctx.addIssue({
          code: "custom",
          // `:` milik ruang nama skill. Membiarkannya di sini berarti dua hal
          // berbeda bisa menjawab nama yang sama.
          message: `Command name "${name}" must not contain a colon — that is reserved for skills (plugin:skill).`,
        })
      }
    }),
  skills: Skills.default({ discover: ["claude", "opencode"], paths: [], always: [] }),
  defaultAgent: z
    .string()
    .optional()
    .describe("Agent used when none is selected"),
  permission: Permission.default({
    edit: "ask",
    write: "ask",
    bash: "ask",
    network: "ask",
    delete: "ask",
    mcp: "ask",
    allowlist: [],
  }),
  search: Search.default({ backend: "ddg" }),
  diagnostics: Diagnostics.optional(),
  mcp: z.record(z.string(), McpServerConfig).default({}),
  lsp: z.record(z.string(), LspServerConfig).default({}),
  compaction: Compaction.default({ auto: true, reserved: 8192, tailTurns: 2, prune: true }),
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
export type Compaction = z.infer<typeof Compaction>
export type Search = z.infer<typeof Search>
export type Diagnostics = z.infer<typeof Diagnostics>
export type McpServerConfig = z.infer<typeof McpServerConfig>
export type LspServerConfig = z.infer<typeof LspServerConfig>

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
    //
    // `delete` ikut ditolak: mode ini menjanjikan "tidak mengubah apa pun", dan
    // menghapus adalah bentuk mengubah yang paling tidak bisa ditarik kembali.
    //
    // `network` sengaja TIDAK ditolak, dan itu bukan kelalaian. Membaca
    // dokumentasi sebelum menyusun rencana justru pekerjaan mode ini; ia tidak
    // mengubah apa pun di mesin, jadi ia mengikuti kebijakan global user.
    permission: { edit: "deny", write: "deny", bash: "deny", delete: "deny", mcp: "deny" },
  },
  build: {
    description: "Build Manual — do the work, confirm every change",
    prompt:
      "Carry out the user's request directly.\n\n" +
      "Read files before changing them. Keep changes as small and targeted as possible. " +
      "Each change is confirmed by the user one at a time — that is deliberate, so do " +
      "not batch many changes into one large step.",
    permission: { edit: "ask", write: "ask", bash: "ask", network: "ask", delete: "ask", mcp: "ask" },
  },
  "build-auto": {
    description: "Build Auto — work autonomously, no confirmations",
    prompt:
      "Carry the user's request through to completion without waiting for approval.\n\n" +
      "Since nobody is checking each step, the responsibility is yours: read before " +
      "changing, run the tests after changing, and report failures exactly as they are. " +
      "Never claim success without verifying it.",
    // Termasuk `delete` dan `network`, dan itu memang arti "no confirmations".
    // Tidak ada risiko baru yang ditambahkan keduanya di sini: mode ini sudah
    // punya `bash: allow`, yang bisa menghapus dan mengunduh apa pun.
    permission: {
      edit: "allow",
      write: "allow",
      bash: "allow",
      network: "allow",
      delete: "allow",
      mcp: "allow",
    },
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
