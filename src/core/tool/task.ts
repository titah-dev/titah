import { z } from "zod"
import { dispatchableAgents, runSubagent } from "../subagent.ts"
import type { EffectivePermission } from "../permission.ts"
import type { TitahTool } from "./types.ts"

const inputSchema = z.object({
  agent: z.string().describe("Name of a configured agent whose `mode` allows dispatch"),
  instruction: z.string().describe("What this sub-agent should do, stated on its own terms"),
})

export const taskTool: TitahTool<typeof inputSchema> = {
  name: "task",
  description:
    "Hand a piece of work to one of the configured sub-agents. Several calls in the same step " +
    "run concurrently; agents allowed to write files are serialised automatically. The " +
    "sub-agent cannot dispatch further sub-agents.",
  inputSchema,

  // Tanpa `permission`: tool ini tidak mengubah apa pun sendiri. Sub-agent yang
  // ia jalankan meminta izinnya masing-masing, dengan namanya sendiri.

  async execute(input, ctx) {
    /*
     * Dua kelompok, satu tool.
     *
     * Agent internal Titah dan super agent (CLI lain) dipanggil dengan cara
     * yang sama karena dari sudut pandang model memang tidak berbeda: keduanya
     * "serahkan pekerjaan ini ke sana". Tool terpisah untuk masing-masing akan
     * memaksa model memilih tool yang benar sebelum ia memilih agent yang
     * benar — satu keputusan lagi yang bisa salah, tanpa imbalan.
     */
    const internal = dispatchableAgents(ctx.config)
    // Sudah disaring `buildTools` sesuai siapa pemanggilnya. Kosong berarti
    // giliran ini memang tidak boleh memanggil super agent mana pun.
    const supers = ctx.supersAllowed ?? []

    if (!internal.includes(input.agent) && !supers.includes(input.agent)) {
      const known = [...internal, ...supers].join(", ") || "(none)"
      return {
        title: `task ${input.agent} (unknown)`,
        output: `No agent named "${input.agent}" can be dispatched. Available: ${known}.`,
      }
    }

    const result = await runSubagent({
      parentSessionID: ctx.sessionID,
      agentID: input.agent,
      instruction: input.instruction,
      cwd: ctx.cwd,
      config: ctx.config,
      signal: ctx.signal,
      /*
       * Batas atas, bukan sekadar informasi.
       *
       * `ToolContext.permission` bertipe `unknown` supaya `tool/types.ts` tidak
       * perlu mengimpor mesin izin; di sinilah ia disempitkan kembali. Tanpa
       * baris ini, sub-agent berjalan dengan izinnya sendiri dan agent
       * read-only bisa mendelegasikan pekerjaan tulis.
       */
      ...(ctx.permission ? { parentPermission: ctx.permission as EffectivePermission } : {}),
      // Model induk: diwarisi anak yang tidak punya sendiri, dan jadi cadangan
      // kalau model milik anak ternyata tidak bisa dipakai.
      ...(ctx.model ? { parentModel: ctx.model } : {}),
    })

    return {
      title: `task ${input.agent} (${result.status})`,
      output: result.answer,
      // Tool ini memang tidak pernah melempar — sub-agent yang gagal atau
      // dihentikan tetap hasil yang sah untuk dibaca koordinator. `outcome`
      // yang membawa kabar itu ke riwayat, yang kalau tidak akan menandai
      // setiap panggilan `task` dengan glyph sukses.
      ...(result.status === "done" ? {} : { outcome: result.status }),
      metadata: { childSessionID: result.childSessionID, status: result.status },
    }
  },
}
