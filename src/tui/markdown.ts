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
export function renderMarkdown(source: string): MarkdownLine[] {
  const out: MarkdownLine[] = []
  let inFence = false

  for (const raw of source.split("\n")) {
    const fence = FENCE.exec(raw)
    if (fence) {
      inFence = !inFence
      const language = (fence[1] ?? "").trim()
      const label = inFence && language !== "" ? `┌ ${language}` : inFence ? "┌" : "└"
      out.push({ spans: [{ text: label, dim: true }], text: label })
      continue
    }

    if (inFence) {
      const text = `  ${raw}`
      out.push({ spans: [{ text, color: "yellow" }], text })
      continue
    }

    if (RULE.test(raw)) {
      const text = "─".repeat(40)
      out.push({ spans: [{ text, dim: true }], text })
      continue
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      const level = (heading[1] as string).length
      const body = heading[2] as string
      const spans: Span[] = [
        { text: level === 1 ? body.toUpperCase() : body, bold: true, color: "green" },
      ]
      out.push({ spans, text: plain(spans) })
      continue
    }

    const quote = QUOTE.exec(raw)
    if (quote) {
      const spans: Span[] = [
        { text: "│ ", dim: true },
        ...parseInline(quote[1] as string, { dim: true }),
      ]
      out.push({ spans, text: plain(spans) })
      continue
    }

    const numbered = NUMBERED.exec(raw)
    if (numbered) {
      const spans: Span[] = [
        { text: `${numbered[1] as string}${numbered[2] as string}. `, color: "cyan" },
        ...parseInline(numbered[3] as string),
      ]
      out.push({ spans, text: plain(spans) })
      continue
    }

    const bullet = BULLET.exec(raw)
    if (bullet) {
      const spans: Span[] = [
        { text: `${bullet[1] as string}• `, color: "cyan" },
        ...parseInline(bullet[2] as string),
      ]
      out.push({ spans, text: plain(spans) })
      continue
    }

    const spans = parseInline(raw)
    out.push({ spans, text: plain(spans) })
  }

  // Blok kode yang tidak ditutup tetap terbaca; jangan diam-diam menelan sisanya.
  if (inFence) out.push({ spans: [{ text: "└", dim: true }], text: "└" })

  return out
}
