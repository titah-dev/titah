import type { Message, Part } from "../core/message.ts"
import { renderMarkdown, type Span } from "./markdown.ts"
import { splitLines } from "../core/tool/types.ts"

/**
 * Perataan pesan menjadi baris siap-render.
 *
 * Layar penuh berarti tinggi terbatas: kalau riwayat dirender apa adanya, Ink
 * mendorong editor keluar layar dan user kehilangan tempat mengetik. Jadi
 * riwayat harus dipotong lebih dulu, bukan dibiarkan meluber.
 */

export type LineKind =
  | "user"
  | "user-head"
  | "assistant"
  | "tool-ok"
  | "tool-run"
  | "tool-bad"
  | "detail"
  | "reasoning"
  | "error"
  | "blank"
  /** Penanda agent di kaki jawaban. Redup, satu baris, tidak pernah berkedip. */
  | "byline"

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

/**
 * Batas baris ekor yang digambar. Harus SAMA dengan `PROGRESS_LINES`, dan
 * disebut di sini juga supaya render tidak pernah bergantung pada janji
 * penghasilnya.
 */
const RUNNING_TAIL_LINES = 5

/**
 * Bulatan yang berputar untuk langkah yang sedang berjalan.
 *
 * Bentuknya BULAT seperti glyph selesai (`✓`) dan gagal (`✗`) — sama-sama satu
 * kolom, jadi judul di sebelahnya tidak bergeser saat langkahnya selesai.
 * Bergeser satu kolom di tengah gulungan terbaca sebagai teks yang melompat,
 * dan itu lebih mengganggu daripada tidak ada animasi sama sekali.
 *
 * Berputar, bukan berkedip. Berkedip berarti separuh waktu glyph-nya HILANG,
 * dan baris yang kosong separuh waktu terlihat seperti langkah yang sudah
 * dibatalkan.
 */
const RUNNING_FRAMES = ["◐", "◓", "◑", "◒"]

export function runningFrame(tick: number): string {
  // `tick` bisa negatif kalau pemanggil menghitungnya dari selisih waktu.
  const index = ((tick % RUNNING_FRAMES.length) + RUNNING_FRAMES.length) % RUNNING_FRAMES.length
  return RUNNING_FRAMES[index] as string
}

function toolLines(
  part: Extract<Part, { type: "tool" }>,
  expansion: Expansion,
  tick: number,
): Line[] {
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
      text: `  ${runningFrame(tick)} ${state.title ?? part.tool}…${!expanded && detail.length > 0 ? " ⋯" : ""}`,
      key: `${base}:run`,
      toolID: base,
    }

    /*
     * Ekor keluaran, kalau tool-nya melaporkan.
     *
     * Dibatasi LAGI di sini, bukan hanya di penghasilnya. `historyRows`
     * menghitung baris, dan blok yang tumbuh tak terduga mendorong isi keluar
     * layar — kelas bug yang sudah beberapa kali dikejar di TUI ini. Dua batas
     * untuk satu angka terlihat berlebihan sampai salah satunya berubah.
     */
    const live = (state.output ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-RUNNING_TAIL_LINES)
      .map((line, index) => ({
        kind: "detail" as const,
        text: `  │ ${line}`,
        key: `${base}:live:${index}`,
        toolID: base,
      }))

    return expanded ? [head, ...body(detail), ...live] : [head, ...live]
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
   * TANPA baris kosong pendahulu, dan ia sempat kembali sekali lewat revert.
   *
   * Setiap pesan sudah ditutup satu baris kosong oleh `messageLines`, jadi baris
   * pendahulu di sini membuat jaraknya DUA sebelum prompt user dan satu di
   * tempat lain — percakapan terbaca berlubang di satu tempat dan rapat di
   * tempat lain.
   *
   * Ia juga MENCURI bulatannya: `withGutter` menaruh `⏺` pada baris pertama
   * blok, dan kalau baris pertama itu kosong, bulatannya jatuh ke sana lalu
   * dilewati — judul bloknya kehilangan penanda tanpa ada yang tahu kenapa.
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
/**
 * Lebar talang kiri, dalam kolom. Dua: cukup untuk melepaskan huruf dari tepi
 * terminal, dan cukup sempit untuk tidak memakan lebar yang dipakai kode.
 */
