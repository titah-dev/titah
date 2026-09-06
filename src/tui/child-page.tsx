import { Box, Text } from "ink"
import { History } from "./components.tsx"
import type { Line } from "./layout.ts"

/**
 * Halaman transkrip satu sub-agent.
 *
 * Bukan overlay di atas percakapan induk melainkan HALAMAN penuh, sama seperti
 * layar pembuka: sub-agent punya percakapannya sendiri, dan menggambarnya di
 * dalam bingkai percakapan lain membuat dua transkrip yang berbeda terlihat
 * seperti satu.
 *
 * Baca-saja, dan itu keputusan, bukan kekurangan. Penyunting yang ikut digambar
 * di sini menjanjikan prompt yang bisa dikirim ke sesi anak — sesi yang justru
 * sedang dikendalikan koordinator, dan yang kalau disisipi pesan dari luar akan
 * mengubah pekerjaan yang sedang diawasi. Tanpa penyunting, ↑/↓/PageUp bebas
 * dipakai menggulir tanpa berebut dengan histori prompt.
 */

/**
 * Satu baris judul. Dipisah dari komponennya supaya bisa diuji tanpa Ink sama
 * sekali — pola yang sama dengan `panelLines` di `subagent-panel.tsx`.
 */
export function childHeader(agent: string, working: boolean, messages: number): string {
  // Saat berjalan, jumlah pesan BERUBAH tiap detik dan tidak berarti apa-apa
  // bagi pembacanya; yang ia tunggu cuma tahu bahwa ini belum selesai.
  const state = working ? "working" : `${messages} ${messages === 1 ? "message" : "messages"}`
  return `sub-agent · ${agent} · ${state}`
}

/**
 * Alasan sebuah sesi anak bisa kosong, dikatakan apa adanya.
 *
 * Layar hampa terbaca sebagai kegagalan memuat, dan satu-satunya cara user
 * membedakannya dari "memang tidak ada" adalah kalau layar yang mengatakannya.
 */
export const EMPTY_NOTE =
  "No transcript here. A super agent runs an external CLI and only sends its final answer back, " +
  "and a sub-agent cancelled before it started never wrote anything either."

export function ChildPage({
  agent,
  working,
  messages,
  lines,
  hiddenAbove,
  hiddenBelow,
}: {
  agent: string
  working: boolean
  /** Jumlah pesan, untuk judul DAN untuk memutuskan halaman kosong. */
  messages: number
  lines: Line[]
  hiddenAbove: number
  hiddenBelow: number
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor="magenta" paddingX={1} flexShrink={0}>
        <Text color="magenta">{childHeader(agent, working, messages)}</Text>
        <Text dimColor>{"  ·  esc back · ↑↓ pgup pgdn scroll"}</Text>
      </Box>

      {messages === 0 && !working ? (
        <Box flexGrow={1} paddingX={1}>
          <Text dimColor>{EMPTY_NOTE}</Text>
        </Box>
      ) : (
        <History lines={lines} hiddenAbove={hiddenAbove} hiddenBelow={hiddenBelow} jumpHint="end" />
      )}
    </Box>
  )
}
