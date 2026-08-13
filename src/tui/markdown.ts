/**
 * Markdown untuk terminal, ditulis sendiri alih-alih memakai pustaka.
 *
 * Yang dibutuhkan hanya subset yang benar-benar dipakai jawaban agent — judul,
 * tebal/miring, kode, daftar, kutipan — dan output-nya harus berupa BARIS,
 * karena riwayat dipotong per baris agar muat di layar. Pustaka markdown
 * terminal mengembalikan satu blok string berwarna, yang tidak bisa dipotong
 * tanpa merusak kode ANSI di tengahnya.
 */

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
  underline?: boolean
  color?: string
}

export interface MarkdownLine {
  spans: Span[]
  /** Teks polos, dipakai untuk mengukur dan untuk test. */
  text: string
}

/**
 * Penekanan hanya dikenali lewat `*`, TIDAK lewat `_`.
 *
 * Jawaban coding agent penuh dengan `snake_case_name` dan `__init__`, dan
 * memperlakukan garis bawah sebagai penekanan mengubah nama identifier menjadi
 * teks miring yang salah. Menukar dukungan `_italic_` demi identifier yang utuh
 * adalah pertukaran yang jelas menguntungkan di sini.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/

/** Memecah satu baris menjadi span bergaya. Sisa teks tetap apa adanya. */
export function parseInline(input: string, base: Omit<Span, "text"> = {}): Span[] {
  const spans: Span[] = []
  let rest = input

  while (rest !== "") {
    const match = INLINE.exec(rest)
    if (!match || match.index === undefined) {
      spans.push({ ...base, text: rest })
      break
    }

    if (match.index > 0) spans.push({ ...base, text: rest.slice(0, match.index) })
    const token = match[0]

    if (token.startsWith("`")) {
      spans.push({ ...base, text: token.slice(1, -1), color: "yellow" })
    } else if (token.startsWith("**")) {
      spans.push({ ...base, text: token.slice(2, -2), bold: true })
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"))
      spans.push({ ...base, text: label, underline: true, color: "cyan" })
    } else {
      spans.push({ ...base, text: token.slice(1, -1), italic: true })
    }

    rest = rest.slice(match.index + token.length)
  }

  return spans.filter((span) => span.text !== "")
}

function plain(spans: Span[]): string {
  return spans.map((span) => span.text).join("")
}

/**
 * Membungkus span ke lebar tertentu, dan ini bagian TERPENTING dari berkas ini.
 *
 * Tanpanya satu baris logis yang lebih panjang dari terminal dibungkus oleh Ink
 * menjadi beberapa baris LAYAR — sementara `viewport` di layout.ts masih
 * menghitungnya sebagai satu. Selisih itu membuat isi meluber melewati kotak,
 * terpotong `overflow="hidden"`, dan gulirannya meleset sebanyak jumlah baris
 * yang terlanjur terbungkus. Gejalanya persis "jawabannya tidak terender dengan
 * baik".
 *
 * Jadi pembungkusannya dilakukan DI SINI, di tempat baris dibuat, supaya satu
 * baris logis selalu berarti satu baris layar.
 *
 * `hanging` adalah indent untuk baris LANJUTAN. Itu yang membuat daftar terbaca
 * seperti daftar: sambungan sebuah butir sejajar dengan teksnya, bukan dengan
 * bulatnya.
 */
