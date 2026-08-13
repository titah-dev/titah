import os from "node:os"
import { widthOf } from "./markdown.ts"
import type { Span } from "./markdown.ts"

/**
 * Header tiga kolom: lambang, identitas, dan dua kotak sambutan.
 *
 *   ╭──────┬───────────────┬──────────────────────╮
 *   │      │ Welcome, akil │ Tips for getting …   │
 *   │      │ titah         │ · …                  │
 *   │      │               ├──────────────────────┤
 *   │ LOGO │ new session   │ What's New           │
 *   │      │               │ · …                  │
 *   │      ├───────────────┴──────────────────────┤
 *   │      │ ~/Documents/Corporate/Titah/titah    │
 *   │      │ plan · 9router/ant                   │
 *   ╰──────┴──────────────────────────────────────╯
 *
 * Disusun sebagai BARIS TEKS, bukan sebagai kotak Ink bersarang. Alasannya dua.
 *
 * Pertama, sambungan garis. Dua kotak Ink bersebelahan menggambar dua tepi yang
 * berdiri sendiri; tidak ada yang tahu bahwa di titik pertemuannya seharusnya
 * ada `┬` atau `┴`. Yang keluar adalah garis yang hampir bersambung, dan hampir
 * adalah yang paling terlihat salah pada gambar bergaris.
 *
 * Kedua, dan ini yang menentukan: tingginya. `historyRows` harus tahu persis
 * berapa baris yang dimakan header, dan selisih satu baris saja membuat baris
 * teratas riwayat terpotong diam-diam. Dengan bentuk ini, yang diukur adalah
 * `headerLines(...).length` — angka yang sama persis dengan yang digambar,
 * bukan angka yang dihitung terpisah lalu dipercaya tetap cocok.
 */

export interface HeaderLine {
  text: string
  spans: Span[]
}

export interface HeaderInput {
  columns: number
  logo: string[]
  cwd: string
  model: string
  agent?: string
  session?: string
  /** Nama dari akun yang sedang login. Kosong berarti belum login. */
  account?: string
}

/** Lebar minimum kolom tengah dan kanan sebelum header ini menyerah. */
const MIN_MIDDLE = 20
const MIN_RIGHT = 28
const PAD = 1

/*
 * Tips dan kabar baru ditulis DI SINI, bukan dibaca dari CHANGELOG.md.
 *
 * CHANGELOG.md tidak ikut dalam `files` di package.json, jadi ia tidak ada sama
 * sekali pada npm install — header yang membacanya akan kosong justru di mesin
 * orang lain, tempat ia paling berguna. Menambahkannya ke `files` demi dua baris
 * teks berarti mengirim seluruh riwayat rilis ke setiap instalasi.
 */
const TIPS: readonly string[] = [
  "@claude <tanya> mendelegasikan ke agent lain",
  "/consensus membandingkan jawaban beberapa agent",
  "ctrl+x d membuka semua keluaran tool sekaligus",
  "/undo mengembalikan seluruh perubahan giliran terakhir",
  "tab berpindah agent tanpa kehilangan percakapan",
]

const NEWS: readonly string[] = [
  "Prompt terpaku di bawah, jaraknya tetap dua baris",
  "Tabel markdown rata, termasuk kolom berisi ✅/❌",
  "Login akun lewat browser, tanpa akun tetap penuh",
  "Peringatan eksperimental node:sqlite tidak lagi tercetak",
]

/**
 * Memilih satu butir dengan cara yang TIDAK berubah antar render.
 *
 * `Math.random()` di sini akan mengganti tipsnya setiap kali layar digambar
 * ulang — puluhan kali per giliran. Yang terlihat bukan tips, melainkan kedipan.
 * Jadi kuncinya diambil dari sesi: berbeda antar sesi, tetap di dalam satu sesi.
 */
function pick(items: readonly string[], key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return items[Math.abs(hash) % items.length] as string
}

/** Memotong teks ke lebar TAMPILAN, dengan elipsis kalau memang terpotong. */
export function fit(text: string, room: number): string {
  if (room <= 0) return ""
  if (widthOf(text) <= room) return text

  let out = ""
  let used = 0
  for (const char of text) {
    const next = widthOf(char)
    if (used + next > room - 1) break
    out += char
    used += next
  }
  return `${out}…`
}

function pad(text: string, room: number): string {
  const sisa = room - widthOf(text)
  return sisa > 0 ? text + " ".repeat(sisa) : text
}

/** Mengganti `$HOME` dengan `~`, supaya path panjang tidak menghabiskan kolom. */
export function tilde(value: string): string {
  const home = os.homedir()
  return value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
}

