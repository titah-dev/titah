import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { Session } from "../core/message.ts"
import type { QuestionRequest } from "../core/question.ts"
import type { PermissionRequest } from "../core/permission.ts"
import { logoLines, markLines } from "./logo.ts"
import { isBlank } from "./layout.ts"
import type { Line, LineKind } from "./layout.ts"
import { fitsWideHeader, headerLines } from "./header.ts"
import type { Suggestion } from "./complete.ts"

const COLOR: Record<LineKind, { color?: string; dim?: boolean; bold?: boolean }> = {
  // Blok prompt dibuat TEBAL, bukan sekadar berwarna: dalam gulungan panjang
  // warna saja hilang di antara kode berwarna dan daftar berpoin jawaban.
  user: { color: "cyan", bold: true },
  "user-head": { color: "cyan", dim: true },
  assistant: {},
  "tool-ok": { color: "green" },
  "tool-run": { color: "yellow" },
  "tool-bad": { color: "red" },
  detail: { dim: true },
  // Redup seperti `detail`, dan itu disengaja: penalaran adalah bahan mentah,
  // bukan jawaban, dan warna yang setara dengan jawaban akan membuatnya dibaca
  // sebagai jawaban.
  reasoning: { dim: true },
  error: { color: "red" },
  blank: {},
  // Redup, dan sengaja tanpa warna sendiri: ia keterangan tentang jawaban,
  // bukan bagian dari jawaban. Warna apa pun akan membuatnya bersaing dengan
  // isi yang justru ia terangkan.
  byline: { dim: true },
}

function shorten(value: string, room: number): string {
  return value.length > room ? `…${value.slice(-(room - 1))}` : value
}

