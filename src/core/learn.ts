import fs from "node:fs"
import path from "node:path"
import type { Part } from "./message.ts"
import { parseStructured } from "./output.ts"
import { learnedSkillsDir } from "./paths.ts"
import { parseFrontmatter, scanSource } from "./skill.ts"

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
  const input = clip(JSON.stringify(part.state.input ?? {}), TOOL_INPUT_CAP)
  const outcome = part.state.status === "completed" ? (part.state.outcome ?? "ok") : part.state.status
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

/** Penanda frontmatter: satu-satunya izin untuk menimpa sebuah skill. */
export const LEARN_SOURCE = "titah-learn"

export type Decision =
  | { action: "none" }
  | { action: "create" | "update"; name: string; description: string; body: string }

type Write = Exclude<Decision, { action: "none" }>

/** Apa pun yang tidak berbentuk keputusan yang sah dibaca sebagai "none" — diam adalah jawaban aman. */
export function parseDecision(text: string): Decision {
  const { value } = parseStructured(text)
  if (typeof value !== "object" || value === null) return { action: "none" }
  const v = value as Record<string, unknown>
  if (v.action !== "create" && v.action !== "update") return { action: "none" }
  if (typeof v.name !== "string" || typeof v.description !== "string" || typeof v.body !== "string") {
    return { action: "none" }
  }
  return { action: v.action, name: v.name, description: v.description, body: v.body }
}

export interface LearnedSkill {
  name: string
  description: string
  file: string
  source?: string
}

export function listLearned(dir = learnedSkillsDir()): LearnedSkill[] {
  return scanSource({ root: dir, namespace: "learned" }).map((skill) => ({
    name: path.basename(path.dirname(skill.file)),
    description: skill.description,
    file: skill.file,
    ...(skill.source ? { source: skill.source } : {}),
  }))
}

const NAME = /^[a-z0-9][a-z0-9-]{1,48}$/
const MAX_BODY_BYTES = 8 * 1024

/**
 * Bentuk rahasia yang paling umum. Bukan pemindai lengkap — tujuannya menangkap
 * kecelakaan yang paling mungkin: model menyalin baris `export KEY=...` dari
 * keluaran tool ke dalam langkah-langkah skill.
 */
const SECRETS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"<>{}]{4,}/i,
]

/** Alasan penolakan, atau `undefined` kalau keputusannya boleh ditulis. */
export function validateLearned(decision: Write, existing: readonly LearnedSkill[], max: number): string | undefined {
  if (!NAME.test(decision.name)) return `invalid name "${decision.name}"`
  const description = decision.description.trim()
  if (description === "" || description.length > 160 || /[\r\n]/.test(description)) {
    return "description must be one line of 1–160 characters"
  }
  const trimmedBody = decision.body.trim()
  if (trimmedBody === "") return "body must not be empty"
  const bytes = Buffer.byteLength(trimmedBody, "utf8")
  if (bytes > MAX_BODY_BYTES) return `body is ${bytes} bytes (limit ${MAX_BODY_BYTES})`
  const text = `${decision.description}\n${decision.body}`
  if (SECRETS.some((pattern) => pattern.test(text))) return "looks like it contains a secret"

  const current = existing.find((skill) => skill.name === decision.name)
  if (decision.action === "create") {
    if (current) return `"${decision.name}" already exists; use update`
    if (existing.length >= max) return `at the cap of ${max} learned skills`
    return undefined
  }
  if (!current) return `"${decision.name}" does not exist`
  if (current.source !== LEARN_SOURCE) return `"${decision.name}" was not written by Titah`
  return undefined
}

/**
 * Menulis SKILL.md secara atomik. Pemanggil WAJIB sudah memvalidasi keputusannya.
 *
 * Tulis-lalu-rename: Titah yang membaca indeks skill di tengah penulisan tidak
 * pernah melihat berkas setengah jadi.
 */
export function writeLearned(decision: Write, sessionID: string, dir = learnedSkillsDir(), now = new Date()): string {
  const folder = path.join(dir, decision.name)
  const file = path.join(folder, "SKILL.md")

  let created = now.toISOString()
  if (decision.action === "create") {
    try {
      fs.statSync(file)
      throw new Error(`"${decision.name}" already exists; use update`)
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) throw error
      // File does not exist, which is what we want for create
    }
  } else if (decision.action === "update") {
    try {
      created = parseFrontmatter(fs.readFileSync(file, "utf8")).fields["created"] ?? created
    } catch {
      // Berkas hilang di antara validasi dan tulis: tulis sebagai baru.
    }
  }

  const content =
    "---\n" +
    `name: ${decision.name}\n` +
    `description: ${decision.description.trim()}\n` +
    `source: ${LEARN_SOURCE}\n` +
    `created: ${created}\n` +
    `updated: ${now.toISOString()}\n` +
    `session: ${sessionID}\n` +
    "---\n\n" +
    `${decision.body.trim()}\n`

  fs.mkdirSync(folder, { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, "utf8")
  fs.renameSync(temporary, file)
  return file
}