const GUTTER = 2

/** Bulatan yang menandai awal satu bagian — jawaban, atau satu panggilan tool. */
const BULLET = "⏺"

/**
 * Memberi talang kiri pada satu blok, dengan bulatan di baris pertamanya.
 *
 * Dua hal sekaligus, dan keduanya diminta bersamaan: huruf tidak lagi menempel
 * pada tepi terminal, dan tiap bagian punya penanda yang membuat batasnya
 * terlihat tanpa harus membaca isinya.
 *
 * Dua spasi di depan teks aslinya DIBUANG lebih dulu. Baris tool sudah membawa
 * indentasinya sendiri sejak sebelum talang ini ada; tanpa pembuangan itu ia
 * akan bergeser dua kolom lagi dan bersarang lebih dalam daripada yang
 * dimaksudkan. Yang bersarang lebih dalam dari itu — rincian tool — tetap
 * bersarang, karena selisihnya yang dipertahankan, bukan angka mutlaknya.
 */
function withGutter(lines: Line[]): Line[] {
  return lines.map((line, index) => {
    // Baris kosong tidak diberi talang. Dua spasi pada baris yang isinya
    // memang tidak ada hanyalah spasi menggantung: tidak terlihat, tapi ikut
    // tersalin saat user menyeleksi teks dari terminal.
    if (line.kind === "blank" || line.text === "") return line
    const lead = index === 0 ? `${BULLET} ` : " ".repeat(GUTTER)
    const body = line.text.startsWith("  ") ? line.text.slice(GUTTER) : line.text
    return {
      ...line,
      text: `${lead}${body}`,
      // Span ikut diberi talang sebagai potongan TERSENDIRI, bukan digabung ke
      // potongan pertama: menempelkannya akan mewarisi warna dan ketebalan
      // potongan itu, dan bulatan yang ikut menebal bersama judul terbaca
      // sebagai bagian dari judulnya.
      ...(line.spans
        ? { spans: [{ text: lead, dim: index === 0 ? false : true }, ...trimSpans(line.spans)] }
        : {}),
    }
  })
}

/** Membuang dua spasi pertama dari deretan span, kalau memang ada. */
function trimSpans(spans: NonNullable<Line["spans"]>): NonNullable<Line["spans"]> {
  const [first, ...rest] = spans
  if (!first || !first.text.startsWith("  ")) return spans
  return [{ ...first, text: first.text.slice(GUTTER) }, ...rest]
}

/**
 * Penalaran model: mengalir saat berlangsung, terlipat setelah selesai.
 *
 * # Bagaimana ia tahu masih berlangsung
 *
 * Dari posisinya, bukan dari state tambahan: penalaran yang menjadi part
 * TERAKHIR berarti model belum mulai menjawab. Begitu teks jawaban menyusul, ia
 * bukan lagi yang terakhir dan langsung terlipat. Tidak ada flag yang harus
 * dijaga tetap sinkron, dan tidak ada keadaan yang bisa nyangkut menyala.
 *
 * # Kenapa tidak dirender sebagai markdown
 *
 * Ia bukan jawaban. Judul dan daftar berpoin di dalam penalaran akan tampil
 * dengan gaya yang sama dengan struktur jawaban, dan riwayat berhenti bisa
 * dibaca sekilas — yang justru satu-satunya alasan penalaran ditampilkan.
 *
 * # Kenapa memakai mekanisme lipat yang sudah ada
 *
 * Penalaran biasanya jauh lebih panjang daripada jawabannya; dibiarkan penuh ia
 * menenggelamkan yang sebenarnya dicari orang. Yang dipakai `Expansion` yang
 * SAMA dengan blok tool (`ctrl+x d`) — mekanisme kedua berarti dua tombol untuk
 * satu gagasan, dan yang kedua tidak akan ditemukan.
 */
