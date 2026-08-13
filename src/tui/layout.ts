import type { Message, Part } from "../core/message.ts"
import { renderMarkdown, type Span } from "./markdown.ts"

/**
 * Perataan pesan menjadi baris siap-render.
 *
 * Layar penuh berarti tinggi terbatas: kalau riwayat dirender apa adanya, Ink
 * mendorong editor keluar layar dan user kehilangan tempat mengetik. Jadi
 * riwayat harus dipotong lebih dulu, bukan dibiarkan meluber.
 */

export type LineKind = "user" | "user-head" | "assistant" | "tool-ok" | "tool-run" | "tool-bad" | "detail" | "error" | "blank"

export interface Line {
  kind: LineKind
  text: string
  /** Kunci stabil supaya React tidak merender ulang seluruh riwayat. */
  key: string
  /** Potongan bergaya hasil markdown. Kalau kosong, `text` dirender polos. */
  spans?: Span[]
  /** `callID` tool yang diwakili baris ini — dipakai klik untuk membuka isinya. */
  toolID?: string
}

/**
 * Mana yang sedang dibuka: `true`/`false` untuk semuanya sekaligus (`ctrl+x d`),
 * atau himpunan `callID` untuk tool yang dibuka satu per satu lewat klik.
 */
export type Expansion = boolean | ReadonlySet<string>

function isOpen(expanded: Expansion, callID: string): boolean {
  return typeof expanded === "boolean" ? expanded : expanded.has(callID)
}

/**
 * Meringkas argumen tool jadi beberapa baris yang bisa dibaca.
 *
 * Dipakai tool yang masih BERJALAN, yang belum punya output apa pun. Tanpa ini,
 * membuka rincian di tengah pekerjaan tidak memperlihatkan apa-apa — justru saat
 * user paling ingin tahu apa yang sedang dijalankan atas namanya.
 */
export function describeInput(input: unknown, limit = 120): string[] {
  if (input === undefined || input === null) return []
  if (typeof input !== "object") return [String(input).slice(0, limit)]

  return Object.entries(input as Record<string, unknown>)
    .slice(0, 8)
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
      const flat = rendered.replace(/\s*\n\s*/g, " ⏎ ")
      return `${key}: ${flat.length > limit ? `${flat.slice(0, limit)}…` : flat}`
    })
}

/** Perkiraan jumlah baris terminal yang dipakai satu string setelah wrap. */
export function wrappedHeight(text: string, columns: number): number {
  if (columns <= 0) return 1
  return Math.max(1, Math.ceil(text.length / columns))
}

function toolLines(part: Extract<Part, { type: "tool" }>, expansion: Expansion): Line[] {
  const state = part.state
  const base = part.callID
  const expanded = isOpen(expansion, base)

  const body = (lines: string[]): Line[] =>
    lines.slice(0, 40).map((line, index) => ({
      kind: "detail" as const,
      text: `    │ ${line}`,
      key: `${base}:body:${index}`,
      toolID: base,
    }))

  if (state.status === "running") {
    const detail = describeInput(state.input)
    const head: Line = {
      kind: "tool-run",
      text: `  ◐ ${state.title ?? part.tool}…${!expanded && detail.length > 0 ? " ⋯" : ""}`,
      key: `${base}:run`,
      toolID: base,
    }
    return expanded ? [head, ...body(detail)] : [head]
  }
  if (state.status === "denied") {
    return [
      { kind: "tool-bad", text: `  ⊘ ${state.title}`, key: `${base}:deny`, toolID: base },
      { kind: "detail", text: `    ${state.reason}`, key: `${base}:deny-why`, toolID: base },
    ]
  }
  if (state.status === "error") {
    return [
      { kind: "tool-bad", text: `  ✗ ${part.tool}`, key: `${base}:err`, toolID: base },
      { kind: "detail", text: `    ${state.error}`, key: `${base}:err-why`, toolID: base },
    ]
  }
  if (state.status === "completed") {
    const multiline = state.output.includes("\n")
    // Selesai TANPA melempar bukan berarti berhasil: `task` mengembalikan
    // sub-agent yang gagal atau dihentikan sebagai hasil biasa, dan glyph
    // sukses di atasnya membuat riwayat berbohong tentang apa yang terjadi.
    const glyph = state.outcome === "failed" ? "✗" : state.outcome === "stopped" ? "⊘" : "✓"
    const head: Line = {
      kind: state.outcome ? "tool-bad" : "tool-ok",
      text: `  ${glyph} ${state.title}${!expanded && multiline ? " …" : ""}`,
      key: `${base}:ok`,
      toolID: base,
    }
    if (!expanded) return [head]
    return [head, ...body(state.output.split("\n"))]
  }
  return [{ kind: "detail", text: `  · ${part.tool}`, key: `${base}:pending`, toolID: base }]
}

