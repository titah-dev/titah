/**
 * Permukaan publik untuk extension. Diimpor sebagai `titah-code/extension`.
 *
 * # Kenapa berkas ini nyaris tanpa runtime
 *
 * Yang ada di sini hanya tipe dan satu pemeriksa versi. Itu bukan kebetulan:
 * apa yang bisa di-`import` bisa dipanggil, jadi bentuk berkas inilah yang
 * menegakkan batas di `docs/extensions.md` — bukan kalimat di dokumen itu.
 *
 * Tidak ada satu pun re-eksport dari `core/permission.ts`, `core/auth.ts`, atau
 * `core/agent.ts`, dan tidak akan pernah ada. `setAutoApprove(sessionID, true)`
 * mematikan seluruh dialog izin dalam satu panggilan; extension yang bisa
 * menjangkaunya membuat "pilih di picker lalu tekan I" setara dengan
 * menyerahkan shell.
 *
 * # Selama 0.x bentuk di bawah masih bisa berubah
 *
 * Ini keterangan keadaan, bukan penafian: primitif `View` akan berubah sampai
 * ada cukup panel untuk mengetahui apa yang sungguh kurang. `engines.titah`
 * yang membuat perubahan itu gagal dengan kalimat yang menyebut sebabnya, alih-
 * alih `TypeError` di tengah render.
 */

/** Sisi tempat panel duduk. User boleh menimpanya di config. */
export type ExtensionSide = "left" | "right"

/**
 * Satu baris daftar.
 *
 * `selected` HANYA menandai; ia tidak menggerakkan apa pun. Kursor adalah milik
 * extension, karena hanya ia yang tahu apa arti "berikutnya" di daftarnya —
 * daftar branch bergerak per baris, daftar diff mungkin per berkas.
 */
export interface ViewRow {
  text: string
  dim?: boolean
  color?: string
  selected?: boolean
}

export interface ViewPair {
  key: string
  value: string
}

/**
 * Apa yang boleh digambar sebuah panel.
 *
 * Daftarnya sengaja kecil. Menebak primitif sebelum ada panel yang memakainya
 * berarti mengirim API yang lebih besar dari yang bisa dijaga — dan API publik
 * yang terlalu besar tidak bisa diperkecil lagi tanpa memutus orang.
 */
export type View =
  | { kind: "rows"; rows: ViewRow[] }
  | { kind: "pairs"; pairs: ViewPair[] }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }

export interface ExtensionContext {
  /** Direktori sesi. Extension menjalankan git terhadap direktori ini. */
  cwd: string
  /** Apa yang user tulis di `extension.<spec>.options`, apa adanya. */
  options: Record<string, unknown>
}

export interface RenderRequest {
  /**
   * Dibatalkan saat timeout habis atau panel ditutup.
   *
   * Diteruskan ke subprocess dan fetch: extension yang mengabaikannya tetap
   * bekerja untuk hasil yang tidak akan dipakai, dan pekerjaan itu bersaing
   * dengan giliran agent yang sedang berjalan di proses yang sama.
   */
  signal: AbortSignal
  /** Kolom yang tersedia untuk teks, sesudah bingkai dan padding. */
  width: number
  /** Baris yang tersedia untuk isi, sesudah bingkai dan judul. */
  rows: number
}

/** Apa yang boleh dikembalikan `onKey`. */
export interface KeyVerdict {
  /** Minta `render` dipanggil lagi. */
  refresh?: boolean
}

export interface ExtensionPanel {
  /** Judul di kepala panel. Dipotong kalau lebih lebar dari panelnya. */
  title: string
  /** Sisi yang diusulkan. User boleh menimpanya di config. */
  side?: ExtensionSide
  /**
   * Tombol yang DIUSULKAN untuk membuka panel ini, mis. `"<leader>g"`.
   *
   * Usulan, bukan klaim: tabrakan diperiksa saat install dan diselesaikan
   * sekali di picker. Lihat `chordOwner`.
   */
  key?: string
  render(request: RenderRequest): View | Promise<View>
  /** Dipanggil hanya saat panel ini yang sedang fokus. */
  onKey?(press: { key: string }): KeyVerdict | void
}

/**
 * Bentuk yang harus di-default-export sebuah modul extension.
 *
 * Factory, sama seperti `plugin` — satu pola untuk dua sistem berarti orang yang
 * sudah menulis plugin tidak perlu mempelajari pola kedua.
 */
export type ExtensionFactory = (context: ExtensionContext) => ExtensionPanel | Promise<ExtensionPanel>

/**
 * Apakah versi Titah memenuhi `engines.titah` sebuah extension.
 *
 * Sengaja hanya mengerti bentuk yang benar-benar dipakai orang di lapangan:
 * `*`, `1.2.3`, `^1.2.3`, `~1.2.3`, dan `>=1.2.3`. Rentang yang tidak dikenali
 * mengembalikan `false`, BUKAN `true` — memuat extension karena rentangnya
 * tidak terbaca adalah kebalikan dari gunanya pemeriksaan ini.
 *
 * Perhatikan aturan caret di bawah 1.0.0: `^0.3.1` hanya menerima 0.3.x, bukan
 * 0.4.0. Itu perilaku npm, dan menyimpang darinya membuat extension pecah pada
 * rilis yang penulisnya yakin sudah ia batasi.
 */
export function satisfiesEngine(version: string, range: string): boolean {
  const wanted = range.trim()
  if (wanted === "" || wanted === "*" || wanted === "x") return true

  const current = parseVersion(version)
  if (!current) return false

  const operator = wanted.startsWith(">=") ? ">=" : wanted.startsWith("^") ? "^" : wanted.startsWith("~") ? "~" : "="
  const target = parseVersion(wanted.slice(operator === ">=" ? 2 : operator === "=" ? 0 : 1))
  if (!target) return false

  if (operator === "=") return compare(current, target) === 0
  if (compare(current, target) < 0) return false
  if (operator === ">=") return true
  if (operator === "~") return current[0] === target[0] && current[1] === target[1]

  // Caret: major yang sama, kecuali di bawah 1.0.0 di mana minor berperan
  // sebagai major — persis aturan npm.
  if (target[0] !== 0) return current[0] === target[0]
  if (target[1] !== 0) return current[0] === 0 && current[1] === target[1]
  return current[0] === 0 && current[1] === 0 && current[2] === target[2]
}

type Version = [number, number, number]

function parseVersion(input: string): Version | undefined {
  /*
   * Ter-anchor di KEDUA ujung, dan itu yang menentukan.
   *
   * Tanpa `$`, rentang gabungan `">=0.1.0 <0.4.0"` cocok pada bagian pertamanya
   * dan sisanya diabaikan — jadi batas atas yang sengaja ditulis penulis
   * extension hilang tanpa jejak, dan Titah 2.0 memuat extension yang jelas-
   * jelas menolaknya. Ditemukan oleh test, bukan oleh mata.
   *
   * Prerelease dan build metadata tetap diterima lalu dibuang: extension tidak
   * pernah menargetkan `0.3.0-rc.1` berbeda dari `0.3.0`, dan membedakannya
   * hanya membuat rilis kandidat menolak setiap extension.
   */
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(input.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