export function reasoningLines(
  text: string,
  base: string,
  options: { live: boolean; expansion: Expansion; width?: number },
): Line[] {
  const body = splitLines(text)
  const open = options.live || isOpen(options.expansion, base)
  const width = options.width ?? 0
  const room = width > 0 ? Math.max(8, width - GUTTER - 2) : 0

  if (!open) {
    // Terlipat: satu baris, dan jumlahnya disebut supaya orang tahu ada berapa
    // banyak yang disembunyikan sebelum memutuskan membukanya.
    return [
      {
        kind: "reasoning",
        text: `  ✻ thinking (${body.length} ${body.length === 1 ? "line" : "lines"})`,
        key: `${base}:think`,
        toolID: base,
      },
    ]
  }

  return [
    { kind: "reasoning", text: "  ✻ thinking", key: `${base}:think`, toolID: base },
    ...body.flatMap((line, row) =>
      (room > 0 ? hardWrap(line, room) : [line]).map((piece, part) => ({
        kind: "reasoning" as const,
        text: `  │ ${piece}`,
        key: `${base}:think:${row}:${part}`,
        toolID: base,
      })),
    ),
  ]
}

/** Memotong keras ke lebar tertentu. Penalaran tidak perlu dibungkus di batas kata. */
function hardWrap(line: string, room: number): string[] {
  if (line.length <= room) return [line]
  const out: string[] = []
  for (let at = 0; at < line.length; at += room) out.push(line.slice(at, at + room))
  return out
}

export function messageLines(
  message: Message,
  expanded: Expansion,
  width = 0,
  tick = 0,
): Line[] {
  const lines: Line[] = []

  for (const [index, part] of message.parts.entries()) {
    /*
     * Satu baris kosong sebelum tiap bagian — tiap bulatan `⏺` adalah satu
     * "point", dan sebelumnya bagian-bagian itu ditempel tanpa jeda: keluaran
     * sebuah tool langsung disusul judul tool berikutnya, jadi batas antar
     * langkah harus dibaca dari glyph-nya, bukan terlihat sekilas.
     *
     * Hanya kalau belum ada yang kosong di sana. Jawaban markdown sering sudah
     * berakhir dengan baris kosongnya sendiri, dan dua baris kosong berturut-
     * turut adalah jarak yang tidak diminta siapa pun.
     */
    if (lines.length > 0 && !isBlank(lines.at(-1))) {
      lines.push({ kind: "blank", text: "", key: `${message.id}:${index}:sep` })
    }

    if (part.type === "text") {
      // Prompt user ditampilkan apa adanya: yang diketik user bukan markdown,
      // dan merendernya akan menyembunyikan karakter yang sengaja ia tulis.
      if (message.role === "user") {
        lines.push(...withGutter(userBlock(part.text, `${message.id}:${index}`)))
        continue
      }

      lines.push(
        ...withGutter(
          // Lebar DIKURANGI talangnya. Tanpa ini, baris yang dibungkus tepat
          // pada lebar terminal akan melewatinya dua kolom begitu talang
          // ditambahkan — dan terminal membungkusnya lagi sendiri, yang persis
          // masalah yang pembungkusan ini ada untuk mencegahnya.
          renderMarkdown(part.text, width > 0 ? Math.max(8, width - GUTTER) : 0).map((rendered, row) => ({
            kind: "assistant" as const,
            text: rendered.text,
            spans: rendered.spans,
            key: `${message.id}:${index}:${row}`,
          })),
        ),
      )
      continue
    }
    if (part.type === "reasoning") {
      lines.push(
        ...withGutter(
          reasoningLines(part.text, `${message.id}:${index}`, {
            // Part TERAKHIR berarti model belum mulai menjawab — ia masih
            // berpikir, dan menyembunyikannya persis saat itu terjadi
            // menghapus satu-satunya gunanya.
            live: index === message.parts.length - 1,
            expansion: expanded,
            width,
          }),
        ),
      )
      continue
    }
    lines.push(...withGutter(toolLines(part, expanded, tick)))
  }

  if (message.error) {
    lines.push({ kind: "error", text: `  ⚠ ${message.error}`, key: `${message.id}:err` })
  }

  /*
   * Penanda agent di KAKI jawaban, bukan di kepalanya.
   *
   * Di kepala ia dibaca sekali lalu tergulir pergi; pertanyaan "ini tadi agent
   * apa?" justru muncul setelah jawabannya selesai dibaca, dan saat itu mata
   * ada di bawah. Di sana pula ia jadi jawaban atas kebingungan yang sudah kita
   * temukan: footer bisa menyebut `build-auto` sementara giliran ini berjalan
   * di `build`, dan baris ini yang tidak ikut berubah.
   *
   * Hanya untuk jawaban model. Prompt user tidak dikerjakan agent mana pun.
   */
  if (message.role === "assistant" && message.agent && lines.length > 0) {
    lines.push({
      kind: "byline",
      text: `  ⌁ ${message.agent}`,
      key: `${message.id}:by`,
    })
  }

  if (lines.length > 0) lines.push({ kind: "blank", text: "", key: `${message.id}:gap` })

  return lines
}

