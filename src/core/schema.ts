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
  /**
   * Kirim `cache_control` di badan permintaan, untuk gateway OpenAI-compatible
   * yang meneruskannya ke Anthropic.
   *
   * DINYATAKAN, tidak ditebak — aturan yang sama dengan `contextWindow`.
   * Titah tidak punya cara mengetahui apa yang ada di balik sebuah baseURL:
   * gateway yang meneruskan ke Anthropic dan endpoint vLLM yang meng-cache
   * sendiri terlihat persis sama dari sini. Menebak salah ke arah "kirim" bisa
   * ditolak sebagian server; menebak salah ke arah sebaliknya diam-diam
   * membayar penuh untuk awalan yang sebenarnya bisa di-cache.
   *
   * Tidak diperlukan untuk `@ai-sdk/anthropic` (sudah lewat jalur resminya),
   * maupun untuk endpoint yang meng-cache awalan secara otomatis — di sana
   * urutan yang stabil sudah cukup, dan itu selalu dilakukan Titah.
   */
  cacheControl: z
    .boolean()
    .default(false)
    .describe(
      "Send cache_control in the request body. Only for OpenAI-compatible gateways that " +
        "forward it to Anthropic. Ask your gateway operator before turning this on.",
    ),
})

/**
 * Registry agent eksternal (Q7). Menambah agent ketiga = menyunting blok ini,
 * bukan menyentuh core. Dipakai penuh mulai M4.
 */
