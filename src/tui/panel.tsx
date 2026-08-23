import { Box, Text } from "ink"
import { panelBody, panelTitle, type PanelLine, type PanelSide } from "./panels.ts"

/**
 * Wadah satu panel samping.
 *
 * Komponennya sengaja tipis: seluruh keputusan tentang berapa yang muat ada di
 * `panels.ts` supaya bisa diuji tanpa merender apa pun, dan supaya lebar yang
 * dipotong di sini adalah lebar yang sama dengan yang direservasi di `app.tsx`.
 *
 * Isi datang sebagai baris jadi, bukan sebagai komponen. Alasannya ada di
 * `docs/extensions.md`: extension yang mengembalikan JSX menjadikan versi Ink
 * bagian dari kontrak publik Titah, dan komponen yang melempar saat render
 * menjatuhkan seluruh render tree — bukan panelnya.
 */
export interface PanelProps {
  side: PanelSide
  width: number
  rows: number
  title: string
  lines: PanelLine[]
  /** Panel yang sedang menerima tombol. Hanya satu yang boleh menyala. */
  focused?: boolean
}

export function Panel({ width, rows, title, lines, focused }: PanelProps) {
  const body = panelBody(lines, width, rows)
  return (
    <Box
      width={width}
      height={rows}
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text dimColor={!focused} bold={focused}>
        {panelTitle(title, width)}
      </Text>
      {body.map((entry, index) => (
        // Indeks sebagai key: baris panel tidak punya identitas sendiri, dan
        // isinya diganti utuh setiap refresh — tidak ada yang bisa digeser.
        <Text
          key={index}
          dimColor={entry.dim === true}
          bold={entry.bold === true}
          {...(entry.color !== undefined ? { color: entry.color } : {})}
        >
          {entry.text}
        </Text>
      ))}
    </Box>
  )
}
