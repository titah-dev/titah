import { execFile } from "node:child_process"
import { z } from "zod"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * GitHub lewat `gh`, CLI resminya.
 *
 * # Kenapa membungkus `gh` dan bukan memanggil API GitHub
 *
 * Kredensial. Memanggil API sendiri berarti Titah harus meminta, menyimpan, dan
 * memperpanjang token GitHub — satu rahasia lagi di disk, satu alur OAuth lagi,
 * satu tempat lagi yang bisa bocor. `gh` sudah punya semuanya, sudah dipercaya
 * user, dan `gh auth status` adalah jawaban yang bisa mereka periksa sendiri.
 *
 * Yang kedua: cakupan. GitHub punya ratusan endpoint. Membungkus `gh` berarti
 * setiap perintah yang bisa diketik user juga bisa dipakai model, tanpa daftar
 * yang harus dikejar tiap kali GitHub menambah sesuatu.
 *
 * # Kenapa bukan sekadar menyuruh model memakai `bash`
 *
 * Karena `bash` tidak tahu apa-apa tentang isi perintahnya. Tool ini tahu, dan
 * perbedaannya ada di izin: `gh pr list` hanya membaca, `gh pr merge` mengubah
 * repo yang dilihat orang lain, dan `bash` memberi keduanya dialog yang sama.
 * Di sini keduanya dipisah — lihat `READ_ONLY`.
 */

const DEFAULT_TIMEOUT = 120_000
const MAX_OUTPUT = 64 * 1024

/**
 * Sub-perintah yang hanya MEMBACA.
 *
 * Dipilih per pasangan `<objek> <aksi>`, bukan per kata pertama. `gh pr` saja
 * tidak berarti apa-apa: `gh pr view` membaca, `gh pr merge` menggabungkan.
 * Daftar ini sengaja pendek dan disebut satu per satu — apa pun yang tidak ada
 * di sini diperlakukan sebagai perubahan, karena menebak salah ke arah itu
 * hanya memunculkan dialog, sementara menebak salah ke arah sebaliknya
 * menjalankan sesuatu yang tidak diminta siapa pun.
 */
const READ_ONLY = new Set([
  "auth status",
  "issue list",
  "issue status",
  "issue view",
  "label list",
  "pr checks",
  "pr diff",
  "pr list",
  "pr status",
  "pr view",
  "release list",
  "release view",
  "repo list",
  "repo view",
  "run list",
  "run view",
  "search code",
  "search issues",
  "search prs",
  "search repos",
  "workflow list",
  "workflow view",
])

/** Perintah yang tidak boleh dijalankan lewat tool ini, apa pun izinnya. */
const REFUSED: Record<string, string> = {
  "auth token": "prints the GitHub token in plain text",
  "auth login": "needs an interactive browser flow that the agent cannot complete",
  "auth logout": "would sign the user out of gh entirely, well beyond this repo",
  "auth refresh": "needs an interactive browser flow that the agent cannot complete",
  "repo delete": "deletes a repository, and no undo exists for it",
}

const inputSchema = z.object({
  args: z
    .array(z.string())
    .min(1)
    .describe(
      'Arguments to gh, WITHOUT the leading "gh". Example: ["pr", "list", "--limit", "10"]. ' +
        "Each argument is a separate array element — they are passed straight to gh, " +
        "never through a shell, so quoting and globbing do not apply.",
    ),
})

/**
 * Perintah tingkat atas `gh`, sebagai kosakata tertutup.
 *
 * Dibutuhkan karena opsi global boleh mendahului perintahnya: pada
 * `gh --repo a/b issue view 7`, membuang token berawalan `-` masih menyisakan
 * `a/b` — NILAI dari `--repo` — dan sub-perintahnya terbaca "a/b issue".
 * Menebak opsi mana yang membawa nilai berarti menyalin tabel opsi gh dan
 * menjaganya tetap sinkron; mengenali nama perintahnya jauh lebih sedikit yang
 * harus diikuti, dan salahnya selalu ke arah yang aman.
 */
const COMMANDS = new Set([
  "alias", "api", "attestation", "auth", "browse", "cache", "codespace", "config",
  "extension", "gist", "gpg-key", "issue", "label", "org", "pr", "project",
  "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status",
  "variable", "workflow",
])

/**
 * Pasangan `<perintah> <aksi>` yang menentukan apa panggilan ini sebenarnya,
 * atau string kosong kalau tidak ada perintah gh yang dikenali di dalamnya.
 *
 * String kosong tidak pernah ada di `READ_ONLY`, jadi yang tidak terbaca selalu
 * berakhir sebagai "mengubah" — arah yang salahnya hanya memunculkan dialog.
 */
export function subcommandOf(args: string[]): string {
  const start = args.findIndex((arg) => !arg.startsWith("-") && COMMANDS.has(arg))
  if (start === -1) return ""

  const rest = args.slice(start + 1).find((arg) => !arg.startsWith("-"))
  return rest === undefined ? (args[start] as string) : `${args[start] as string} ${rest}`
}

