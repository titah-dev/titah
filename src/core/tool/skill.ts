import { z } from "zod"
import { discoverSkills, markedSkillId, renderSkill, skillById } from "../skill.ts"
import { listModelMessages } from "../storage/session.ts"
import type { TitahTool } from "./types.ts"

const LOADED = /<skill name="([^"]+)"/

/**
 * Id skill dari hasil pemanggilan tool INI, kalau bagian pesannya memang itu.
 *
 * `toolName === "skill"` adalah syarat pertama dan yang menentukan. Isi hasil
 * tool `skill` ditulis `renderSkill` di proses ini juga, jadi meregex isinya
 * aman: tulisan `<skill name="` di situ pasti berasal dari kami. Regex yang
 * sama dijalankan atas teks sembarang — hasil `read`, `grep`, atau ketikan
 * user — justru berbahaya, karena file dokumentasi yang memuat contoh tag itu
 * akan menandai skill yang disebutnya sebagai sudah dimuat.
 *
 * Kalau id sebuah skill sendiri memuat tanda kutip, regex ini meleset dan
 * skill dianggap belum dimuat: gagal ke arah MEMUAT ULANG, bukan ke arah
 * menyatakan instruksi berlaku padahal tidak pernah dikirim.
 */
function skillResultId(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const record = part as Record<string, unknown>
  if (record["type"] !== "tool-result" || record["toolName"] !== "skill") return undefined

  const output = record["output"]
  if (typeof output !== "object" || output === null) return undefined
  const value = (output as Record<string, unknown>)["value"]
  if (typeof value !== "string") return undefined
  return LOADED.exec(value)?.[1]
}

/**
 * Skill yang sudah terlihat oleh model di sesi ini.
 *
 * Hanya DUA hal yang pernah memuat isi skill, dan keduanya dikenali dari
 * bentuknya, bukan dari teksnya: hasil tool bernama `skill`, dan pesan user
 * bertanda yang ditulis jalur command `/namespace:skill`. Konten string polos
 * dilewati seluruhnya — teks bisa datang dari mana saja dan karena itu tidak
 * pernah membuktikan apa pun.
 *
 * Dihitung dari riwayat yang DILIHAT MODEL, bukan dari baris mentah. Setelah
 * `/compact`, isi skill sudah lenyap dari pandangan model walau barisnya masih
 * ada di disk; kalau dihitung dari baris mentah, model dianggap masih memilikinya
 * dan kehilangan skill itu selamanya tanpa cara memuatnya ulang.
 */
export function loadedSkillIds(sessionID: string): Set<string> {
  const ids = new Set<string>()
  for (const { content } of listModelMessages(sessionID)) {
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const id = markedSkillId(part) ?? skillResultId(part)
      if (id !== undefined) ids.add(id)
    }
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