export const ExternalAgent = z.object({
  command: z.string().describe("Executable to invoke, e.g. \"claude\""),
  /**
   * Apa yang paling baik dikerjakan super agent ini.
   *
   * OPSIONAL di skema, tapi WAJIB untuk ikut `/tim` — dan pembedaan itu
   * disengaja.
   *
   * `externalAgent` melayani tiga hal: `@claude` yang diketik user,
   * `agent.delegate`, dan pembagian tugas `/tim`. Hanya yang ketiga yang
   * membutuhkan spesialis. Mewajibkannya di skema berarti menagih kalimat ini
   * dari orang yang hanya ingin mengetik `@claude` sesekali, untuk fitur yang
   * mungkin tidak pernah ia pakai.
   *
   * Yang dijaga tetap utuh: `/tim` TIDAK PERNAH membagi tugas berdasarkan nama
   * belaka. Super agent tanpa spesialis dilewati, dan `/tim` menyebutkan siapa
   * yang ia lewati — kegagalannya terlihat, bukan diam-diam.
   *
   * Ditulis untuk dibaca MODEL, bukan manusia: kalimat yang menyebut kekuatan
   * dan batasnya, bukan label satu kata.
   */
  specialist: z
    .string()
    .min(1)
    .optional()
    .describe(
      'What this agent is best at, e.g. "deep architectural reasoning, cross-module refactors". ' +
        "Used by /tim to decide who gets which part.",
    ),
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
    /**
     * Boleh meminta bantuan super agent, dan kapan.
     *
     * Berbeda dari `delegate`, dan bedanya menentukan: `delegate` mengganti
     * SELURUH mesin agent ini dengan CLI eksternal, sedangkan `escalate`
     * membiarkannya berjalan di loop Titah — dengan tool dan izin Titah — dan
     * hanya menyerahkan sebagian pekerjaan saat kriterianya terpenuhi.
     *
     * `when` ditulis USER dan dinilai MODEL. Titah tidak mengurainya; ia
     * ditempelkan apa adanya ke prompt agent ini, karena satu-satunya yang bisa
     * menilai "butuh pemahaman arsitektur" adalah yang sedang mengerjakannya.
     */
    escalate: z
      .object({
        to: z.string().describe("id di `externalAgent` yang boleh dimintai bantuan"),
        when: z
          .string()
          .min(1)
          .describe('Kriteria, dalam kalimat. Mis. "perubahan lintas modul, atau butuh memahami arsitektur dulu"'),
      })
      .optional(),
    prompt: z.string().optional().describe("Appended to the system prompt"),
    model: z.string().optional().describe("Model override, in \"provider/model\" form"),
    /*
     * Seberapa jauh jawaban ditutup dengan analisa.
     *
     * DIBIARKAN KOSONG bukan sama dengan `"low"`. Kosong berarti Titah tidak
     * menyebut panjang sama sekali dan modelnya yang memutuskan — itu perilaku
     * sebelum sumbu ini ada, dan ia harus tetap bisa dipilih. Karena itu tidak
     * ada `.default()` di sini: nilai bawaan apa pun akan diam-diam mengubah
     * setiap agent yang sudah ada.
     *
     * Namanya `effort`, bukan `reasoningEffort`, dan itu disengaja. Ia TIDAK
     * menyentuh anggaran penalaran model — kalau suatu hari Titah mengatur itu,
     * nama yang sudah terpakai untuk hal lain akan jadi jebakan. Yang diatur di
     * sini adalah seberapa banyak yang ditulis SESUDAH pekerjaan selesai.
     */
    effort: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "How much closing analysis each answer ends with. Unset means no limit — the model " +
          "decides. Cycle it live with ctrl+r.",
      ),
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
        external_directory: z.enum(["deny", "ask", "allow"]).optional(),
        doom_loop: z.enum(["ask", "allow", "deny"]).optional(),
        rules: z.record(z.string(), z.enum(["ask", "allow", "deny"])).optional(),
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
    // Agent yang SELURUHNYA dijalankan CLI eksternal tidak punya sisa untuk
    // dieskalasi: tidak ada loop Titah di dalamnya yang bisa memutuskan kapan.
    if (agent.delegate !== undefined && agent.escalate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "An agent cannot set both `delegate` and `escalate` — `delegate` already hands " +
          "every turn to an external CLI, so there is nothing left to escalate.",
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
    /*
     * Sumbu untuk path DI LUAR direktori kerja.
     *
     * Berbeda dari lima di atas: ia tidak pernah bawaan `ask`, melainkan
     * `deny`. Batas cwd sekarang ditegakkan `resolveInside` sebagai tembok
     * struktural yang tidak bisa salah, dan menjadikannya bisa ditanya berarti
     * menukar jaminan dengan kebijakan. Yang ditawarkan di sini bukan itu:
     * jalan keluarnya harus disebut PER PATH lewat `rules`, dan tidak ada
     * bentuk `allow` umum yang membuka segalanya.
     */
    external_directory: z.enum(["deny", "ask", "allow"]).default("deny"),
    /*
     * Sumbu untuk perulangan yang terdeteksi.
     *
     * Ia tidak pernah MENGIZINKAN apa pun — ia hanya menyela sesuatu yang sudah
     * diizinkan. Karena itu bawaannya `ask`: nilai `allow` berarti "jangan
     * pernah sela", dan `deny` berarti "hentikan begitu berputar".
     */
    doom_loop: z.enum(["ask", "allow", "deny"]).default("ask"),
    allowlist: z
      .array(z.string())
      .default([])
      .describe("Command patterns that are always allowed, e.g. \"git *\""),
    /*
     * Dimensi ARGUMEN: aturan yang melihat ke DALAM panggilan.
     *
     *   { "bash(git *)": "allow", "bash(git push *)": "deny",
     *     "webfetch(https://docs.*)": "allow",
     *     "external_directory(/Users/me/other-repo/*)": "allow" }
     *
     * Penilaiannya seluruhnya di `src/core/decide.ts`, satu fungsi, dan
     * `titah permission explain` memanggil fungsi yang SAMA — supaya yang
     * dijelaskan tidak pernah berbeda dari yang dijalankan.
     */
    rules: z
      .record(z.string(), z.enum(["ask", "allow", "deny"]))
      .default({})
      .describe(
        'Argument-level rules, e.g. {"bash(git *)": "allow"}. deny always wins; ' +
          "among ask and allow the most specific pattern wins.",
      ),
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
 * Akun Titah (login SSO ke titah-web).
 *
 * Hanya alamat servernya yang boleh ada di sini. Tokennya TIDAK — ia tinggal di
 * account.json bermode 0600, dengan alasan yang sama seperti kunci provider:
 * config adalah file yang orang tempel ke issue GitHub.
 */
export const Account = z
  .object({
    server: z
      .string()
      .optional()
      .describe(
        "Base URL of the titah-web instance used for `titah login`. " +
          "Overridden by $TITAH_ACCOUNT_SERVER.",
      ),
  })
  .describe("Titah account (SSO) settings. The token itself lives in account.json, never here.")

/**
 * Server MCP lewat stdio.
 *
 * Hanya stdio, dan hanya `tools`. Itu yang menutup gap-nya: server MCP yang
 * dipasang orang hampir selalu stdio, dan yang dicari darinya hampir selalu
 * tool. Menyatakan batasnya lebih baik daripada membangun setengah dari
 * segalanya — yang setengah jadi terlihat sama dengan yang jadi, sampai dipakai.
 */
export const McpServerConfig = z
  .object({
    command: z.string().optional().describe("Executable that speaks MCP over stdio"),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    /**
     * Server remote, bicara MCP lewat HTTP. Saling meniadakan dengan `command`.
     *
     * Satu endpoint untuk semuanya: permintaan dikirim POST, dan jawabannya
     * boleh berupa JSON biasa ATAU aliran `text/event-stream`. Server memilih
     * mana yang dipakai per permintaan, jadi klien harus siap keduanya.
     */
    url: z.string().optional().describe("HTTP endpoint of a remote MCP server"),
    /** Header tetap, mis. token statis: {"Authorization": "Bearer ${env:X}"}. */
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * Menyalakan OAuth untuk server ini.
     *
     * Token disimpan terpisah dari config dan tidak pernah ditulis ke sana —
     * `titah mcp login <id>` yang mengisinya. Server yang cukup dengan token
     * statis tidak perlu ini; isi `headers` saja.
     */
    oauth: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((entry, ctx) => {
    // Satu server, satu transport. Menyetel keduanya berarti tidak ada jawaban
    // atas "yang mana yang dipakai", dan diam-diam memilih salah satunya
    // menyembunyikan kesalahan konfigurasi yang nyata.
    const has = [entry.command !== undefined, entry.url !== undefined].filter(Boolean).length
    if (has !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          has === 0
            ? 'An MCP server needs either "command" (stdio) or "url" (remote HTTP).'
            : 'An MCP server has one transport: set "command" or "url", not both.',
      })
    }
    if (entry.oauth && entry.url === undefined) {
      ctx.addIssue({ code: "custom", message: '"oauth" only applies to remote servers with a "url".' })
    }
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
  /**
   * Memformat berkas otomatis setiap kali disunting, lewat
   * `textDocument/formatting`.
   *
   * Menyala secara bawaan, tapi hanya berlaku kalau server BILANG ia bisa
   * memformat — kapabilitasnya dibaca dari jawaban `initialize`, bukan
   * diasumsikan. Matikan kalau proyeknya punya pemformat sendiri dan dua
   * pemformat yang berbeda pendapat lebih buruk daripada tidak ada sama sekali.
   */
  format: z.boolean().default(true),
  /**
   * Dua angka yang WAJIB dikirim protokolnya bersama permintaan format.
   *
   * Kebanyakan language server mengabaikannya dan memakai konfigurasi proyek
   * (`.editorconfig`, prettier, gofmt), jadi ini bukan pilihan gaya — ia nilai
   * yang harus ada di dalam amplop. Yang benar-benar memakainya adalah server
   * tanpa konfigurasi proyek.
   */
  tabSize: z.number().int().positive().default(2),
  insertSpaces: z.boolean().default(true),
})

/**
 * Satu plugin, dikenali dari apa yang user tulis sebagai kuncinya.
 *
 * Tiga bentuk kunci: nama paket npm (`@acme/titah-prettier`), path berkas
 * (`./plugin/audit.ts`), atau `market:<id>` yang tempatnya sudah disediakan
 * tapi belum bisa diresolusi. Lihat `parsePluginSpec`.
 */
export const PluginConfig = z.object({
  /** Diteruskan apa adanya ke factory plugin; bentuknya milik plugin itu. */
  options: z.record(z.string(), z.unknown()).default({}),
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
    external_directory: "deny",
    doom_loop: "ask",
    allowlist: [],
    rules: {},
  }),
  search: Search.default({ backend: "ddg" }),
  account: Account.optional(),
  diagnostics: Diagnostics.optional(),
  mcp: z.record(z.string(), McpServerConfig).default({}),
  lsp: z.record(z.string(), LspServerConfig).default({}),
  /*
   * Plugin disebut SATU PER SATU, tidak pernah ditemukan otomatis dari
   * node_modules. Plugin berjalan di dalam proses ini tanpa sandbox, dan
   * "terpasang" tidak pernah berarti "dipercaya".
   */
  plugin: z.record(z.string(), PluginConfig).default({}),
  /**
   * Kapan pekerjaan diserahkan ke sub-agent.
   *
   * Ada karena tiga perbaikan sebelumnya semuanya berupa BUJUKAN — daftar tool
   * yang lengkap, prompt yang tidak menyuruh sebaliknya, kriteria yang bisa
   * dinilai. Bujukan menggeser peluang; ia tidak pernah memberi jaminan, dan
   * dua model berbeda tetap bisa memutuskan berbeda untuk prompt yang sama.
   * Sakelar ini yang memberi kepastian.
   *
   *   "ask"    — sesudah rencana ditulis, Titah menilai apakah pekerjaannya
   *              layak dipecah; kalau ya, model MENANYAKANNYA kepada user.
   *              Bawaan: keputusannya terlihat, bukan diam-diam.
   *   "auto"   — model memutuskan sendiri, tanpa bertanya.
   *   "always" — pekerjaan yang cocok SELALU diserahkan, tanpa bertanya.
   *   "never"  — tidak pernah; roster bahkan tidak dikirim ke model, jadi
   *              tidak ada token yang terbuang untuk daftar yang tak terpakai.
   */
  delegation: z
    .enum(["ask", "auto", "always", "never"])
    .default("ask")
    .describe(
      "When to hand work to sub-agents. ask: analyse after planning and ask you. " +
        "auto: the model decides silently. always: hand over matching work. never: off.",
    ),
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
export type Account = z.infer<typeof Account>
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
    description: "Plan — explore, analyse, and draft; no file edits",
    prompt:
      "Your job is to understand and to draft a plan, NOT to carry it out.\n\n" +
      "Explore as much as you need. Every reading tool works here, and so does the " +
      "shell: run the tests, read the git history, check the types, count the lines. " +
      "Analysing a codebase is exactly what this mode is for, and a plan written " +
      "without looking is a guess.\n\n" +
      "The file tools — edit, write, patch, move, remove — are refused in this mode, " +
      "and so are MCP tools. The shell is NOT refused, and that is a trust placed in " +
      "you: do not use it to work around the refusal. Do not write files with " +
      "redirection, do not `sed -i`, do not `git checkout` over someone's work. If a " +
      "command would change the repository, do not run it.\n\n" +
      "If the user asks for a change, do NOT attempt it and then report the refusal, " +
      "and do NOT silently draft a plan instead of doing what they asked. Call " +
      "`exit_plan`: it tells them they are in Plan mode and offers to switch. Say what " +
      "you would do first, so they are choosing with the plan in front of them.\n\n" +
      "End with numbered steps someone else could execute.",
    /*
     * `bash: "allow"` atas permintaan eksplisit user, dan ongkosnya perlu
     * dicatat di sini alih-alih ditemukan belakangan.
     *
     * Versi sebelumnya memakai daftar putih perintah baca. Daftar putih itu
     * benar secara keamanan dan salah secara kegunaan: `npm run typecheck`,
     * `find`, `jq`, dan setiap alat yang tidak terpikir saat menulisnya ikut
     * tertolak, dan mode Plan jadi tidak bisa menganalisa dengan alat yang
     * benar-benar dipakai orang. Daftar putih untuk perintah shell harus
     * memperkirakan setiap alat yang berguna — itu daftar yang tidak akan
     * pernah selesai.
     *
     * Konsekuensinya jujur: shell bisa mengubah berkas. Jadi mode ini TIDAK
     * lagi menjamin bahwa tidak ada yang berubah — yang dijamin hanya bahwa
     * TOOL berkas menolak. Sisanya bersandar pada prompt di atas, dan
     * deskripsinya diubah supaya tidak menjanjikan lebih dari itu.
     *
     * `edit` `write` `delete` `mcp` tetap ditolak: itu jalur yang wajar bagi
     * model untuk mengubah sesuatu, dan menutupnya membuat "jangan mengubah"
     * jadi jalan yang paling mudah ditempuh, bukan sekadar diminta.
     */
    permission: {
      edit: "deny",
      write: "deny",
      bash: "allow",
      delete: "deny",
      mcp: "deny",
    },
  },
  build: {
    description: "Build Manual — do the work, confirm every change",
    /*
     * Dulu berbunyi "Carry out the user's request DIRECTLY", dan satu kata itu
     * meniadakan seluruh blok roster yang muncul beberapa baris di bawahnya:
     * model membaca perintah tegas untuk mengerjakan sendiri, lalu saran
     * bersyarat untuk mendelegasikan. Yang tegas menang.
     */
    prompt:
      "Carry out the user's request.\n\n" +
      "Read files before changing them. Keep changes as small and targeted as possible. " +
      "Each change is confirmed by the user one at a time — that is deliberate, so do " +
      "not batch many changes into one large step.\n\n" +
      "Work that matches a sub-agent in your roster may be handed to it with `task`; " +
      "the confirmations still reach you, one per change.",
    permission: { edit: "ask", write: "ask", bash: "ask", network: "ask", delete: "ask", mcp: "ask" },
  },
  "build-auto": {
    description: "Build Auto — work autonomously, no confirmations",
    prompt:
      "Carry the user's request through to completion without waiting for approval.\n\n" +
      "Hand whole pieces of work to the sub-agents in your roster when one of them fits — " +
      "nobody is waiting on confirmations here, so parallel work costs you nothing.\n\n" +
      "Since nobody is checking each step, the responsibility is yours: read before " +
      "changing, run the tests after changing, and report failures exactly as they are. " +
      "Never claim success without verifying it.\n\n" +
      "Never stop to confirm mechanics. Listing a directory, reading a file, running a " +
      "command, installing a dependency, editing — that is what this mode exists for, and " +
      "asking about any of it wastes the only thing the user was trying to save.\n\n" +
      "Do stop, with `question`, when the request contradicts what the project actually " +
      "is: a SQL query against a store that is MongoDB, a React component in a Vue app, a " +
      "library the manifest does not list. That is not permission — it is which of two " +
      "realities to build for, and the repository cannot settle it because the repository " +
      "is one of the two sides. Guessing there costs the whole turn. Check the code first: " +
      "if reading it resolves the conflict, it was never a question worth asking.",
    /*
     * SEMUA sumbu, bukan enam dari delapan.
     *
     * `delete` dan `network` tidak menambah risiko baru: mode ini sudah punya
     * `bash: allow`, yang bisa menghapus dan mengunduh apa pun.
     *
     * `external_directory` dan `doom_loop` dulu tidak disebut, jadi keduanya
     * jatuh ke global — `deny` dan `ask` — dan mode yang menjanjikan "tanpa
     * konfirmasi" tetap bisa berhenti di tengah jalan. Janji yang hanya berlaku
     * enam dari delapan kali adalah janji yang tidak bisa diandalkan.
     *
     * `doom_loop: "allow"` TIDAK berarti loop dibiarkan tanpa kabar: `agent.ts`
     * menerbitkan satu notice per sesi saat mendeteksinya. Yang hilang adalah
     * dialognya, bukan pemberitahuannya.
     */
    permission: {
      edit: "allow",
      write: "allow",
      bash: "allow",
      network: "allow",
      delete: "allow",
      mcp: "allow",
      external_directory: "allow",
      doom_loop: "allow",
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
/**
 * Contoh siap-salin, BUKAN lagi bawaan.
 *
 * Sejak `externalAgent` jadi tempat user mendaftarkan super agent apa pun,
 * menyuntik dua nama secara otomatis berarti dua di antaranya istimewa tanpa
 * alasan — dan `specialist` yang wajib tidak bisa ditebak Titah untuk mereka.
 *
 * Tetap disimpan karena argumen CLI di sini DIVERIFIKASI langsung terhadap
 * biner, bukan disalin dari dokumentasi. Dipakai `titah doctor` untuk
 * menawarkan blok siap-salin, dan didokumentasikan di docs/super-agents.md.
 */
export const EXAMPLE_EXTERNAL_AGENTS: Record<string, z.input<typeof ExternalAgent>> = {
  claude: {
    command: "claude",
    specialist: "deep architectural reasoning, cross-module refactors, hard debugging",
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
    specialist: "broad codebase exploration, plugin and tooling work",
    args: ["run", "{prompt}", "--format", "json"],
    resumeArgs: ["run", "{prompt}", "--format", "json", "--session", "{session}"],
    sessionMode: "discover",
    format: "json",
  },
}