export function isReadOnly(args: string[]): boolean {
  // `gh browse` membuka browser, yang tidak bisa dilakukan agent; dengan
  // `--no-browser` ia hanya mencetak URL-nya, dan itu murni membaca.
  if (args[0] === "browse" && args.includes("--no-browser")) return true
  return READ_ONLY.has(subcommandOf(args))
}

export function refusalFor(args: string[]): string | undefined {
  return REFUSED[subcommandOf(args)]
}

export const githubTool: TitahTool<typeof inputSchema> = {
  name: "github",
  description:
    "Run the GitHub CLI (gh) against the current repository: pull requests, issues, " +
    "releases, workflow runs, and code search. Pass gh's arguments as an array, without " +
    'the leading "gh" — for example ["pr", "view", "42"]. Read-only commands such as ' +
    "pr/issue list and view need only network permission; anything that changes " +
    "something on GitHub asks first. Requires gh to be installed and authenticated.",
  inputSchema,
  // Ia tidak menyentuh berkas di disk, jadi snapshot tidak menolong apa pun —
  // dan `/undo` tidak akan pernah bisa membatalkan PR yang sudah di-merge.
  mutates: false,
  permission(input) {
    const sub = subcommandOf(input.args)
    const readOnly = isReadOnly(input.args)
    const printed = `gh ${input.args.join(" ")}`

    return {
      /*
       * Dua sumbu, bukan satu.
       *
       * Membaca dari GitHub adalah lalu lintas jaringan dan tidak lebih —
       * sumbu `network`. Yang mengubah sesuatu di GitHub tidak punya sumbu
       * sendiri, dan yang paling jujur di antara yang ada adalah `bash`: ia
       * menjalankan program yang bertindak atas nama user di luar mesin ini.
       * Memaksanya ke `network` akan membuat "boleh mengambil halaman web"
       * diam-diam berarti "boleh menutup issue orang".
       */
      kind: readOnly ? "network" : "bash",
      title: printed.slice(0, 72),
      detail: readOnly
        ? `Read from GitHub with the gh CLI:\n\n  ${printed}\n\nThis only reads.`
        : `Run the gh CLI, which acts on GitHub as you:\n\n  ${printed}\n\n` +
          `"${sub}" is not on the read-only list, so it is treated as a change. ` +
          "Anything it does happens on GitHub, where undo cannot reach.",
      pattern: `github(${sub})`,
      subject: sub,
    }
  },
  async execute(input, ctx) {
    const refusal = refusalFor(input.args)
    if (refusal !== undefined) {
      throw new ToolError(
        `Refused: "gh ${subcommandOf(input.args)}" ${refusal}. ` +
          "Run it yourself in a terminal if that is really what you want.",
      )
    }

    return new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        input.args,
        {
          cwd: ctx.cwd,
          timeout: DEFAULT_TIMEOUT,
          maxBuffer: MAX_OUTPUT,
          env: {
            ...process.env,
            // gh membuka pager kalau keluarannya panjang, dan pager yang
            // menunggu tombol di proses tanpa terminal menggantung sampai batas
            // waktu — kegagalan yang terbaca seperti GitHub yang lambat.
            GH_PAGER: "cat",
            PAGER: "cat",
            GH_PROMPT_DISABLED: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          const out = `${stdout ?? ""}${stderr ?? ""}`.trim()

          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(
              new ToolError(
                "gh is not installed. Install the GitHub CLI (https://cli.github.com) " +
                  "and run `gh auth login`. Titah does not talk to the GitHub API directly — " +
                  "it uses your gh credentials so there is no second token to store.",
              ),
            )
          }

          if (error) {
            /*
             * Keluaran gh tetap disertakan, bukan dibuang demi pesan Node.
             *
             * "Command failed with exit code 1" tidak memberi tahu apa pun.
             * Yang berguna ada di stderr gh: repo tidak ditemukan, belum login,
             * PR sudah tertutup. Itu yang dibutuhkan model untuk memutuskan
             * langkah berikutnya alih-alih mencoba hal yang sama lagi.
             */
            const hint = /not logged in|gh auth login/i.test(out)
              ? "\n\nRun `gh auth login` first — Titah uses gh's credentials, not its own."
              : ""
            return reject(new ToolError(`gh exited with an error.\n${out || error.message}${hint}`))
          }

          resolve({
            title: `gh ${input.args.join(" ")}`.slice(0, 72),
            output: out === "" ? "(gh produced no output)" : out,
            metadata: { subcommand: subcommandOf(input.args), readOnly: isReadOnly(input.args) },
          })
        },
      )

      const onAbort = () => child.kill("SIGKILL")
      ctx.signal.addEventListener("abort", onAbort, { once: true })
      child.on("close", () => ctx.signal.removeEventListener("abort", onAbort))
    })
  },
}
