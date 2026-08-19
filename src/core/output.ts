import type { Event } from "./event.ts"
import type { Message } from "./message.ts"

/**
 * Keluaran yang bisa dibaca mesin, bukan hanya mata.
 *
 * # Kenapa ini ada
 *
 * `titah run` hanya pernah mengalirkan teks ke stdout. Cukup untuk dibaca
 * orang, dan sama sekali tidak cukup untuk apa pun yang lain: pipeline, CI,
 * skrip, atau alat yang ingin memakai Titah sebagai bagiannya. Semua yang
 * dibutuhkan pemanggil — apakah gilirannya berhasil, tool apa yang jalan,
 * berapa token terpakai, apakah ia berhenti karena selesai atau karena
 * kehabisan anggaran — hanya ada sebagai teks berwarna di antara jawaban.
 *
 * # Tiga bentuk, tiga pemakai yang berbeda
 *
 *   text         orang membaca di terminal. Bawaan, dan tidak berubah.
 *   json         satu objek di akhir. Untuk skrip yang menunggu hasil.
 *   stream-json  satu event per baris, saat terjadi. Untuk yang mengikuti.
 *
 * `stream-json` sengaja BUKAN format baru: ia persis `Event` milik Titah, satu
 * per baris. Format kedua berarti dua bentuk yang harus dijaga tetap sama, dan
 * yang kedua selalu tertinggal begitu event baru ditambahkan.
 *
 * # Aturan yang tidak bisa ditawar: stdout milik DATA
 *
 * Dalam mode json, tidak satu pun karakter untuk manusia boleh menyentuh
 * stdout. Bukan kerapian — satu baris "session: ses_..." di depan objeknya
 * membuat `JSON.parse` gagal, dan pemanggilnya tidak punya cara menebak bahwa
 * yang salah adalah barisnya, bukan datanya.
 */

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value)
}

/** Satu tool yang dijalankan giliran ini, seperti yang dilihat pemanggil. */
export interface ToolRun {
  tool: string
  title: string
  status: "completed" | "error" | "denied" | "running" | "pending"
  /**
   * `failed` atau `stopped` untuk sub-agent yang selesai TANPA melempar.
   *
   * Dipisah dari `status` karena keduanya menjawab pertanyaan berbeda: status
   * menjawab "apakah toolnya berjalan", outcome menjawab "apakah hasilnya
   * berguna". `task` yang sub-agentnya ditolak seluruh toolnya tetap
   * `completed`, dan skrip yang membaca status saja akan menyangkanya berhasil.
   */
  outcome?: string
  reason?: string
}

export interface TurnResult {
  session: string
  /** `true` kalau giliran selesai tanpa error. Satu field untuk satu keputusan. */
  ok: boolean
  agent?: string
  model?: string
  /** Jawaban akhir model, teks saja — tanpa penalaran dan tanpa keluaran tool. */
  text: string
  tools: ToolRun[]
  usage?: { input?: number; output?: number; context?: number }
  /**
   * Kabar sekali-per-sesi yang terkumpul selama giliran.
   *
   * Di sinilah "berhenti karena kehabisan anggaran" sampai ke pemanggil. Tanpa
   * ini, satu-satunya perbedaan antara giliran yang selesai dan giliran yang
   * dipotong adalah panjang teksnya — dan tidak ada skrip yang bisa menilai itu.
   */
  notices: string[]
  error?: string
  /**
   * Hasil terurai, kalau `--json-schema` dipakai dan jawabannya cocok.
   *
   * Ada di sini alih-alih menggantikan `text` supaya keduanya bisa dibaca:
   * skrip mengambil `output`, manusia yang men-debug membaca `text` yang
   * membuatnya.
   */
  output?: unknown
}

/** Teks jawaban saja — bukan penalaran, bukan keluaran tool. */
function answerOf(message: Message): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

function toolsOf(message: Message): ToolRun[] {
  const runs: ToolRun[] = []
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    const state = part.state as {
      status: ToolRun["status"]
      title?: string
      outcome?: string
      reason?: string
      error?: string
    }
    runs.push({
      tool: part.tool,
      title: state.title ?? part.tool,
      status: state.status,
      ...(state.outcome ? { outcome: state.outcome } : {}),
      ...(state.reason ?? state.error ? { reason: state.reason ?? state.error } : {}),
    })
  }
  return runs
}

export function turnResult(
  sessionID: string,
  message: Message | undefined,
  notices: string[],
): TurnResult {
  if (!message) {
    return { session: sessionID, ok: false, text: "", tools: [], notices, error: "No result." }
  }

  return {
    session: sessionID,
    ok: message.error === undefined,
    ...(message.agent ? { agent: message.agent } : {}),
    ...(message.model ? { model: message.model } : {}),
    text: answerOf(message),
    tools: toolsOf(message),
    ...(message.usage ? { usage: message.usage } : {}),
    notices,
    ...(message.error ? { error: message.error } : {}),
  }
}