/**
 * Apakah header tiga kolom muat di layar selebar ini?
 *
 * Kalau tidak, pemanggilnya memakai header ringkas. Memaksakan tiga kolom di
 * terminal sempit menyisakan kolom selebar empat karakter — semua isinya jadi
 * elipsis, dan yang tersisa hanya gambar garis.
 */
export function fitsWideHeader(columns: number, logo: string[]): boolean {
  const left = logoWidthOf(logo) + PAD * 2
  const inner = columns - 2
  return inner - left - 2 - MIN_RIGHT >= MIN_MIDDLE
}

function logoWidthOf(logo: string[]): number {
  return logo.reduce((max, line) => Math.max(max, widthOf(line)), 0)
}

const DIM: Span["dim"] = true

export function headerLines(input: HeaderInput): HeaderLine[] {
  const logo = input.logo
  const left = logoWidthOf(logo) + PAD * 2
  const inner = input.columns - 2
  const right = Math.max(MIN_RIGHT, Math.floor((inner - left - 2) * 0.45))
  const middle = inner - left - 2 - right
  // Kolom bawah menyatu: dua kolom plus pembatas yang tidak lagi ada di sana.
  const wide = middle + 1 + right

  const nama = input.account ?? os.userInfo().username
  const kunci = input.session ?? nama
  const baris: HeaderLine[] = []

  const emit = (spans: Span[]) => {
    baris.push({ text: spans.map((span) => span.text).join(""), spans })
  }

  const rule = (room: number) => "─".repeat(Math.max(0, room))
  const tepi = (text: string): Span => ({ text, color: "green", dim: DIM })

  // Baris atas.
  emit([tepi(`╭${rule(left)}┬${rule(middle)}┬${rule(right)}╮`)])

  /** Satu baris tiga kolom, dengan potongan logo di kolom kiri. */
  const row = (index: number, tengah: Span[], kanan: Span[]) => {
    emit([
      tepi("│"),
      { text: ` ${pad(logo[index] ?? "", left - PAD * 2)} `, color: "green" },
      tepi("│"),
      ...cell(tengah, middle),
      tepi("│"),
      ...cell(kanan, right),
      tepi("│"),
    ])
  }

  /** Isi satu sel: satu spasi kiri, isi, lalu spasi sisa. */
  const cell = (spans: Span[], room: number): Span[] => {
    const isi = room - PAD * 2
    let used = 0
    const out: Span[] = [{ text: " " }]
    for (const span of spans) {
      const text = fit(span.text, isi - used)
      if (text === "") continue
      out.push({ ...span, text })
      used += widthOf(text)
    }
    out.push({ text: " ".repeat(Math.max(0, isi - used) + PAD) })
    return out
  }

  const tip = pick(TIPS, kunci)
  const news = pick(NEWS, `${kunci}:news`)

  row(0, [{ text: `Welcome, ${nama}` }], [{ text: "Tips for getting started", bold: true }])
  row(1, [{ text: "titah", color: "green", bold: true }], [{ text: `· ${tip}`, dim: DIM }])

  // Pembatas kotak kanan: kotak Tips ditutup, kotak What's New dibuka.
  emit([
    tepi("│"),
    { text: ` ${pad(logo[2] ?? "", left - PAD * 2)} `, color: "green" },
    tepi("│"),
    { text: " ".repeat(middle) },
    tepi(`├${rule(right)}┤`),
  ])

  row(3, [{ text: input.session || "new session", dim: DIM }], [{ text: "What's New", bold: true }])
  row(4, [{ text: "" }], [{ text: `· ${news}`, dim: DIM }])

  // Pembatas bawah: kolom tengah dan kanan menyatu di bawah sini.
  emit([
    tepi("│"),
    { text: ` ${pad(logo[5] ?? "", left - PAD * 2)} `, color: "green" },
    tepi(`├${rule(middle)}┴${rule(right)}┤`),
  ])

  const bawah = (index: number, spans: Span[]) => {
    emit([
      tepi("│"),
      { text: ` ${pad(logo[index] ?? "", left - PAD * 2)} `, color: "green" },
      tepi("│"),
      ...cell(spans, wide),
      tepi("│"),
    ])
  }

  bawah(6, [{ text: tilde(input.cwd), dim: DIM }])
  bawah(7, [
    ...(input.agent ? [{ text: input.agent, color: "cyan" } as Span, { text: " · ", dim: DIM }] : []),
    { text: input.model, dim: DIM },
  ])

  emit([tepi(`╰${rule(left)}┴${rule(wide)}╯`)])

  return baris
}
