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

/*
 * Rentang kode yang digambar terminal selebar DUA kolom (East Asian Wide dan
 * Fullwidth, plus emoji yang punya presentasi emoji secara bawaan).
 *
 * Datanya panjang karena memang data. Yang penting bukan kelengkapannya sampai
 * kode terakhir, melainkan bahwa `❌`, `✅`, dan CJK ada di dalamnya — merekalah
 * yang muncul di tabel dan merekalah yang selama ini membuat kolom meleset.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f978],
  [0x1f97a, 0x1f9cb],
  [0x1f9cd, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

function isWide(code: number): boolean {
  let low = 0
  let high = WIDE.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const [start, end] = WIDE[mid] as readonly [number, number]
    if (code < start) high = mid - 1
    else if (code > end) low = mid + 1
    else return true
  }
  return false
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" })

/**
 * Lebar TAMPILAN sebuah teks, dalam kolom terminal.
 *
 * Dulu ini `text.length`, dan itulah yang membuat tabel penuh `✅`/`❌` tidak
 * pernah rata: satu emoji dihitung satu kolom padahal terminal menggambarnya
 * dua, jadi tiap sel yang punya emoji melebihi kolomnya persis sebanyak emoji
 * di dalamnya.
 *
 * Dihitung per grapheme, bukan per code point: `⚠️` adalah dua code point
 * (`U+26A0 U+FE0F`) tapi satu tanda selebar dua kolom, dan emoji ber-ZWJ bisa
 * belasan code point untuk satu gambar.
 */
export function widthOf(text: string): number {
  let total = 0

  for (const { segment } of GRAPHEMES.segment(text)) {
    const code = segment.codePointAt(0)
    if (code === undefined) continue

    // Pemilih varian emoji memaksa presentasi emoji, yang selalu dua kolom —
    // termasuk pada tanda yang sendirian hanya satu kolom, seperti `⚠`.
    if (segment.includes("️")) {
      total += 2
      continue
    }

    // Kendali dan penanda tanpa lebar tidak menggeser kursor sama sekali.
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue
    if (code >= 0x0300 && code <= 0x036f) continue
    if (code === 0x200b || code === 0x200d || code === 0xfeff) continue

    total += isWide(code) ? 2 : 1
  }

  return total
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
/**
 * Memotong dan melapisi span sampai persis selebar `room` kolom.
 *
 * Bekerja pada span, bukan string, karena inilah satu-satunya tahap yang tahu
 * berapa lebar sel SETELAH markup-nya dilucuti.
 */
function fitSpans(spans: Span[], room: number): Span[] {
  const out: Span[] = []
  let used = 0

  for (const span of spans) {
    if (used >= room) break

    const sisa = room - used
    const lebar = widthOf(span.text)
    if (lebar <= sisa) {
      out.push(span)
      used += lebar
      continue
    }

    // Dipotong per grapheme: memotong per karakter bisa membelah emoji jadi
    // separuh code point, dan yang muncul di layar adalah sampah, bukan teks.
    let text = ""
    let terpakai = 0
    for (const { segment } of GRAPHEMES.segment(span.text)) {
      const tambahan = widthOf(segment)
      if (terpakai + tambahan > Math.max(1, sisa - 1)) break
      text += segment
      terpakai += tambahan
    }

    out.push({ ...span, text: `${text}…` })
    used += terpakai + 1
    break
  }

  if (used < room) out.push({ text: " ".repeat(room - used) })
  return out
}

function renderTable(rows: string[][], width: number): MarkdownLine[] {
  const columns = Math.max(...rows.map((row) => row.length))

  /*
   * Markup dilucuti DULU, baru kolomnya diukur.
   *
   * Sebelumnya urutannya terbalik: lebar dihitung dari teks mentah, sel
   * dilapisi sampai selebar itu, lalu `parseInline` membuang backtick dan
   * bintangnya. Setiap penanda yang hilang membuat sel itu menciut — jadi baris
   * yang memakai `kode` selalu lebih pendek daripada tetangganya, dan tabel yang
   * rapi di sumbernya tampil miring di layar.
   */
  const parsed = rows.map((row, index) =>
    Array.from({ length: columns }, (_, column) => {
      const spans = parseInline(row[column] ?? "")
      return index === 0 ? spans.map((span) => ({ ...span, bold: true })) : spans
    }),
  )

  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...parsed.map((row) => widthOf(plain(row[index] ?? [])))),
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

  const out: MarkdownLine[] = []
  for (const [index, row] of parsed.entries()) {
    const spans: Span[] = [{ text: "│ ", dim: true }]
    for (let column = 0; column < columns; column += 1) {
      spans.push(...fitSpans(row[column] ?? [], widths[column] as number))
      // Kolom terakhir ditutup tanpa spasi buntut: satu spasi setelah tepi
      // kanan membuat baris isi selalu satu kolom lebih lebar daripada garis
      // pemisahnya, dan tepi kanan tabel terlihat bergerigi.
      spans.push({ text: column === columns - 1 ? " │" : " │ ", dim: true })
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