function tilde(cwd: string): string {
  const home = process.env["HOME"]
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

/** Ukuran layar diteruskan supaya wordmark lebar dipakai kalau memang muat. */
export function Logo({ columns, rows }: { columns: number; rows: number }) {
  return (
    <Box flexDirection="column" alignItems="center">
      {logoLines(columns, rows).map((line, index) => (
        <Text key={index} color="green">
          {line}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Panel informasi di atas layar, seperti Claude Code: apa yang sedang aktif,
 * di satu tempat yang TIDAK ikut tergulir bersama percakapan.
 */
export function InfoPanel({
  cwd,
  model,
  agent,
  session,
  columns,
  showMark = false,
  account,
}: {
  cwd: string
  model: string
  agent?: string
  session?: Session
  columns: number
  showMark?: boolean
  /** Nama dari akun yang sedang login; kosong berarti belum login. */
  account?: string
}) {
  const mark = markLines()

  /*
   * Header lebar digambar sebagai baris teks utuh oleh `headerLines`, bukan
   * disusun dari kotak Ink bersarang — lihat komentar di header.ts. Tingginya
   * jadi satu angka yang bisa ditanyakan, dan itulah yang dipakai `historyRows`.
   */
  if (showMark && fitsWideHeader(columns, mark)) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {headerLines({
          columns,
          logo: mark,
          cwd,
          model,
          ...(agent ? { agent } : {}),
          ...(session?.title ? { session: session.title } : {}),
          ...(account ? { account } : {}),
        }).map((line, index) => (
          <Text key={index}>
            {line.spans.map((span, column) => (
              <Text
                key={column}
                {...(span.color ? { color: span.color } : {})}
                bold={span.bold === true}
                dimColor={span.dim === true}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  }

  const room = Math.max(12, columns - (showMark ? mark[0]?.length ?? 0 : 0) - 20)

  // TANPA flexGrow: kotak yang memenuhi tinggi tidak bisa ditengahkan oleh
  // induknya, dan teks akan menempel di baris paling atas panel.
  const info = (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color="green" bold>
          titah
        </Text>
        <Text dimColor>{shorten(tilde(cwd), room)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{shorten(session?.title || "new session", room)}</Text>
        <Text dimColor>
          {agent ? `${agent} · ` : ""}
          {model}
        </Text>
      </Box>
    </Box>
  )

  if (!showMark) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexShrink={0}>
        <Box flexDirection="column" flexGrow={1}>
          {info}
        </Box>
      </Box>
    )
  }

  // Lambang di kiri, informasi di kanan yang ditengahkan vertikal — panel
  // setinggi delapan baris terasa kosong kalau teksnya menempel di atas.
  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} flexShrink={0}>
      <Box flexDirection="column" marginRight={2}>
        {mark.map((line, index) => (
          <Text key={index} color="green">
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1} justifyContent="center">
        {info}
      </Box>
    </Box>
  )
}

export function History({
  lines,
  hiddenAbove,
  hiddenBelow,
  jumpHint = "end",
}: {
  lines: Line[]
  hiddenAbove: number
  hiddenBelow: number
  /** Tombol yang melompat ke bawah, diambil dari keymap yang sedang berlaku. */
  jumpHint?: string
}) {
  return (
    /*
     * `justifyContent="flex-end"` yang membuat jaraknya berhenti berubah.
     *
     * Kotak ini tingginya tetap — antara header dan ruang tunggu. Kalau isinya
     * ditumpuk dari ATAS, sisa kotak jatuh di BAWAH, tepat di antara pesan
     * terakhir dan prompt: percakapan pendek memberi jarak selebar layar,
     * percakapan panjang memberi nol. Ditumpuk dari bawah, sisanya pindah ke
     * atas, dan jarak ke prompt selalu `RESERVED_ROWS`.
     *
     * Harganya: di awal sesi, pesan pertama duduk di bawah dengan ruang kosong
     * di antara header dan dirinya. Itu tidak bisa dihindari selama prompt
     * terpaku di bawah — jaraknya harus muncul di salah satu ujung, dan ujung
     * atas adalah satu-satunya yang tidak memisahkan pesan dari prompt.
     */
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
      {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} lines above`}</Text> : null}
      {lines.map((line) => {
        const style = COLOR[line.kind]

        /*
         * Baris kosong digambar sebagai satu spasi, apa pun bentuknya.
         *
         * Baris kosong hasil markdown membawa `spans: [{ text: "" }]`, dan span
         * kosong membuat Ink menggambar elemen setinggi NOL. Jadi `viewport`
         * menghitungnya satu baris sementara layar tidak memberinya baris sama
         * sekali: jarak antar paragraf hilang, dan jendela gulir meleset persis
         * sebanyak baris kosong yang kebetulan ada di dalamnya.
         */
        if (isBlank(line)) return <Text key={line.key}> </Text>

        // Baris markdown dirender per potongan supaya tebal, miring, dan kode
        // punya gaya sendiri di dalam satu baris.
        if (line.spans && line.spans.length > 0) {
          return (
            <Text key={line.key}>
              {line.spans.map((span, index) => (
                <Text
                  key={index}
                  {...(span.color ? { color: span.color } : {})}
                  bold={span.bold === true}
                  italic={span.italic === true}
                  underline={span.underline === true}
                  dimColor={span.dim === true}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
          )
        }

        return (
          <Text
            key={line.key}
            {...(style.color ? { color: style.color } : {})}
            bold={style.bold === true}
            dimColor={style.dim === true}
          >
            {line.text === "" ? " " : line.text}
          </Text>
        )
      })}
      {hiddenBelow > 0 ? (
        // Tombolnya ikut disebut: penunjuk yang cuma bilang "ada di bawah" tanpa
        // memberi tahu cara ke sana membuat orang menekan panah bawah berkali-kali.
        <Text dimColor>{`  ↓ ${hiddenBelow} lines below · ${jumpHint} to jump`}</Text>
      ) : null}
    </Box>
  )
}

export function PermissionDialog({ request }: { request: PermissionRequest }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} flexShrink={0}>
      <Text color="yellow" bold>
        {request.agent ? `${request.agent} · ` : ""}
        Permission requested ({request.kind}): {request.title}
      </Text>
      {request.detail
        .split("\n")
        .slice(0, 10)
        .map((line, index) => (
          <Text key={index} dimColor>
            {line}
          </Text>
        ))}
      <Text>
        <Text color="green">[y]</Text> allow once {"  "}
        <Text color="green">[a]</Text> always ({request.pattern}) {"  "}
        <Text color="red">[n]</Text> deny
      </Text>
    </Box>
  )
}

/**
 * Pertanyaan model, menunggu jawaban user.
 *
 * Bingkainya biru, bukan kuning: kuning milik dialog izin, dan dua hal yang
 * menuntut tindakan berbeda tidak boleh terlihat sama saat jam dua pagi.
 *
 * Pilihan bernomor hanya PINTASAN. Jawaban bebas tetap diterima — daftar
 * pilihan buatan model tidak selalu memuat jawaban yang benar, dan memaksa user
 * memilih dari daftar yang salah adalah cara mengubah pertanyaan jadi tebakan
 * yang ditandatangani orang lain.
 */
export function QuestionDialog({ request }: { request: QuestionRequest }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text color="cyan" bold>
        {request.agent ? `${request.agent} · ` : ""}
        {/* Penawaran pindah mode diberi judul sendiri: user harus tahu bahwa
            menekan angka di sini MENGUBAH mode, bukan sekadar menjawab. */}
        {request.intent === "switch-agent" ? "Plan mode — switch to make changes?" : "Question"}
      </Text>
      {request.question
        .split("\n")
        .slice(0, 6)
        .map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      {request.options.slice(0, 9).map((option, index) => (
        <Text key={option}>
          <Text color="cyan">[{index + 1}]</Text> {option}
        </Text>
      ))}
      <Text dimColor>
        {request.intent === "switch-agent"
          ? "press a number to switch · esc to stay in Plan"
          : `${request.options.length > 0 ? "press a number, or " : ""}type an answer and press enter · esc to skip`}
      </Text>
    </Box>
  )
}

export function Editor({
  value,
  cursor,
  disabled,
}: {
  value: string
  cursor: number
  disabled: boolean
}) {
  const before = value.slice(0, cursor)
  const at = value.slice(cursor, cursor + 1) || " "
  const after = value.slice(cursor + 1)

  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1} flexShrink={0}>
      <Text color={disabled ? "gray" : "cyan"}>{"› "}</Text>
      <Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    </Box>
  )
}

export function Footer({
  status,
  model,
  usage,
  leaderActive,
  exitArmed = false,
  hint,
  mouseCapture = true,
}: {
  status: "idle" | "working"
  model: string
  usage: {
    input: number
    output: number
    external: { input: number; output: number; cost: number; used: boolean }
  }
  leaderActive: boolean
  /** ctrl+c sudah ditekan sekali pada prompt kosong. */
  exitArmed?: boolean
  hint?: string
  /** Kalau mati, itu keadaan yang harus terlihat TERUS — bukan sekejap. */
  mouseCapture?: boolean
}) {
  const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  // Selama sebuah turn hidup, footer adalah SATU-SATUNYA tempat pesan sekejap
  // (flash) dan status leader terlihat — panel sub-agent dan tombol leader
  // sama-sama dipakai justru PALING SERING saat turn berjalan. Precedence
  // lama menyembunyikan keduanya di belakang "● working", jadi setiap flash
  // panel (mis. "cancelling <agent>") menghilang tanpa bekas persis saat
  // paling dibutuhkan. `leaderActive` dan `hint` sekarang menang di atas
  // status kerja; marker "● " dipertahankan di kedua cabang itu supaya user
  // tidak pernah kehilangan jejak bahwa turn masih berjalan.
  const workingMarker = status === "working" ? <Text color="yellow">{"● "}</Text> : null

  return (
    <Box justifyContent="space-between" flexShrink={0}>
      <Text dimColor>
        {/* Konfirmasi keluar menang atas segalanya: ia berumur tiga detik, dan
            baris yang tertutup pesan lain membuat tekanan kedua jadi kejutan. */}
        {exitArmed ? (
          <>
            {workingMarker}
            <Text color="yellow">ctrl+c again to quit · any other key cancels</Text>
          </>
        ) : leaderActive ? (
          <>
            {workingMarker}
            <Text color="green">ctrl+x …</Text>
          </>
        ) : hint !== undefined ? (
          <>
            {workingMarker}
            <Text>{hint}</Text>
          </>
        ) : status === "working" ? (
          <Text color="yellow">● working — esc to cancel</Text>
        ) : (
          "ctrl+x for commands · /exit or ctrl+c twice to quit"
        )}
        {mouseCapture ? null : (
          // Ditampilkan TERUS, bukan sebagai pesan sekejap: selama ini menyala,
          // klik dan roda mouse tidak bekerja, dan user yang lupa sudah
          // mematikannya akan mengira fitur mouse-nya rusak.
          <Text color="yellow">{"  ✂ mouse off — drag to select"}</Text>
        )}
      </Text>
      <Text dimColor>
        {model} · {compact(usage.input)} in / {compact(usage.output)} out
        {usage.external.used ? (
          // Ungu, bukan hijau tema: angka ini milik agent LUAR, dan biayanya
          // tidak dijumlahkan ke token Titah. Warna yang sama membuat user
          // membaca keduanya sebagai satu total.
          <Text color="magenta">
            {"  ext "}
            {compact(usage.external.input)}/{compact(usage.external.output)}
            {usage.external.cost > 0 ? ` ≈$${usage.external.cost.toFixed(3)}` : ""}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}

/**
 * Layar pembuka: logo di atas, kotak prompt di TENGAH layar — seperti membuka
 * nvim. Setelah prompt pertama dikirim, tata letak berganti ke mode percakapan
 * dengan editor menempel di bawah.
 */
export function Splash({
  columns,
  rows,
  showLogo,
  cwd,
  model,
  agent,
  editor,
}: {
  columns: number
  rows: number
  showLogo: boolean
  cwd: string
  model: string
  agent?: string
  editor: ReactNode
}) {
  const boxWidth = Math.min(72, Math.max(24, columns - 8))

  // `flexGrow`, BUKAN `height={rows}`: layar pembuka harus menyisakan baris
  // terakhir untuk Footer. Tanpa itu tidak ada satu pun umpan balik di sini —
  // indikator leader dan seluruh pesan flash hanya hidup di footer, sehingga
  // `ctrl+x m` bekerja tapi terlihat persis seperti keybinding yang mati.
  return (
    <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
      {showLogo ? (
        <Logo columns={columns} rows={rows} />
      ) : (
        <Text color="green" bold>
          titah
        </Text>
      )}

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>
          {tilde(cwd)} · {agent ? `${agent} · ` : ""}
          {model}
        </Text>
      </Box>

      <Box width={boxWidth} flexDirection="column">
        {editor}
      </Box>

      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text dimColor>enter to send · ctrl+j newline · ↑↓ history · tab to switch agent</Text>
        <Text dimColor>@claude to delegate · /consensus to compare · /exit to quit</Text>
      </Box>
    </Box>
  )
}

/*
 * Bintang yang berkelip.
 *
 * # Kenapa ini yang dipilih
 *
 * Syaratnya tiga, dan bentuk ini satu-satunya yang memenuhi ketiganya sekaligus.
 *
 * SATU KOLOM. Bingkai yang lebarnya berbeda menggeser seluruh baris tiap detak,
 * dan geseran itu lebih mengganggu daripada spinner apa pun yang jelek.
 * Diverifikasi dengan `widthOf` milik repo ini, bukan diasumsikan: kelima
 * dingbat di bawah bernilai 1.
 *
 * TIDAK BERPUTAR. Bulatan langkah di riwayat sudah berputar (`◐◓◑◒`). Dua
 * gerakan yang berbeda JENISNYA bisa dibedakan sekilas tanpa dibaca; dua yang
 * sama-sama berputar hanya berbeda kalau diperhatikan — dan yang perlu
 * diperhatikan bukan lagi pembeda. Bintang ini berkelip: tiap bingkai mengubah
 * jumlah sudutnya, bukan memutar sudut yang sama.
 *
 * BAGUS PADA LAJU RENDAH. Ini yang menjatuhkan braille dua kali. Kelip tidak
 * menuntut kesinambungan antar bingkai — justru sebaliknya, lompatannya yang
 * membuatnya terbaca sebagai kelip. Empat detak per detik sudah cukup, dan
 * empat detak per detik adalah laju yang tidak membuat layar bergetar.
 *
 * Enam bingkai, 1.5 detik satu siklus. `✹` muncul dua kali dengan sengaja: ia
 * naik lalu turun, jadi tidak ada lompatan balik di ujung siklus.
 */
const SPINNER = ["✶", "✸", "✹", "✺", "✹", "✷"]

/** Bingkai spinner, dipisah supaya bisa diuji tanpa merender apa pun. */
export function spinnerFrame(tick: number): string {
  return SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length] as string
}

/*
 * Kata kerja yang berganti sesekali, bukan "working" yang sama selamanya.
 *
 * Gunanya bukan hiburan. Baris yang tidak pernah berubah berhenti dibaca, dan
 * ketika ia akhirnya membawa kabar — nama agent, detik yang menumpuk — mata
 * sudah terlatih melewatinya. Kata yang berganti membuat baris itu tetap hidup
 * tanpa menambah satu pun informasi yang harus diproses.
 *
 * Bahasa Inggris, mengikuti aturan repo: seluruh teks antarmuka Inggris, hanya
 * jawaban model yang mengikuti bahasa user.
 */
const WORKING_WORDS = [
  "Pondering",
  "Brewing",
  "Noodling",
  "Tinkering",
  "Wrangling",
  "Simmering",
  "Untangling",
  "Whittling",
  "Percolating",
  "Conjuring",
  "Rummaging",
  "Puzzling",
]

export function workingWord(seed: number): string {
  const at = ((seed % WORKING_WORDS.length) + WORKING_WORDS.length) % WORKING_WORDS.length
  return WORKING_WORDS[at] as string
}

/** Seberapa terang satu huruf: 0 redup, 1 biasa, 2 paling terang. */
export interface Glow {
  text: string
  level: 0 | 1 | 2
}

/**
 * Cahaya yang menyapu kata, bolak-balik.
 *
 * Segitiga, bukan gergaji: sesudah huruf terakhir ia BERBALIK alih-alih
 * melompat kembali ke huruf pertama. Lompatan itu terbaca sebagai kedipan di
 * ujung kata — satu bingkai yang tidak nyambung dengan tetangganya, persis
 * cacat yang membuat animasi terasa murah.
 *
 * Puncaknya satu huruf, dengan tetangga kiri-kanan setengah terang. Tanpa
 * gradasi itu yang terlihat cuma satu huruf berkedip sendirian, bukan cahaya
 * yang bergerak.
 */
export function shimmer(text: string, tick: number): Glow[] {
  const chars = [...text]
  if (chars.length < 2) return chars.map((char) => ({ text: char, level: 1 as const }))

  const span = chars.length - 1
  const phase = ((tick % (span * 2)) + span * 2) % (span * 2)
  const head = phase <= span ? phase : span * 2 - phase

  return chars.map((char, at) => {
    const distance = Math.abs(at - head)
    return { text: char, level: distance === 0 ? 2 : distance === 1 ? 1 : 0 }
  })
}

export interface WorkingLine {
  word: string
  glow: Glow[]
  /**
   * Kata ini baru berganti dan cahayanya BELUM kembali ke huruf pertama.
   *
   * Inilah satu-satunya penanda "masih bekerja" yang tidak menuntut user
   * membaca apa pun: warnanya menyala sekali tiap kata berganti, lalu padam
   * sendiri. Warna yang menyala terus akan diabaikan dalam sepuluh detik, sama
   * seperti kata yang tidak pernah berganti.
   */
  fresh: boolean
}

/**
 * Seluruh baris kerja: kata, cahayanya, dan kilatannya.
 *
 * # Kata berganti per LANGKAH, bukan per detak
 *
 * `step` dinaikkan pemanggil setiap Titah memulai tool baru — `ls` lalu `cat`
 * adalah dua kata yang berbeda. Versi sebelumnya menggantinya per delapan detik
 * dan itu keliru dengan cara yang halus: kata yang berganti sendiri sementara
 * pekerjaannya diam MEMBERI kesan ada kemajuan, dan itu kesan yang paling tidak
 * boleh dipalsukan indikator kerja. Tool yang macet lima menit sekarang
 * memegang satu kata selama lima menit — apa adanya.
 *
 * Yang tersisa dari detak hanyalah `sinceChange`, dan tugasnya cuma menganimasi
 * apa yang sudah diputuskan `step`.
 *
 * # Kenapa satu fungsi
 *
 * Kata, fase cahaya, dan kilatan warna sebelumnya tiga hitungan terpisah yang
 * harus SEPAKAT tentang kapan sebuah kata dimulai — dan tiga hitungan yang
 * harus sepakat adalah tiga kesempatan untuk tidak sepakat. Di sini ketiganya
 * lahir dari argumen yang sama, jadi "warnanya padam tepat saat cahaya kembali
 * ke awal" bukan kebetulan yang harus dijaga, melainkan bentuk fungsinya.
 *
 * `note` mengalahkan kata pilihan kalau pemanggil memberikannya: ia kabar
 * sungguhan, dan mengganti kabar dengan hiasan tidak pernah menguntungkan. Ia
 * tetap bercahaya, tapi tidak pernah berkilat — tidak ada pergantian yang perlu
 * diumumkan.
 */
export function workingLine(step: number, sinceChange: number, note?: string): WorkingLine {
  const elapsed = Math.max(0, sinceChange)
  const word = note ?? workingWord(step)

  // Cahaya dihitung dari SEJAK LANGKAHNYA MULAI, bukan dari detak absolut.
  // Kalau dari detak absolut, posisi cahaya saat kata berganti adalah
  // kebetulan — dan "kembali ke posisi awal" berhenti punya arti.
  const glow = shimmer(word, elapsed)
  const roundTrip = Math.max(1, [...word].length - 1) * 2

  return { word, glow, fresh: note === undefined && elapsed < roundTrip }
}

/**
 * Indikator kerja tepat di atas prompt.
 *
 * Diletakkan di sini, bukan hanya di footer, karena mata user ada di kotak
 * ketik — indikator yang jauh dari titik perhatian sama saja dengan tidak ada.
 */
export function Working({
  tick,
  note,
  elapsed,
  agent,
  step = 0,
  sinceStep = 0,
}: {
  tick: number
  note?: string
  elapsed: number
  agent?: string
  /** Berapa tool yang sudah dimulai. Naik satu = kata baru. */
  step?: number
  /** Detak sejak `step` terakhir berubah — hanya untuk menganimasi. */
  sinceStep?: number
}) {
  const line = workingLine(step, sinceStep, note)

  return (
    <Box flexShrink={0}>
      <Text color="yellow">{spinnerFrame(tick)} </Text>
      {/*
       * Nama agent TIDAK diredupkan, sementara sisanya redup.
       *
       * Ini satu-satunya bagian baris yang bisa bertentangan dengan layar lain:
       * footer menyebut agent yang akan dipakai BERIKUTNYA, baris ini menyebut
       * yang sedang berjalan, dan keduanya berpisah persis saat user menekan
       * Tab di tengah giliran. Yang bisa membantah bagian lain dari layar tidak
       * boleh jadi bagian paling sulit dilihat.
       */}
      {agent ? <Text color="cyan">{agent} </Text> : undefined}
      {/*
       * Kata yang bercahaya huruf per huruf, dan BERWARNA satu kali tiap ia
       * berganti.
       *
       * Warnanya padam sendiri begitu cahaya kembali ke huruf pertama — satu
       * kilatan per kata, bukan warna yang menyala terus. Yang menyala terus
       * berhenti diperhatikan dalam sepuluh detik, sama seperti kata yang tidak
       * pernah berganti; yang berkilat sesekali tetap menangkap mata tanpa
       * pernah menuntut dibaca.
       *
       * Hijau, bukan kuning: kuning sudah dipakai bintangnya di baris yang sama,
       * dan dua bagian sewarna terbaca sebagai satu bagian.
       */}
      {line.glow.map((glow, at) => (
        <Text
          key={at}
          {...(line.fresh ? { color: "green" } : {})}
          {...(glow.level === 2 ? { bold: true } : glow.level === 0 ? { dimColor: true } : {})}
        >
          {glow.text}
        </Text>
      ))}
      <Text dimColor> · {elapsed}s · esc to cancel</Text>
    </Box>
  )
}

const KIND_COLOR: Record<Suggestion["kind"], string> = {
  agent: "cyan",
  // Sengaja bukan hijau: agent luar harus terlihat berbeda dari tema.
  "external-agent": "magenta",
  file: "white",
  command: "green",
  skill: "blue",
  model: "yellow",
  "pick-agent": "cyan",
  session: "green",
  // Kuning seperti model: keduanya mengubah keadaan aplikasi, bukan teks prompt.
  action: "yellow",
  // Magenta seperti agent luar: keduanya menjalankan kode yang bukan kode Titah.
  extension: "magenta",
}

/**
 * Popup pilihan di atas prompt. Menampilkan jendela bergulir, bukan seluruh
 * daftar — 200 file akan mendorong prompt keluar layar.
 */
export function Popup({
  title,
  items,
  selected,
  height = 8,
}: {
  title: string
  items: Suggestion[]
  selected: number
  height?: number
}) {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexShrink={0}>
        <Text dimColor>{title}: no matches</Text>
      </Box>
    )
  }

  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height))
  const window = items.slice(Math.max(0, start), Math.max(0, start) + height)
  const offset = Math.max(0, start)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text dimColor>
        {title} · {items.length} · ↑↓ move · tab/enter select · esc close
      </Text>
      {window.map((item, index) => {
        const actual = offset + index
        const active = actual === selected
        return (
          <Box key={`${item.kind}:${item.value}`}>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "› " : "  "}
            </Text>
            <Text
              color={item.disabled === true ? "gray" : KIND_COLOR[item.kind]}
              bold={active}
              strikethrough={item.disabled === true}
            >
              {item.label}
            </Text>
            {item.detail ? <Text dimColor>{"  "}{item.detail}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}