export function wrapSpans(spans: Span[], width: number, hanging = 0): Span[][] {
  if (width <= 0) return [spans]

  const out: Span[][] = []
  let line: Span[] = []
  let used = 0
  let limit = width

  const flush = () => {
    out.push(line.length > 0 ? line : [{ text: "" }])
    line = []
    used = 0
    limit = width - hanging
    if (hanging > 0) {
      line.push({ text: " ".repeat(hanging) })
      used = hanging
      limit = width
    }
  }

  for (const span of spans) {
    // Dipecah pada spasi, TAPI spasinya dipertahankan menempel pada kata
    // sebelumnya — kalau dibuang, "a  b" jadi "a b" dan indentasi di dalam
    // kalimat hilang.
    const pieces = span.text.match(/\S+\s*|\s+/g) ?? []
    for (const piece of pieces) {
      const trimmed = piece.trimEnd()
      // Kata yang SENDIRIAN lebih panjang dari layar tidak bisa dibungkus di
      // batas kata — ia dipotong keras. Path panjang dan URL adalah kasus
      // normal, bukan kasus tepi.
      if (trimmed.length > width - hanging) {
        if (used > 0) flush()
        let rest = piece
        while (rest.length > limit - used) {
          const room = Math.max(1, limit - used)
          line.push({ ...span, text: rest.slice(0, room) })
          rest = rest.slice(room)
          flush()
        }
        if (rest !== "") {
          line.push({ ...span, text: rest })
          used += rest.length
        }
        continue
      }

      if (used + trimmed.length > limit && used > 0) flush()
      line.push({ ...span, text: piece })
      used += piece.length
    }
  }

  if (line.length > 0) out.push(line)
  return out.length === 0 ? [[{ text: "" }]] : out
}

