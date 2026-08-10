import { z } from "zod"
import { dispatchableAgents, runSubagent } from "../subagent.ts"
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
    const available = dispatchableAgents(ctx.config)
    if (!available.includes(input.agent)) {
      return {
        title: `task ${input.agent} (unknown)`,
        output: `No dispatchable agent named "${input.agent}". Available: ${available.join(", ") || "(none)"}.`,
      }
    }

    const result = await runSubagent({
      parentSessionID: ctx.sessionID,
      agentID: input.agent,
      instruction: input.instruction,
      cwd: ctx.cwd,
      config: ctx.config,
      signal: ctx.signal,
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
