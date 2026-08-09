import { z } from "zod"
import { discoverSkills, renderSkill, skillById } from "../skill.ts"
import { listModelMessages } from "../storage/session.ts"
import type { TitahTool } from "./types.ts"

/** Isi skill terbesar hari ini 9 KB; batas ini longgar dengan sengaja. */
const MAX_BODY = 64 * 1024

const LOADED = /<skill name="([^"]+)"/g

/**
 * Skill yang sudah terlihat oleh model di sesi ini.
 *
 * Dihitung dari riwayat yang DILIHAT MODEL, bukan dari baris mentah. Setelah
 * `/compact`, isi skill sudah lenyap dari pandangan model walau barisnya masih
 * ada di disk; kalau dihitung dari baris mentah, model dianggap masih memilikinya
 * dan kehilangan skill itu selamanya tanpa cara memuatnya ulang.
 */
export function loadedSkillIds(sessionID: string): Set<string> {
  const ids = new Set<string>()
  for (const message of listModelMessages(sessionID)) {
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    for (const match of text.matchAll(LOADED)) ids.add(match[1] as string)
  }
  return ids
}

const inputSchema = z.object({
  name: z.string().describe('Fully qualified skill id, e.g. "superpowers:brainstorming"'),
})

export const skillTool: TitahTool<typeof inputSchema> = {
  name: "skill",
  description:
    "Load a skill's full instructions into the conversation. Use it when the catalogue entry " +
    "suggests a skill applies to the current task. Ids are fully qualified, e.g. " +
    '"superpowers:brainstorming".',
  inputSchema,

  // Tanpa `permission`: memuat skill membaca file dari path yang user sendiri
  // daftarkan dan menaruhnya di konteks — setara system prompt. Dialog di sini
  // hanya melatih orang menekan "y" tanpa membaca.

  async execute(input, ctx) {
    const skills = discoverSkills(ctx.config, ctx.cwd)
    const skill = skillById(skills, input.name)

    if (!skill) {
      const namespace = input.name.split(":")[0]
      const nearby = skills.filter((entry) => entry.namespace === namespace)
      const list = (nearby.length > 0 ? nearby : skills).slice(0, 20).map((entry) => entry.id)
      return {
        title: `skill ${input.name} (not found)`,
        output: `No skill with id "${input.name}". Available:\n${list.join("\n")}`,
      }
    }

    if (loadedSkillIds(ctx.sessionID).has(skill.id)) {
      return {
        title: `skill ${skill.id} (already loaded)`,
        output: `The "${skill.id}" skill was already loaded earlier in this session. Its instructions still apply — scroll back rather than loading it again.`,
      }
    }

    const truncated = skill.body.length > MAX_BODY
    const body = truncated
      ? `${skill.body.slice(0, MAX_BODY)}\n\n[truncated: skill body exceeds ${MAX_BODY} bytes]`
      : skill.body

    return {
      title: `skill ${skill.id}`,
      output: renderSkill({ ...skill, body }),
      metadata: { file: skill.file, truncated },
    }
  },
}