/**
 * Apakah sebuah baris tidak menampilkan apa pun.
 *
 * Diputuskan dari ISI, bukan dari bentuknya. Baris kosong datang dalam dua rupa:
 * pemisah antar pesan (`text: ""`, tanpa span) dan baris kosong hasil markdown
 * (`spans: [{ text: "" }]`, karena setiap baris sumber selalu jadi satu baris
 * keluaran). Memeriksa "tidak punya span" hanya menangkap yang pertama — dan
 * yang kedua justru yang menumpuk paling banyak, karena jawaban model hampir
 * selalu berakhir dengan satu-dua baris kosong.
 */
export function isBlank(line: Line | undefined): boolean {
  if (!line) return false
  if (line.text.trim() !== "") return false
  return (line.spans ?? []).every((span) => span.text.trim() === "")
}

/**
 * Agent yang menjalankan giliran TERAKHIR, dibaca dari pesannya sendiri.
 *
 * Sengaja tidak mengambil dari pilihan agent di layar. Keduanya berpisah persis
 * saat penandanya paling dibutuhkan: user menekan Tab di tengah giliran, dan
 * pilihan di layar langsung menyebut nama baru sementara yang bekerja — beserta
 * izinnya, yang sudah dibekukan di awal giliran — masih yang lama.
 */
export function turnAgent(messages: Message[]): string | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (message?.role === "assistant") return message.agent
  }
  return undefined
}