/** Satu event sebagai satu baris NDJSON. */
export function streamLine(event: Event): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Mengurai jawaban model menjadi objek, untuk `--json-schema`.
 *
 * # Kenapa diurai di sini, bukan diminta ke provider
 *
 * AI SDK bisa memaksa keluaran terstruktur lewat provider, dan itu jalan yang
 * lebih rapi — pada provider yang mendukungnya. Endpoint openai-compatible
 * kebanyakan tidak, dan Titah dipakai lewat router semacam itu. Memilih jalur
 * yang hanya bekerja di sebagian provider berarti fiturnya ada di dokumentasi
 * dan tidak ada di mesin user.
 *
 * Jadi: bentuknya diminta lewat prompt, jawabannya diurai di sini, dan
 * ketidakcocokan dilaporkan sebagai kegagalan yang jelas — bukan diam-diam
 * diteruskan sebagai teks biasa.
 *
 * # Pagar kode: model suka membungkus JSON
 *
 * Bahkan dengan instruksi tegas, model kerap membalas ```json … ```. Menolak
 * itu sebagai "bukan JSON" akan benar secara harfiah dan tidak berguna bagi
 * siapa pun.
 */
export function parseStructured(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  const body = (fenced?.[1] ?? trimmed).trim()

  if (body === "") return { error: "The model returned an empty answer." }

  try {
    return { value: JSON.parse(body) }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { error: `The answer is not valid JSON: ${why}` }
  }
}

/**
 * Instruksi bentuk yang ditempelkan ke prompt user.
 *
 * Ditempel ke PROMPT, bukan ke system prompt, dan itu disengaja: system prompt
 * ikut di-cache sebagai awalan stabil, sementara skema berubah tiap pemanggilan.
 * Menaruhnya di sana akan mematahkan cache untuk setiap permintaan yang
 * skemanya berbeda.
 */
export function schemaInstruction(schema: unknown): string {
  return [
    "",
    "",
    "--- required answer shape ---",
    "Answer with JSON only — no prose before or after, no code fence.",
    "It must validate against this JSON Schema:",
    "",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

/**
 * Pemeriksa skema: SUBSET JSON Schema, dan itu dinyatakan alih-alih disamarkan.
 *
 * # Kenapa bukan validator penuh
 *
 * JSON Schema lengkap butuh pustaka (ajv dan sejenisnya), dan menambah
 * dependensi adalah keputusan yang berumur jauh lebih panjang daripada fitur
 * yang memintanya. Yang dipakai orang untuk memaksa bentuk jawaban agent
 * hampir selalu potongan yang sama: objek dengan properti bertipe, beberapa
 * wajib, kadang array, kadang enum.
 *
 * Jadi yang didukung dinyatakan di sini, dan yang TIDAK didukung dilewati tanpa
 * berpura-pura lulus — kata kunci yang tidak dikenal diabaikan, bukan dianggap
 * gagal. Validator yang diam-diam meluluskan lebih buruk daripada validator
 * yang menyebut batasnya.
 *
 * Didukung: `type` (object, array, string, number, integer, boolean, null),
 * `required`, `properties` (rekursif), `items` (rekursif), `enum`.
 */
export function checkSchema(value: unknown, schema: unknown, path = "$"): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined
  const rules = schema as Record<string, unknown>

  if (Array.isArray(rules["enum"])) {
    const allowed = rules["enum"]
    if (!allowed.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      return `${path}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`
    }
  }

  const type = rules["type"]
  if (typeof type === "string") {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
    const ok =
      type === actual ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && actual === "number")
    if (!ok) return `${path}: expected ${type}, got ${actual}`
  }

  if (Array.isArray(rules["required"]) && typeof value === "object" && value !== null) {
    for (const key of rules["required"]) {
      if (typeof key === "string" && !(key in (value as Record<string, unknown>))) {
        return `${path}: missing required property "${key}"`
      }
    }
  }

  const properties = rules["properties"]
  if (typeof properties === "object" && properties !== null && typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      const held = (value as Record<string, unknown>)[key]
      if (held === undefined) continue
      const failure = checkSchema(held, sub, `${path}.${key}`)
      if (failure) return failure
    }
  }

  const items = rules["items"]
  if (items !== undefined && Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const failure = checkSchema(entry, items, `${path}[${index}]`)
      if (failure) return failure
    }
  }

  return undefined
}

/**
 * Kode keluar `titah run`, dan kenapa ada tiga.
 *
 *   0  giliran selesai, dan bentuknya cocok kalau diminta
 *   1  gilirannya sendiri gagal — error model, dibatalkan, tool jatuh
 *   2  gilirannya berhasil, tapi jawabannya BUKAN bentuk yang diminta
 *
 * Dua dan satu dipisah karena penanganannya berbeda: kode 1 biasanya berarti
 * coba lagi, kode 2 berarti prompt atau skemanya yang perlu diperbaiki, dan
 * mengulanginya apa adanya akan gagal dengan cara yang sama.
 *
 * Dipisah dari `cmdRun` supaya keputusan ini bisa diuji tanpa memanggil model.
 * Jalur kegagalannya justru yang paling sulit dipicu di percobaan sungguhan —
 * model yang patuh tidak pernah menyentuhnya — dan jalur yang tidak bisa
 * dipicu adalah jalur yang tidak pernah diperiksa.
 */
export function applySchema(
  result: TurnResult,
  schema: unknown | undefined,
): { result: TurnResult; exit: 0 | 1 | 2 } {
  if (!result.ok) return { result, exit: 1 }
  if (schema === undefined) return { result, exit: 0 }

  const parsed = parseStructured(result.text)
  const failure = parsed.error ?? checkSchema(parsed.value, schema)
  if (failure) return { result: { ...result, ok: false, error: failure }, exit: 2 }

  return { result: { ...result, output: parsed.value }, exit: 0 }
}