/** Lebar tampilan sebuah baris, untuk meratakan kolom tabel. */
function widthOf(text: string): number {
  return text.length
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/

function splitRow(raw: string): string[] {
  const inner = TABLE_ROW.exec(raw)?.[1] ?? ""
  return inner.split("|").map((cell) => cell.trim())
}

/**
 * Tabel markdown jadi kolom yang benar-benar rata.
 *
 * Tanpa ini, `| a | b |` tampil apa adanya dan tabel yang rapi di sumbernya
 * jadi deretan pipa yang tidak sejajar — salah satu hal yang paling terlihat
 * salah di jawabaan yang penuh tabel.
 */
function renderTable(rows: string[][], width: number): MarkdownLine[] {
  const columns = Math.max(...rows.map((row) => row.length))
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...rows.map((row) => widthOf(row[index] ?? ""))),
  )

  // Kalau tidak muat, kolom dipersempit merata — memotong satu kolom saja
  // membuat tabel terlihat rusak alih-alih sempit.
  const total = widths.reduce((sum, value) => sum + value + 3, 1)
  if (total > width) {
    const room = Math.max(3, Math.floor((width - columns * 3 - 1) / columns))
    for (let index = 0; index < widths.length; index += 1) {
      widths[index] = Math.min(widths[index] as number, room)
    }
  }

  const cell = (text: string, index: number) => {
    const room = widths[index] as number
    const clipped = text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text
    return clipped.padEnd(room)
  }

  const out: MarkdownLine[] = []
  for (const [index, row] of rows.entries()) {
    const spans: Span[] = [{ text: "│ ", dim: true }]
    for (let column = 0; column < columns; column += 1) {
      // Baris pertama adalah kepala tabel.
      spans.push(
        ...(index === 0
          ? [{ text: cell(row[column] ?? "", column), bold: true }]
          : parseInline(cell(row[column] ?? "", column))),
      )
      spans.push({ text: " │ ", dim: true })
    }
    out.push({ spans, text: plain(spans) })

    if (index === 0) {
      const bar = widths.map((value) => "─".repeat(value)).join("─┼─")
      const text = `├─${bar}─┤`
      out.push({ spans: [{ text, dim: true }], text })
    }
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^\s*([-*_])\1{2,}\s*$/
const FENCE = /^\s*```(.*)$/

/**
 * Merender markdown menjadi baris siap tampil.
 *
 * Blok kode dipertahankan apa adanya: isinya tidak diurai sebagai markdown,
 * karena `*` dan `_` di dalam kode adalah kode, bukan penekanan.
 */
export function renderMarkdown(source: string, width = 0): MarkdownLine[] {
  const out: MarkdownLine[] = []
  let inFence = false
  let table: string[][] = []

  /** Menutup tabel yang sedang dikumpulkan, kalau ada. */
  const flushTable = () => {
    if (table.length === 0) return
    out.push(...renderTable(table, width > 0 ? width : 80))
    table = []
  }

  /** Menambahkan satu baris, dibungkus ke lebar layar kalau lebarnya diketahui. */
  const push = (spans: Span[], hanging = 0) => {
    if (width <= 0) {
      out.push({ spans, text: plain(spans) })
      return
    }
    for (const wrapped of wrapSpans(spans, width, hanging)) {
      out.push({ spans: wrapped, text: plain(wrapped) })
    }
  }

  for (const raw of source.split("\n")) {
    const fence = FENCE.exec(raw)
    if (fence) {
      flushTable()
      inFence = !inFence
      const language = (fence[1] ?? "").trim()
      const label = inFence ? `╭─ ${language === "" ? "code" : language}` : "╰─"
      out.push({ spans: [{ text: label, dim: true }], text: label })
      continue
    }

    if (inFence) {
      /*
       * Isi blok kode TIDAK dibungkus di batas kata — ia dipotong keras.
       * Membungkus kode pada spasi mengubah indentasinya, dan indentasi adalah
       * bagian dari arti kode. Yang tidak muat lebih baik terpotong dan terlihat
       * terpotong daripada dilipat jadi sesuatu yang terbaca salah.
       */
      const gutter = "│ "
      const room = width > 0 ? Math.max(8, width - gutter.length) : raw.length
      const body = raw.length > room ? `${raw.slice(0, room - 1)}…` : raw
      const spans: Span[] = [
        { text: gutter, dim: true },
        { text: body, color: "yellow" },
      ]
      out.push({ spans, text: plain(spans) })
      continue
    }

    // Tabel dikumpulkan dulu, baru dirender bersama — lebar kolomnya tidak bisa
    // diketahui sebelum semua barisnya terlihat.
    if (TABLE_ROW.test(raw)) {
      if (!TABLE_SEPARATOR.test(raw)) table.push(splitRow(raw))
      continue
    }
    flushTable()

    if (RULE.test(raw)) {
      const text = "─".repeat(Math.max(8, Math.min(width > 0 ? width : 40, 40)))
      out.push({ spans: [{ text, dim: true }], text })
      continue
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      const level = (heading[1] as string).length
      const body = heading[2] as string
      /*
       * Tingkatannya dibedakan, bukan diseragamkan.
       *
       * Judul yang semuanya terlihat sama menghapus satu-satunya hal yang
       * disampaikan judul: struktur. `#` dan `##` adalah bagian, `###` ke bawah
       * adalah sub-bagian di dalamnya.
       */
      const spans: Span[] =
        level === 1
          ? [{ text: body.toUpperCase(), bold: true, color: "green" }]
          : level === 2
            ? [{ text: body, bold: true, color: "green" }]
            : [{ text: body, bold: true, color: "cyan" }]
      push(spans)
      continue
    }

    const quote = QUOTE.exec(raw)
    if (quote) {
      push([{ text: "│ ", dim: true }, ...parseInline(quote[1] as string, { dim: true })], 2)
      continue
    }

    const numbered = NUMBERED.exec(raw)
    if (numbered) {
      const marker = `${numbered[1] as string}${numbered[2] as string}. `
      push([{ text: marker, color: "cyan" }, ...parseInline(numbered[3] as string)], marker.length)
      continue
    }

    const bullet = BULLET.exec(raw)
    if (bullet) {
      const indent = bullet[1] as string
      // Bulatan bertingkat: butir bersarang memakai tanda yang berbeda supaya
      // kedalamannya terbaca meski indentasinya kecil.
      const glyph = indent.length >= 2 ? "◦" : "•"
      const marker = `${indent}${glyph} `
      push([{ text: marker, color: "cyan" }, ...parseInline(bullet[2] as string)], marker.length)
      continue
    }

    push(parseInline(raw))
  }

  flushTable()
  // Blok kode yang tidak ditutup tetap terbaca; jangan diam-diam menelan sisanya.
  if (inFence) out.push({ spans: [{ text: "╰─", dim: true }], text: "╰─" })

  return out
}