/** Label blok, supaya perintah bisa dibedakan dari pertanyaan biasa sekilas. */
export function promptLabel(text: string): string {
  const trimmed = text.trimStart()
  if (trimmed.startsWith("/")) return "command"
  if (trimmed.startsWith("@")) return "delegated"
  return "you"
}

/**
 * Prompt user digambar sebagai BLOK bertepi, bukan satu baris berawalan.
 *
 * Saat menggulir riwayat yang panjang, jawaban model mengalir berhalaman-halaman
 * dan tanpa penanda yang tegas tidak ada cara cepat menemukan di mana satu
 * giliran berakhir dan giliran berikutnya dimulai. Awalan `› ` sebelumnya
 * terlalu mudah tenggelam di antara daftar berpoin jawaban.
 */
export function userBlock(text: string, keyBase: string): Line[] {
  const label = promptLabel(text)
  /*
   * TANPA baris kosong pendahulu.
   *
   * Setiap pesan sudah ditutup satu baris kosong oleh `messageLines`, jadi baris
   * pendahulu di sini membuat jaraknya DUA sebelum prompt user dan satu di
   * tempat lain. Ketidakteraturan itulah yang membuat percakapan terbaca
   * berlubang di satu tempat dan rapat di tempat lain — bukan kekurangan jarak,
   * melainkan jarak yang tidak sama.
   */
  const lines: Line[] = [
    { kind: "user-head", text: `┌─ ${label} `, key: `${keyBase}:head` },
  ]

  for (const [row, line] of text.split("\n").entries()) {
    lines.push({ kind: "user", text: `│ ${line}`, key: `${keyBase}:${row}` })
  }

  lines.push({ kind: "user-head", text: "└─", key: `${keyBase}:foot` })
  return lines
}

/**
 * Lebar tempat jawaban dirender.
 *
 * Nol berarti "tidak tahu", dan itu SENGAJA berarti tanpa pembungkusan — test
 * dan pemanggil non-TUI tidak punya terminal, dan membungkus ke lebar yang
 * dikarang akan membuat hasilnya bergantung pada angka yang tidak ada artinya.
 */
export function messageLines(message: Message, expanded: Expansion, width = 0): Line[] {
  const lines: Line[] = []

  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      // Prompt user ditampilkan apa adanya: yang diketik user bukan markdown,
      // dan merendernya akan menyembunyikan karakter yang sengaja ia tulis.
      if (message.role === "user") {
        lines.push(...userBlock(part.text, `${message.id}:${index}`))
        continue
      }

      for (const [row, rendered] of renderMarkdown(part.text, width).entries()) {
        lines.push({
          kind: "assistant",
          text: rendered.text,
          spans: rendered.spans,
          key: `${message.id}:${index}:${row}`,
        })
      }
      continue
    }
    lines.push(...toolLines(part, expanded))
  }

  if (message.error) {
    lines.push({ kind: "error", text: `  ⚠ ${message.error}`, key: `${message.id}:err` })
  }
  if (lines.length > 0) lines.push({ kind: "blank", text: "", key: `${message.id}:gap` })

  return lines
}

export function allLines(messages: Message[], expanded: Expansion, width = 0): Line[] {
  return messages.flatMap((message) => messageLines(message, expanded, width))
}

export interface Viewport {
  lines: Line[]
  /** Berapa baris tersembunyi di atas layar — dipakai penunjuk gulir. */
  hiddenAbove: number
  hiddenBelow: number
}

/**
 * Memotong riwayat ke jendela yang muat di layar.
 *
 * `scroll` dihitung dari BAWAH: 0 berarti menempel di pesan terbaru, yang
 * merupakan perilaku yang diharapkan saat percakapan sedang berjalan.
 */
export function viewport(lines: Line[], rows: number, scroll: number): Viewport {
  const height = Math.max(1, rows)
  if (lines.length <= height) {
    return { lines, hiddenAbove: 0, hiddenBelow: 0 }
  }

  const maxScroll = lines.length - height
  const clamped = Math.min(Math.max(0, scroll), maxScroll)
  const end = lines.length - clamped
  const start = end - height

  return {
    lines: lines.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: lines.length - end,
  }
}

/** Tinggi area riwayat setelah dikurangi panel atas, editor, dan footer. */
export function historyRows(totalRows: number, editorRows: number, headerRows = 4): number {
  const FOOTER = 1
  return Math.max(1, totalRows - headerRows - FOOTER - editorRows)
}

/** Tinggi kotak editor: isi + dua baris bingkai, dibatasi supaya tidak menelan layar. */
export function editorRows(draft: string, totalRows: number): number {
  const content = draft === "" ? 1 : draft.split("\n").length
  return Math.min(content, Math.max(1, Math.floor(totalRows / 3))) + 2
}
