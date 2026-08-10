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

export function SubagentPanel({
  subagents,
  selected,
}: {
  subagents: SubagentState[]
  /** Baris yang sedang disorot; `x` membatalkan sub-agent PADA baris ini. */
  selected: number
}) {
  const lines = panelLines(subagents, Date.now())

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text dimColor>sub-agents · ↑↓ move · x cancel · esc close</Text>
      {lines.length === 0 ? (
        <Text dimColor>no sub-agents running</Text>
      ) : (
        lines.map((line, index) => {
          const active = index === selected
          return (
            <Box key={subagents[index]?.sessionID ?? index}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                {active ? "› " : "  "}
              </Text>
              <Text>{line}</Text>
            </Box>
          )
        })
      )}
    </Box>
  )
}
