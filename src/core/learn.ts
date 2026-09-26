import type { Part } from "./message.ts"

/**
 * Titah menulis skill sendiri sesudah giliran yang substansial.
 *
 * Alurnya: saringan murni (`shouldReflect`) → digest ringkas (`buildDigest`) →
 * satu panggilan model kecil → validasi → tulis atomik. Semua keputusan yang
 * bisa diuji tanpa model ada di fungsi murni di berkas ini; `startReflection`
 * hanya merangkainya.
 *
 * # Kenapa digest, bukan transkrip
 *
 * Transkrip giliran yang lolos saringan (≥ 8 tool call) bisa ratusan ribu
 * token — persis biaya yang fitur ini tidak boleh tambahkan. Yang dibutuhkan
 * untuk menilai "apakah ini prosedur" adalah urutan langkahnya, bukan isi
 * setiap keluaran tool.
 */

export interface GateInput {
  enabled: boolean
  isChild: boolean
  aborted: boolean
  failed: boolean
  stoppedAtLimit: boolean
  willContinue: boolean
  toolCalls: number
  minTools: number
}

/**
 * Semua syarat harus terpenuhi. Prosedur yang gagal, terpotong batas, atau
 * belum selesai bukan prosedur yang layak diulang; sub-agent melapor ke induk
 * yang bisa belajar sendiri; dan giliran pendek tidak boleh membayar apa pun.
 */
export function shouldReflect(input: GateInput): boolean {
  return (
    input.enabled &&
    !input.isChild &&
    !input.aborted &&
    !input.failed &&
    !input.stoppedAtLimit &&
    !input.willContinue &&
    input.toolCalls >= input.minTools
  )
}

export function countToolCalls(parts: readonly Part[]): number {
  return parts.filter((part) => part.type === "tool").length
}

export interface LearnedSummary {
  name: string
  description: string
}

export const DIGEST_CAP = 24_000
const REQUEST_CAP = 2_000
const ANSWER_CAP = 2_000
const TOOL_INPUT_CAP = 200

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`
}

function toolLine(index: number, part: Extract<Part, { type: "tool" }>): string {
  const input = clip(JSON.stringify(part.state.input ?? {}) ?? "{}", TOOL_INPUT_CAP)
  const outcome = part.state.status === "completed" ? "ok" : part.state.status
  return `${index + 1}. ${part.tool} ${input} → ${outcome}`
}

/**
 * Ringkasan giliran untuk model penilai.
 *
 * Kalau melebihi batas, tool di TENGAH yang dibuang dan diganti satu baris:
 * awal dan akhir sebuah prosedur memuat informasi terbanyak — persiapan dan
 * verifikasi — sementara bagian tengahnya paling sering berupa pengulangan.
 */
export function buildDigest(input: {
  request: string
  parts: readonly Part[]
  learned: readonly LearnedSummary[]
}): string {
  const tools = input.parts.filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
  const answer = input.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  const learned = input.learned.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")

  const head = `## User request\n${clip(input.request.trim(), REQUEST_CAP)}\n\n## Tool calls\n`
  const tail =
    `\n\n## Final answer\n${clip(answer, ANSWER_CAP) || "(none)"}` +
    `\n\n## Existing learned skills\n${learned || "(none)"}\n`

  const lines = tools.map((part, index) => toolLine(index, part))
  const room = DIGEST_CAP - head.length - tail.length
  const joined = lines.join("\n")
  if (joined.length <= room) return head + joined + tail

  // Ambil dari kedua ujung bergantian sampai ruangnya habis.
  const kept = { start: [] as string[], end: [] as string[] }
  let used = 0
  const marker = (omitted: number) => `… ${omitted} tool calls omitted …`
  const reserve = marker(lines.length).length + 2
  for (let i = 0, j = lines.length - 1; i <= j; ) {
    const next = kept.start.length <= kept.end.length ? lines[i] : lines[j]
    if (next === undefined || used + next.length + 1 > room - reserve) break
    if (kept.start.length <= kept.end.length) {
      kept.start.push(next)
      i += 1
    } else {
      kept.end.unshift(next)
      j -= 1
    }
    used += next.length + 1
  }
  const omitted = lines.length - kept.start.length - kept.end.length
  return head + [...kept.start, marker(omitted), ...kept.end].join("\n") + tail
}
