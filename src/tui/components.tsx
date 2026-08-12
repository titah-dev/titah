import type { ReactNode } from "react"
import { Box, Text } from "ink"
import type { Session } from "../core/message.ts"
import type { QuestionRequest } from "../core/question.ts"
import type { PermissionRequest } from "../core/permission.ts"
import { logoLines, markLines } from "./logo.ts"
import type { Line, LineKind } from "./layout.ts"
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
  error: { color: "red" },
  blank: {},
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
}: {
  cwd: string
  model: string
  agent?: string
  session?: Session
  columns: number
  showMark?: boolean
}) {
  const mark = markLines()
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
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${hiddenAbove} lines above`}</Text> : null}
      {lines.map((line) => {
        const style = COLOR[line.kind]

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
        Question
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
        {request.options.length > 0 ? "press a number, or " : ""}
        type an answer and press enter · esc to skip
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
        {leaderActive ? (
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
          "ctrl+x for commands · ctrl+c to quit"
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
        <Text dimColor>@claude to delegate · /consensus to compare · ctrl+c to quit</Text>
      </Box>
    </Box>
  )
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Bingkai spinner, dipisah supaya bisa diuji tanpa merender apa pun. */
export function spinnerFrame(tick: number): string {
  return SPINNER[tick % SPINNER.length] as string
}

/**
 * Indikator kerja tepat di atas prompt.
 *
 * Diletakkan di sini, bukan hanya di footer, karena mata user ada di kotak
 * ketik — indikator yang jauh dari titik perhatian sama saja dengan tidak ada.
 */
export function Working({ tick, note, elapsed }: { tick: number; note?: string; elapsed: number }) {
  return (
    <Box flexShrink={0}>
      <Text color="yellow">{spinnerFrame(tick)} </Text>
      <Text dimColor>
        {note ?? "working"} · {elapsed}s · esc to cancel
      </Text>
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
