import type { View } from "../extension.ts"
import { renderMarkdown, widthOf } from "./markdown.ts"
import { PANEL_CHROME_COLUMNS, type PanelLine } from "./panels.ts"

/**
 * Mengubah `View` yang dikembalikan extension menjadi baris panel.
 *
 * Ada di sisi TUI dan bukan di `extension.ts` supaya permukaan publik tetap
 * tipis: penulis extension tidak perlu tahu bagaimana barisnya digambar, dan
 * Titah bebas mengubah cara menggambarnya tanpa memutus siapa pun.
 *
 * Lebar yang diminta adalah lebar PANEL, dan pengurangan bingkai terjadi di
 * sini sekali. Extension menerima `width` yang sudah bersih di `RenderRequest`,
 * jadi ia tidak pernah harus menebak berapa yang diambil bingkai — tebakan yang
 * salah di sisi extension muncul sebagai teks yang membungkus, dan yang
 * disalahkan orang adalah Titah.
 */
export function viewLines(view: View, panelWidth: number): PanelLine[] {
  const inner = Math.max(0, panelWidth - PANEL_CHROME_COLUMNS)

  switch (view.kind) {
    case "rows":
      return view.rows.map((row) => ({
        text: row.text,
        /*
         * `selected` menang atas `dim` kalau extension menyalakan keduanya.
         * Baris terpilih yang digambar redup adalah baris yang tidak terlihat
         * terpilih, dan itu membuat kursor panel hilang tepat saat dipakai.
         */
        ...(row.selected === true
          ? { bold: true }
          : row.dim === true
            ? { dim: true }
            : {}),
        ...(row.color !== undefined ? { color: row.color } : {}),
      }))

    case "pairs":
      return alignPairs(view.pairs, inner)

    case "markdown":
      /*
       * Span markdown diratakan jadi teks biasa di sini.
       *
       * Panel selebar enam belas kolom tidak punya ruang untuk membedakan tebal
       * dari miring secara berguna, dan `PanelLine` hanya membawa satu gaya per
       * baris. Yang dipertahankan adalah pembungkusan barisnya — itu yang benar-
       * benar menentukan apakah panel terbaca.
       */
      return renderMarkdown(view.text, inner).map((markdownLine) => ({
        text: markdownLine.spans.map((span) => span.text).join(""),
      }))

    case "text":
      return view.text.split("\n").map((text) => ({ text }))
  }
}

/**
 * Meratakan kolom nilai pada pasangan key-value.
 *
 * Lebar key diukur dengan `widthOf`, bukan `.length`: satu key berhuruf CJK
 * memakan dua kolom per karakter, dan meratakan pada jumlah karakter
 * menghasilkan kolom nilai yang bergerigi justru pada key yang paling lebar.
 *
 * Kalau key terlebar sudah menghabiskan ruang, perataan DILEPAS dan pasangan
 * ditumpuk dua baris. Memaksa satu baris di situ berarti nilainya terpotong
 * habis, dan pasangan tanpa nilai tidak memberi tahu apa pun.
 */
function alignPairs(pairs: { key: string; value: string }[], inner: number): PanelLine[] {
  const widest = pairs.reduce((max, pair) => Math.max(max, widthOf(pair.key)), 0)

  // Butuh minimal satu kolom untuk pemisah dan satu untuk nilainya.
  if (widest + 2 > inner) {
    return pairs.flatMap((pair) => [{ text: pair.key, dim: true }, { text: pair.value }])
  }

  return pairs.map((pair) => ({
    text: `${pair.key}${" ".repeat(widest - widthOf(pair.key))} ${pair.value}`,
  }))
}
