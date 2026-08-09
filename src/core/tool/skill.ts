import { z } from "zod"
import { discoverSkills, renderSkill, skillById } from "../skill.ts"
import { listModelMessages } from "../storage/session.ts"
import type { TitahTool } from "./types.ts"

const LOADED = /<skill name="([^"]+)"/g

/**
 * Menarik teks yang bisa dibaca manusia dari satu bagian `content` pesan.
 *
 * Isi pesan model BUKAN selalu string. Hasil tool call sungguhan datang lewat
 * AI SDK sebagai `{ role: "tool", content: [{ type: "tool-result", output:
 * { type: "text", value: "..." } }] }` — array, bukan string. `JSON.stringify`
 * atas array itu meng-escape setiap `"` di dalam `value` jadi `\"`, sehingga
 * regex yang mencari `name="` tidak akan pernah cocok dengan `name=\"`. Jalan
 * satu-satunya yang benar adalah membongkar bentuknya secara struktural, tidak
 * meregex JSON.
 */
function extractText(part: unknown): string {
  if (typeof part !== "object" || part === null) return ""
  const record = part as Record<string, unknown>

  if (record["type"] === "tool-result") {
    const output = record["output"]
    if (typeof output === "object" && output !== null) {
      const value = (output as Record<string, unknown>)["value"]
      if (typeof value === "string") return value
    }
    return ""
  }

  if (record["type"] === "text" && typeof record["text"] === "string") return record["text"] as string
  return ""
}

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
    const { content } = message
    // Pesan command (`/namespace:skill`) datang sebagai string polos; hasil
    // tool call datang sebagai array bagian yang harus dibongkar satu-satu.
    const text =
      typeof content === "string" ? content : Array.isArray(content) ? content.map(extractText).join("\n") : ""
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

    // Tidak ada batas ukuran di sini dengan sengaja: `storeOutput` di
    // agent.ts sudah memotong SETIAP output tool pada INLINE_LIMIT dengan
    // pemberitahuannya sendiri sebelum model melihat apa pun. Batas kedua di
    // sini dengan angka dan kata-kata berbeda hanya akan berbohong soal apa
    // yang sebenarnya dipotong.
    return {
      title: `skill ${skill.id}`,
      output: renderSkill(skill),
      metadata: { file: skill.file },
    }
  },
}