export function allLines(
  messages: Message[],
  expanded: Expansion,
  width = 0,
  tick = 0,
): Line[] {
  const lines = messages.flatMap((message) => messageLines(message, expanded, width, tick))

  /*
   * Baris kosong di ekor riwayat dibuang seluruhnya.
   *
   * Ada dua sumbernya, dan keduanya menumpuk di tempat yang sama. Setiap pesan
   * membawa satu baris kosong di belakangnya sebagai PEMISAH — pesan terakhir
   * tidak punya yang dipisahkan. Dan jawaban model hampir selalu berakhir dengan
   * baris kosong sendiri, yang dirender apa adanya. Karena isi dijangkarkan ke
   * bawah, semuanya duduk tepat di atas ruang tunggu: dua baris yang diminta
   * berubah jadi lima, enam, tergantung berapa banyak newline yang kebetulan
   * dikirim model.
   *
   * Dibuang di sini, bukan di `messageLines` atau `renderMarkdown`: yang tahu
   * sebuah baris ada di EKOR hanyalah daftar utuhnya. Baris kosong di tengah —
   * antar paragraf, antar pesan — tidak tersentuh.
   */
  let end = lines.length
  while (end > 0 && isBlank(lines[end - 1])) end -= 1

  return end === lines.length ? lines : lines.slice(0, end)
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
  const outer = Math.max(1, rows)
  if (lines.length <= outer) {
    return { lines, hiddenAbove: 0, hiddenBelow: 0 }
  }

  /*
   * Penunjuk "↑ N lines above" dan "↓ N lines below" tinggal di dalam kotak yang
   * sama dengan riwayatnya, jadi mereka MEMAKAN baris. Sebelumnya jumlah baris
   * yang dikembalikan di sini tidak menghitung mereka: kotaknya menerima satu
   * atau dua baris lebih banyak daripada tingginya, dan Ink memotong kelebihan
   * itu di bawah — diam-diam, justru pada baris paling baru, yang paling ingin
   * dibaca orang.
   *
   * Jadi tingginya dihitung ulang sampai jumlah penunjuk berhenti berubah.
   * Menambah penunjuk menyempitkan jendela, jendela yang menyempit bisa
   * memunculkan penunjuk kedua, dan di situ ia berhenti — dua penunjuk adalah
   * batasnya, maka tiga putaran selalu cukup.
   */
  let indicators = 0
  let result: Viewport = { lines: [], hiddenAbove: 0, hiddenBelow: 0 }

  for (let pass = 0; pass < 3; pass += 1) {
    const height = Math.max(1, outer - indicators)
    const maxScroll = lines.length - height
    const clamped = Math.min(Math.max(0, scroll), maxScroll)
    const end = lines.length - clamped
    const start = end - height

    result = {
      lines: lines.slice(start, end),
      hiddenAbove: start,
      hiddenBelow: lines.length - end,
    }

    const needed = (result.hiddenAbove > 0 ? 1 : 0) + (result.hiddenBelow > 0 ? 1 : 0)
    if (needed === indicators) return result
    indicators = needed
  }

  return result
}

/**
 * Ruang tetap di atas prompt, dalam baris.
 *
 * Sebelumnya jarak antara baris terakhir dan prompt adalah SISA — ia berubah
 * mengikuti panjang percakapan, kadang nol kadang dua puluh. Dua baris ini
 * selalu ada, dan ukurannya tidak bergantung pada apa pun: tidak pada panjang
 * isi, tidak pada posisi gulir.
 *
 * Ia juga ruang tunggu: pesan yang baru tiba muncul di situ tanpa mendorong apa
 * pun, karena tempatnya sudah disediakan sejak awal.
 *
 * Yang membuatnya tetap saat digulir ada di dua tempat, dan keduanya harus ada:
 * angka ini dikurangi di `historyRows` (jadi riwayat tidak pernah mengira punya
 * dua baris lebih banyak daripada yang terlihat), dan `viewport` selalu
 * mengembalikan tepat setinggi itu ketika isinya melebihi layar — maka menggulir
 * menukar baris, bukan menambah atau mengurangi jumlahnya.
 */
export const RESERVED_ROWS = 2

/** Tinggi area riwayat setelah dikurangi panel atas, ruang tunggu, editor, dan footer. */
export function historyRows(totalRows: number, editorRows: number, headerRows = 4): number {
  const FOOTER = 1
  // `RESERVED_ROWS` ikut dikurangi DI SINI, bukan hanya dirender. Kalau hanya
  // dirender, viewport mengira punya dua baris lebih banyak daripada yang
  // benar-benar terlihat, dan dua baris teratas terpotong diam-diam.
  return Math.max(1, totalRows - headerRows - FOOTER - editorRows - RESERVED_ROWS)
}

/** Tinggi kotak editor: isi + dua baris bingkai, dibatasi supaya tidak menelan layar. */
export function editorRows(draft: string, totalRows: number): number {
  const content = draft === "" ? 1 : draft.split("\n").length
  return Math.min(content, Math.max(1, Math.floor(totalRows / 3))) + 2
}
