import { Box, Text } from "ink"
import type { SubagentState } from "../core/event.ts"

/**
 * Panel sub-agent: satu baris per anak, dengan glyph status, durasi berjalan,
 * dan catatan aktivitasnya.
 *
 * `panelLines` dipisah dari komponennya supaya formatnya bisa diuji tanpa
 * merender Ink sama sekali — sesuai pola `spinnerFrame` di components.tsx.
 */

const STATUS_GLYPH: Record<SubagentState["status"], string> = {
  running: "◐",
  queued: "∅",
  done: "✓",
  failed: "✗",
  stopped: "⊘",
}

/**
 * Baris antre TIDAK menampilkan durasi.
 *
 * Sub-agent yang antre belum mulai berjalan sama sekali — mencetak durasi di
 * baris itu akan terbaca seolah ia sudah lama berjalan, persis seperti macet,
 * padahal cuma menunggu writer serial memberi giliran. Catatannya sendiri
 * (mis. "waiting for a turn") sudah cukup menjelaskan KENAPA.
 */
export function panelLines(subagents: SubagentState[], now: number): string[] {
  return subagents.map((entry) => {
    const glyph = STATUS_GLYPH[entry.status]
    if (entry.status === "queued") return `${glyph} ${entry.agent}  ${entry.note}`
    const elapsed = Math.max(0, Math.floor((now - entry.startedAt) / 1000))
    return `${glyph} ${entry.agent}  ${elapsed}s  ${entry.note}`
  })
}

/**
 * Baris yang benar-benar dirender, DAN reservasi tinggi di app.tsx, harus
 * berbagi angka yang SAMA. Sebelumnya keduanya menyimpang diam-diam —
 * reservasi mengasumsikan maksimal ~10 baris, sementara komponen ini
 * merender SEMUA baris tanpa batas — dan begitu satu giliran koordinator
 * menghasilkan lebih dari itu, baris riwayat terbaru terdorong keluar layar
 * tanpa satu pun tanda kesalahan. Diekspor supaya app.tsx tidak menyalin
 * angka ini secara terpisah.
 */
export const SUBAGENT_PANEL_ROWS = 8

export function SubagentPanel({
  subagents,
  selected,
  height = SUBAGENT_PANEL_ROWS,
}: {
  subagents: SubagentState[]
  /** Baris yang sedang disorot; `x` membatalkan sub-agent PADA baris ini. */
  selected: number
  height?: number
}) {
  const lines = panelLines(subagents, Date.now())

  if (lines.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
        <Text dimColor>sub-agents · 0 · ↑↓ move · x cancel · esc close</Text>
        <Text dimColor>no sub-agents running</Text>
      </Box>
    )
  }

  // Jendela berpusat pada baris terpilih, sama seperti Popup di components.tsx.
  // Tanpa ini, ↓ bisa memindahkan pilihan ke baris yang TIDAK ditampilkan, dan
  // `x` akan membatalkan sub-agent yang usernya sendiri tidak bisa lihat.
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, lines.length - height)))
  const visible = lines.slice(start, start + height)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text dimColor>sub-agents · {subagents.length} · ↑↓ move · x cancel · esc close</Text>
      {visible.map((line, index) => {
        const actual = start + index
        const active = actual === selected
        return (
          <Box key={subagents[actual]?.sessionID ?? actual}>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {active ? "› " : "  "}
            </Text>
            <Text>{line}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
