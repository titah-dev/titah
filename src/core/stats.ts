import { database } from "./storage/db.ts"
import type { Config, ModelPrice } from "./schema.ts"

/**
 * Apa yang sudah dihabiskan, dibaca dari yang memang sudah tersimpan.
 *
 * # Kenapa ini ada
 *
 * Titah mencatat token setiap giliran sejak awal dan tidak pernah punya cara
 * membacanya kembali. Tiga puluh juta token tercatat di satu database tanpa satu
 * pun perintah yang bisa menjumlahkannya — angka yang ditulis rajin lalu tidak
 * pernah dilihat sama nilainya dengan angka yang tidak pernah ditulis.
 *
 * Nol kolom baru, nol pencatatan baru. Yang kurang selama ini pembacanya.
 *
 * # Harga: DINYATAKAN, tidak ditebak
 *
 * Model tanpa `price` di config tetap dihitung tokennya dan dilaporkan
 * TERPISAH. Menghitungnya sebagai nol akan membuat total biayanya berbohong ke
 * arah yang paling berbahaya — terlihat murah — dan tidak ada satu pun tanda di
 * layar yang membedakan "gratis" dari "belum diberi harga".
 */

export interface ModelUsage {
  model: string
  turns: number
  input: number
  output: number
  /** `undefined` kalau model ini belum punya `price` di config. */
  cost?: number
}

export interface DayUsage {
  /** `YYYY-MM-DD` lokal, bukan UTC — hari yang dimaksud user adalah harinya. */
  day: string
  turns: number
  input: number
  output: number
  cost?: number
}

export interface Stats {
  from?: number
  turns: number
  sessions: number
  input: number
  output: number
  /** Total biaya model yang PUNYA harga. Tidak termasuk yang belum diberi harga. */
  cost: number
  /** Model yang dipakai tapi belum punya harga — disebut, bukan didiamkan. */
  unpriced: string[]
  byModel: ModelUsage[]
  byDay: DayUsage[]
}

/** Biaya satu giliran, atau `undefined` kalau modelnya belum diberi harga. */
export function turnCost(
  price: ModelPrice | undefined,
  usage: { input?: number; output?: number },
): number | undefined {
  if (!price) return undefined
  const input = ((usage.input ?? 0) / 1_000_000) * price.input
  const output = ((usage.output ?? 0) / 1_000_000) * price.output
  return input + output
}

/** Harga model dari config, dicari lewat id `provider/model`. */
export function priceOf(config: Config, id: string | undefined): ModelPrice | undefined {
  if (!id) return undefined
  const slash = id.indexOf("/")
  if (slash === -1) return undefined
  const provider = config.provider[id.slice(0, slash)]
  return provider?.models[id.slice(slash + 1)]?.price
}

/** `YYYY-MM-DD` di zona waktu mesin ini. */
function localDay(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

export interface StatsQuery {
  /** Batas bawah waktu, dalam ms epoch. Tanpa ini: seluruh riwayat. */
  from?: number
  /** Hanya sesi di direktori ini. Tanpa ini: semua proyek. */
  directory?: string
}

export function collectStats(config: Config, query: StatsQuery = {}): Stats {
  /*
   * Dibaca dari tabel `message`, bukan `model_message`.
   *
   * Yang pertama memuat `usage` seperti yang DILAPORKAN provider untuk tiap
   * giliran; yang kedua memuat percakapan mentah dan tidak tahu apa-apa soal
   * token. Menghitung dari sana berarti menaksir ulang sesuatu yang sudah
   * diukur — dan taksirannya pasti berbeda dari tagihannya.
   */
  const rows = database()
    .prepare(
      `SELECT m.created AS created, m.data AS data, m.session_id AS session
       FROM message m
       JOIN session s ON s.id = m.session_id
       WHERE m.role = 'assistant'
         AND (? IS NULL OR m.created >= ?)
         AND (? IS NULL OR s.directory = ?)
       ORDER BY m.created ASC`,
    )
    .all(
      query.from ?? null,
      query.from ?? null,
      query.directory ?? null,
      query.directory ?? null,
    ) as { created: number; data: string; session: string }[]

  const perModel = new Map<string, ModelUsage>()
  const perDay = new Map<string, DayUsage>()
  const sessions = new Set<string>()
  const unpriced = new Set<string>()

  let turns = 0
  let input = 0
  let output = 0
  let cost = 0

  for (const row of rows) {
    const message = JSON.parse(row.data) as {
      model?: string
      usage?: { input?: number; output?: number }
    }
    // Giliran tanpa usage tidak pernah sampai ke provider — pesan info, error
    // sebelum permintaan pertama. Menghitungnya sebagai giliran akan membuat
    // rata-rata per giliran turun tanpa sebab yang bisa dilihat siapa pun.
    if (!message.usage) continue

    const model = message.model ?? "(tidak diketahui)"
    const inTokens = message.usage.input ?? 0
    const outTokens = message.usage.output ?? 0
    const price = priceOf(config, message.model)
    const spent = turnCost(price, message.usage)

    turns += 1
    input += inTokens
    output += outTokens
    sessions.add(row.session)
    if (spent === undefined) unpriced.add(model)
    else cost += spent

    const model_ = perModel.get(model) ?? { model, turns: 0, input: 0, output: 0 }
    model_.turns += 1
    model_.input += inTokens
    model_.output += outTokens
    if (spent !== undefined) model_.cost = (model_.cost ?? 0) + spent
    perModel.set(model, model_)

    const key = localDay(row.created)
    const day = perDay.get(key) ?? { day: key, turns: 0, input: 0, output: 0 }
    day.turns += 1
    day.input += inTokens
    day.output += outTokens
    if (spent !== undefined) day.cost = (day.cost ?? 0) + spent
    perDay.set(key, day)
  }

  return {
    ...(query.from === undefined ? {} : { from: query.from }),
    turns,
    sessions: sessions.size,
    input,
    output,
    cost,
    unpriced: [...unpriced].sort(),
    // Model diurut dari yang paling banyak dipakai; hari diurut waktu. Dua
    // pertanyaan berbeda: "apa yang memakan biaya" dan "kapan".
    byModel: [...perModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
    byDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }
}

/**
 * Token yang sudah dipakai satu sesi, lintas giliran.
 *
 * Dipisah dari `collectStats` karena ia dipanggil di jalur panas — sekali tiap
 * giliran, untuk memeriksa anggaran sesi — dan tidak butuh pengelompokan apa
 * pun. Satu SUM di database jauh lebih murah daripada mengurai setiap pesan.
 */
export function sessionTokens(sessionID: string): number {
  const rows = database()
    .prepare("SELECT data FROM message WHERE session_id = ? AND role = 'assistant'")
    .all(sessionID) as { data: string }[]

  let total = 0
  for (const row of rows) {
    const usage = (JSON.parse(row.data) as { usage?: { input?: number; output?: number } }).usage
    if (!usage) continue
    total += (usage.input ?? 0) + (usage.output ?? 0)
  }
  return total
}
