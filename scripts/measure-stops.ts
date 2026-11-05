// Pengukuran berhenti-di-tengah-tugas: kelompokkan pesan user "lanjutkan/next/..."
// menurut keadaan pesan assistant sebelumnya. Read-only terhadap titah.db.
// Pakai: node scripts/measure-stops.ts [dbPath]
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { dataDir } from "../src/core/paths.ts"

const file = process.argv[2] ?? process.env.TITAH_DB ?? path.join(dataDir(), "titah.db")
const db = new DatabaseSync(file, { readOnly: true })

type Part = { type?: string; text?: string }
type Data = { parts?: Part[]; error?: unknown; model?: unknown }

const rows = db
  .prepare("SELECT session_id AS s, role, data FROM message ORDER BY session_id, seq")
  .all() as { s: string; role: string; data: string }[]

// Pesan user yang isinya hanya "teruskan" — itulah intervensi yang diukur.
const CONTINUE = /^(lanjut(kan)?|next|continue|teruskan|go on|gas|ok lanjut(kan)?|yes|ya)\.?$/i
const TOOL_AS_TEXT = /<tool_call>|<function=/

const lastText = (d: Data): string =>
  ([...(d.parts ?? [])].reverse().find((p) => p.type === "text")?.text ?? "").trim()
const modelName = (d: Data): string => (typeof d.model === "string" ? d.model : JSON.stringify(d.model))

let prev: { s: string; d: Data } | null = null
const afterState: Record<string, number> = {}
// Semua giliran assistant tanpa error, supaya "berapa kali" punya penyebut.
const perModel: Record<string, { turns: number; colon: number; xml: number }> = {}

for (const r of rows) {
  const d = JSON.parse(r.data) as Data
  if (r.role === "assistant") {
    prev = { s: r.s, d }
    if (!d.error) {
      const t = lastText(d)
      const m = (perModel[modelName(d)] ??= { turns: 0, colon: 0, xml: 0 })
      m.turns++
      if (/:\s*$/.test(t)) m.colon++
      if (TOOL_AS_TEXT.test(t)) m.xml++
    }
    continue
  }
  const t = (d.parts?.find((p) => p.type === "text")?.text ?? "").trim()
  if (!CONTINUE.test(t) || !prev || prev.s !== r.s || prev.d.error) continue
  const last = lastText(prev.d)
  const kind = TOOL_AS_TEXT.test(last)
    ? "tool call written as text"
    : /:\s*$/.test(last)
      ? "ends with ':' (announced, never called)"
      : last === ""
        ? "empty"
        : "other"
  const key = `${kind} @ ${modelName(prev.d)}`
  afterState[key] = (afterState[key] ?? 0) + 1
}

console.log(`db: ${file}`)
console.log("continue-messages by previous assistant state:", afterState)
console.log("per model (non-error turns):", perModel)
