/**
 * Pembatas laju untuk kabar dari tool yang sedang berjalan.
 *
 * # Kenapa ini ada, dan kenapa ia syarat bukan hiasan
 *
 * `npm test` memuntahkan ribuan potongan dalam beberapa detik. Menerbitkan tiap
 * potongan berarti ribuan event bus, ribuan render Ink, dan layar yang
 * kedip-kedip — keluhan yang sudah pernah muncul di TUI ini dan sudah
 * diperbaiki sekali dengan menurunkan frekuensi gambar ulang. Menerbitkan tanpa
 * batas mengembalikannya lewat pintu belakang.
 *
 * Jadi potongan yang datang di antara dua terbitan DIGABUNG, bukan dibuang.
 * Yang dikurangi frekuensinya, bukan isinya.
 *
 * # Yang disimpan hanya ekor
 *
 * Keluaran penuh sudah punya tempatnya di `completed.output`. Yang dibutuhkan
 * selagi berjalan cuma beberapa baris terakhir, dan menyimpan megabyte di state
 * yang diterbitkan berkali-kali per detik membayar mahal untuk kabar sekilas.
 */

/** Sesering apa kabar boleh terbit. Cukup terasa hidup, cukup jarang untuk tenang. */
export const PROGRESS_INTERVAL_MS = 200

/** Berapa baris terakhir yang disimpan. */
export const PROGRESS_LINES = 5

/** Batas keras, untuk baris tunggal yang panjangnya megabyte (progress bar, base64). */
export const PROGRESS_BYTES = 2048

/**
 * Memotong teks menjadi beberapa baris TERAKHIR.
 *
 * Baris kosong di ekor dibuang lebih dulu: keluaran perintah hampir selalu
 * berakhir dengan newline, dan tanpa ini baris terakhir yang terlihat selalu
 * kosong — satu dari lima baris terbuang untuk tidak menampilkan apa pun.
 */
export function tailOf(text: string, lines = PROGRESS_LINES, bytes = PROGRESS_BYTES): string {
  const trimmed = text.replace(/\s+$/, "")
  if (trimmed === "") return ""

  const all = trimmed.split("\n")
  const tail = all.slice(-lines).join("\n")
  return tail.length > bytes ? `…${tail.slice(-bytes)}` : tail
}

export interface Progress {
  /** Dipanggil tool, sesering apa pun. */
  push(chunk: string): void
  /**
   * Menerbitkan sisa yang tertahan, lalu berhenti.
   *
   * WAJIB dipanggil saat tool selesai. Tanpa itu, potongan yang datang di
   * jendela terakhir tidak pernah terlihat — dan justru potongan itu yang
   * biasanya berisi hasilnya.
   */
  flush(): void
}

/**
 * @param emit dipanggil dengan EKOR keluaran, paling sering sekali per interval
 */
export function throttleProgress(
  emit: (tail: string) => void,
  options: { intervalMs?: number; now?: () => number; schedule?: typeof setTimeout } = {},
): Progress {
  const interval = options.intervalMs ?? PROGRESS_INTERVAL_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? setTimeout

  let buffer = ""
  /*
   * `-Infinity`, bukan nol.
   *
   * Dengan nol, potongan pertama yang datang pada t=0 terbaca sebagai "baru
   * saja terbit" dan ikut ditunda — persis kebalikan dari yang dimaksud. Jam
   * palsu di test memulai dari nol dan menemukannya; pada jam sungguhan ia
   * akan lolos diam-diam, karena Date.now() tidak pernah nol.
   */
  let last = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  /*
   * Apakah ada yang MASUK sejak terbitan terakhir.
   *
   * Tanpa ini, `flush` menerbitkan ulang ekor yang sama persis dengan yang baru
   * saja terbit — satu gambar ulang untuk tidak ada perubahan apa pun, tepat di
   * saat tool selesai dan layar sedang paling sibuk.
   */
  let dirty = false

  const send = () => {
    timer = undefined
    if (done || !dirty) return
    last = now()
    dirty = false
    const tail = tailOf(buffer)
    if (tail !== "") emit(tail)
  }

  return {
    push(chunk: string) {
      if (done) return
      buffer += chunk
      dirty = true

      /*
       * Terbitan PERTAMA tidak ditunda.
       *
       * Perintah yang mencetak sesuatu lalu diam berjam-jam adalah kasus yang
       * paling butuh kabar, dan menunda yang pertama membuat justru kasus itu
       * terlihat menggantung selama dua ratus milidetik pertama tanpa alasan.
       */
      const since = now() - last
      if (since >= interval) return send()
      // Sudah ada yang menunggu giliran; potongan ini ikut di dalamnya.
      if (timer === undefined) timer = schedule(send, interval - since)
    },

    flush() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (done) return
      const tail = tailOf(buffer)
      const pending = dirty
      done = true
      if (pending && tail !== "") emit(tail)
    },
  }
}
