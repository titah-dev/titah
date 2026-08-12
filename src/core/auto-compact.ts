import type { ModelMessage } from "ai"
import {
  growthTokens,
  messageBytes,
  midTurnCut,
  overBudget,
  planAtCut,
  projectedContext,
  pruneToolOutputs,
  renderMessage,
  requestTokens,
  summariseInChunks,
  summariserChunkBytes,
  tailStart,
  wrapSummary,
} from "./compact.ts"
import type { Compaction } from "./schema.ts"
import {
  latestCompaction,
  listModelRows,
  replaceModelMessage,
  saveCompaction,
  summaryPair,
} from "./storage/session.ts"

export interface AutoCompactInput {
  sessionID: string
  compaction: Compaction
  contextWindow: number | undefined
  lastStepTokens: number | undefined
  /** Peringkas: (system, prompt) => summary. Disuntik supaya bisa diuji tanpa provider. */
  summarise: (system: string, prompt: string) => Promise<string>
  /** Instruksi giliran berjalan, diteruskan sebagai `focus`. */
  focus?: string
  /**
   * Batas ekor untuk pemadatan DI TENGAH giliran. Antar-giliran biarkan
   * undefined — di sana batasnya dihitung per giliran user (`tailStart`),
   * bukan per pesan, karena batas giliran memang masih ada untuk dihitung.
   */
  midTurn?: { keepMessages: number; budgetBytes: number }
  /** Tempat yang dipesan untuk pertumbuhan satu langkah — lihat `overBudget`. */
  growthMargin?: number
  /**
   * Token yang sudah menempel SETELAH `lastStepTokens` diukur, dan karena itu
   * pasti ikut di permintaan berikutnya — lihat `projectedContext`.
   *
   * Dipakai baik oleh pemicu maupun oleh keputusan "masih kelebihan?" di bawah.
   * Tanpanya keduanya menilai ukuran konteks dari angka yang sudah basi:
   * penghematan dikreditkan, tapi hasil tool yang baru tiba tidak pernah
   * didebitkan, sehingga upaya terakhir (memangkas ekor) — satu-satunya
   * mekanisme yang bisa menjangkau hasil itu — tidak pernah dijalankan.
   */
  arrivedTokens?: number
  /**
   * Jendela konteks PERINGKAS, kalau berbeda dari jendela model giliran.
   *
   * Prompt peringkas dibatasi jendela model yang MENULIS ringkasan — `smallModel`
   * — bukan jendela model yang sedang menjalankan giliran. Tanpa ini, prompt itu
   * tidak dibatasi apa pun: terukur 78.964 token pada smallModel yang menyatakan
   * jendela 4096, dan provider memotongnya diam-diam alih-alih menolak.
   *
   * TIDAK dinyatakan berarti "jangan potong" — seluruh transkrip dikirim dalam
   * satu panggilan tanpa batas, yaitu issue #1 yang belum tertutup.
   *
   * Itu disengaja, dan jaringnya ada di SISI PEMANGGIL: `summariserWindowFor`
   * yang jatuh ke jendela model giliran, karena hanya pemanggil yang tahu model
   * mana yang meringkas. Dua jaring untuk satu keputusan adalah bentuk kesalahan
   * yang sudah tiga kali menghasilkan cacat di siklus ini, jadi `autoCompact`
   * tidak memilikinya.
   *
   * Komentar ini pernah menyatakan KEBALIKANNYA ("tidak dinyatakan berarti pakai
   * jendela model giliran") setelah jaringnya dipindah — kontrak yang tertulis
   * salah adalah jebakan untuk pemanggil berikutnya, dan test yang memang
   * menghilangkannya sudah berjalan di jalur tanpa-potong tanpa ada yang tahu.
   */
  summariserWindow?: number
  /**
   * Ukuran bagian permintaan yang TIDAK ada di daftar pesan, dalam byte —
   * praktisnya system prompt.
   *
   * Dipakai `requestTokens` supaya permintaan yang diukur adalah permintaan yang
   * sungguh dikirim. Bawaannya nol, dan itu berarti "diukur tanpanya" bukan
   * "tidak ada": pemanggil yang tidak menyertakannya akan meremehkan permintaan.
   * Hanya `agent.ts` yang tahu angka ini, karena hanya ia yang merakit
   * system prompt-nya.
   */
  systemBytes?: number
}

export interface AutoCompactResult {
  ran: boolean
  prunedBytes: number
  summarised: boolean
  /**
   * Apakah pemadatan SUNGGUH membebaskan sesuatu.
   *
   * `ran` saja tidak bisa membedakan "menyala dan menolong" dari "menyala dan
   * tidak bisa berbuat apa-apa" — dan justru yang kedua itu yang membuat
   * kegagalan mid-turn tak terlihat begitu lama: pemanggilnya menyusun ulang
   * riwayat, melaporkan sukses, dan mengirim konteks yang sama besarnya.
   */
  changed: boolean
}

const IDLE: AutoCompactResult = { ran: false, prunedBytes: 0, summarised: false, changed: false }

/**
 * Memadatkan konteks sesi saat sudah mendekati batas jendela model.
 *
 * Satu jalur untuk dua situasi. Di tengah giliran, pemanggil sudah lebih dulu
 * menuliskan pesan giliran-sejauh-ini menjadi baris — sesuatu yang toh akan
 * ditulis di akhir giliran. Dengan begitu mesin pemadatan yang sudah ada (yang
 * bekerja atas baris dan batas air) dipakai apa adanya, alih-alih membangun
 * jalur kedua atas array di memori yang tidak meninggalkan jejak dan langsung
 * terhapus begitu gilirannya usai.
 */
export async function autoCompact(input: AutoCompactInput): Promise<AutoCompactResult> {
  const { compaction, sessionID } = input
  if (!compaction.auto) return IDLE
  const growth = input.growthMargin ?? 0
  // Ukuran konteks yang akan dikirim, bukan yang terakhir terukur — hasil tool
  // yang baru tiba sudah ada di tangan dan pasti ikut berangkat.
  const projected = projectedContext(input.lastStepTokens, input.arrivedTokens ?? 0)
  if (!overBudget(projected, input.contextWindow, compaction.reserved, growth)) {
    return IDLE
  }

  const previous = latestCompaction(sessionID)
  const rows = listModelRows(sessionID).filter((row) => !previous || row.seq > previous.seq)
  if (rows.length === 0) return IDLE

  const messages = rows.map((row) => row.message)
  const cut =
    input.midTurn === undefined
      ? tailStart(messages, compaction.tailTurns)
      : midTurnCut(messages, input.midTurn.keepMessages, input.midTurn.budgetBytes)

  // Versi termutakhir tiap pesan. Prune tahap kedua bekerja di atas hasil tahap
  // pertama, supaya byte yang sudah dibebaskan tidak terhitung dua kali.
  let current = messages
  let prunedBytes = 0
  /**
   * Byte yang dibebaskan dengan MENGGANTI riwayat lama oleh ringkasan.
   *
   * Dipakai hanya untuk mengkredit angka provider di `doesNotFit` — bukan untuk
   * memutuskan apakah peringkasan dibutuhkan; keputusan ITU diukur langsung.
   */
  let summaryFreed = 0

  const prune = (from: number, upTo: number, sparing = true): void => {
    const result = pruneToolOutputs(current, upTo, from, sparing)
    if (result.bytesFreed === 0) return
    for (const [index, message] of result.messages.entries()) {
      if (message === current[index]) continue
      const row = rows[index]
      if (row) replaceModelMessage(sessionID, row.seq, message)
    }
    current = result.messages
    prunedBytes += result.bytesFreed
  }

  if (compaction.prune && cut > 0) prune(0, cut)

  /**
   * Ukuran permintaan yang AKAN dikirim, DIUKUR — bukan disimpulkan dari angka
   * provider yang basi dikurangi taksiran penghematan.
   *
   * `summary` adalah ringkasan yang akan menyertai permintaan itu (yang lama
   * sebelum peringkasan, yang baru sesudahnya), dan `tail` pesan yang menyusul.
   * Bentuknya dirakit lewat `summaryPair` — fungsi yang sama yang dipakai
   * `listModelMessages` saat sungguh mengirim — supaya yang diukur dan yang
   * dikirim tidak bisa berbeda.
   *
   * `systemBytes` menutup satu-satunya bagian yang tidak ada di daftar pesan:
   * system prompt. Ia ikut memakan jendela yang sama, dan mengabaikannya berarti
   * meremehkan permintaan.
   */
  const measure = (summary: string | undefined, tail: ModelMessage[]): number =>
    requestTokens(
      summary === undefined ? tail : [...summaryPair(summary), ...tail],
      input.systemBytes ?? 0,
    )

  /**
   * Berapa token yang SUDAH dibebaskan giliran ini, untuk mengkredit angka
   * provider. Dihitung dengan penggaris yang sama (4:1) di kedua sisi.
   */
  const freedTokens = (): number => growthTokens(prunedBytes + summaryFreed)

  /**
   * Ukuran permintaan berikutnya: yang LEBIH BESAR antara yang diukur dan angka
   * provider yang dikreditkan. SATU aturan, dipakai kedua gerbang di bawah.
   *
   * Dua sinyal karena keduanya tidak lengkap sendiri-sendiri:
   *
   *   - Pengukuran nyata objeknya, tapi ia rasio byte→token: ia bisa meremehkan
   *     30–50% pada isi padat token, dan ia tidak melihat definisi tool.
   *   - Angka provider adalah FAKTA — termasuk definisi tool dan tokenisasi
   *     sungguhan — tapi tentang permintaan satu langkah lalu, jadi ia tidak tahu
   *     apa yang baru saja dibebaskan. Karena itu ia dikreditkan.
   *
   * Yang lebih besar menang, dan arahnya memang begitu: memadatkan tanpa perlu
   * ongkosnya satu panggilan peringkas, sementara TIDAK memadatkan saat perlu
   * berarti provider memotong diam-diam.
   *
   * Aturan ini pernah dipasang di `doesNotFit` SAJA, dan asimetri itu adalah
   * regresi yang terukur terhadap main: provider melaporkan 8.354 token pada
   * jendela 8192 — luapan nyata — pengukuran bilang 6.035, `needsMore` pulang
   * false, dan `autoCompact` tidak melakukan APA PUN. Di main, riwayat yang sama
   * diringkas. Gerbang yang berdiri paling depan justru yang tidak dijaga.
   */
  const projectedSize = (summary: string | undefined, tail: ModelMessage[]): number =>
    Math.max(measure(summary, tail), (projected ?? 0) - freedTokens())

  /**
   * Masih perlu tindakan yang MURAH (prune riwayat lama, lalu ringkas)?
   *
   * Memakai margin pertumbuhan: di sinilah F3 hidup — berhenti tepat di bibir
   * anggaran berarti langkah berikutnya meluap lagi.
   *
   * Dinilai atas SELURUH `current`, karena pada titik ini belum ada peringkasan:
   * permintaannya adalah ringkasan lama (kalau ada) plus semua baris di atas
   * batas air.
   */
  const needsMore = (): boolean =>
    overBudget(
      projectedSize(previous?.summary, current),
      input.contextWindow,
      compaction.reserved,
      growth,
    )

  /**
   * Sungguh-sungguh tidak MUAT — diukur terhadap JENDELA, bukan anggaran.
   *
   * Ini satu-satunya yang boleh membenarkan tindakan yang MAHAL: membuang isi
   * ekor, yaitu hasil tool yang baru saja diminta model. Karena itu ambangnya
   * paling tinggi dari ketiganya, dan sengaja melewati dua hal:
   *
   *   - margin pertumbuhan, karena ia spekulasi tentang langkah yang BELUM
   *     terjadi. Spekulasi boleh membeli pemadatan yang murah; ia tidak boleh
   *     membeli penghancuran sesuatu yang sudah ada dan masih muat.
   *   - `reserved`, karena itu kelapangan untuk jawaban, bukan dinding. Di
   *     bawah jendela permintaannya masih terlayani — sempit, tapi terlayani.
   *     Di ATAS jendela provider memotong diam-diam dan model menjawab yakin
   *     tentang bahan yang tidak pernah dilihatnya. Hanya yang kedua yang lebih
   *     buruk daripada kehilangan isi ekor.
   *
   * Terukur, dan inilah yang menentukan angkanya: satu berkas 22 KB pada
   * jendela 8192 menghasilkan ekor ~6.300 token — DI ATAS anggaran (6.144) tapi
   * DI BAWAH jendela. Diukur terhadap anggaran, berkas yang sebenarnya muat itu
   * ikut dibuang di setiap langkah dan model tidak pernah melihat isi berkas
   * yang ia baca sendiri; diukur terhadap jendela, ia sampai utuh.
   *
   * `summary` dan `tail` adalah keadaan SESUDAH peringkasan: ringkasan yang baru
   * (atau yang lama, kalau peringkasan tidak jadi) plus ekor yang dipertahankan.
   * Mengukur `current` utuh di sini akan menghitung dua kali bagian yang sudah
   * digantikan ringkasan.
   */
  const doesNotFit = (summary: string | undefined, tail: ModelMessage[]): boolean =>
    input.contextWindow !== undefined && projectedSize(summary, tail) >= input.contextWindow

  // `sparing: false` — di ekor tidak ada yang dikecualikan. Lihat komentar
  // `doesNotFit` di bawah: yang membenarkan langkah ini hanya ketidakmuatan yang
  // SUNGGUHAN, dan pada titik itu memotong diam-diam oleh provider lebih buruk
  // daripada kehilangan isi ekor — termasuk jawaban sub-agent.
  const pruneTail = (): void => {
    if (compaction.prune) prune(cut, current.length, false)
  }

  const done = (summarised: boolean): AutoCompactResult => ({
    ran: true,
    prunedBytes,
    summarised,
    changed: prunedBytes > 0 || summarised,
  })

  if (!needsMore()) return done(false)

  // Batas potong yang SAMA dengan yang dipakai prune — satu aturan, bukan dua.
  const plan = planAtCut(rows, cut)
  let summarised = false
  /** Ringkasan yang akan MENYERTAI permintaan berikutnya — lama sampai tergantikan. */
  let summary = previous?.summary

  if (plan.dropped.length > 0) {
    // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk — menumpuk
    // membuat ringkasan tumbuh tanpa batas, persis masalah yang mau dipecahkan.
    //
    // Dipecah per PESAN, bukan diserahkan sebagai satu string: itu satuan yang
    // `packChunks` pakai untuk memotong tanpa membelah sebuah pesan di tengah.
    const parts = [
      ...(previous ? [previous.summary] : []),
      ...plan.dropped.map((message) => renderMessage(message)),
    ]

    // Jendela PERINGKAS, bukan jendela model giliran: sejak `/compact` dan jalur
    // otomatis sama-sama memakai `smallModel`, jendela yang membatasi prompt
    // peringkas adalah milik model kecil itu. Kalau pemanggil tidak
    // menyatakannya, jendela model giliran dipakai — bukan tebakan, melainkan
    // angka yang toh sudah wajib ada agar pemadatan otomatis hidup sama sekali.
    const written = await summariseInChunks(
      input.summarise,
      parts,
      // `input.summariserWindow` SAJA — tanpa jaring ke `contextWindow` di sini.
      // Jaringnya milik `summariserWindowFor` di sisi pemanggil, karena hanya
      // pemanggil yang tahu model mana yang meringkas. Dua aturan untuk satu
      // keputusan adalah bentuk kesalahan yang sudah dua kali menghasilkan cacat
      // di siklus ini; `undefined` di sini berarti "jangan potong", dan itu satu
      // aturan yang dipegang `summariserChunkBytes`.
      summariserChunkBytes(input.summariserWindow, compaction.reserved),
      input.focus,
    )
    if (written.trim() !== "") {
      summary = wrapSummary(written)
      saveCompaction(sessionID, plan.watermark, summary)
      summarised = true
      // Byte yang dibebaskan peringkasan DI ATAS yang sudah dibebaskan prune.
      //
      // `current`, bukan `plan.dropped`. Keduanya adalah kepala yang sama, tapi
      // `plan.dropped` berasal dari `rows` — versi SEBELUM prune. Memakainya
      // menghitung byte yang sudah masuk `prunedBytes` untuk kedua kalinya, dan
      // `freedTokens()` menjumlahkan keduanya. Terukur: kepala 20 KB memberi
      // prunedBytes 19.929 DAN summaryFreed ~19.900, kreditnya ~9.957 token
      // melawan `projected` 7.000 — hasilnya negatif, `projectedSize` runtuh ke
      // pengukuran saja, dan sinyal provider yang ADA justru untuk menangkap
      // remehnya pengukuran itu ikut hilang. Ekor tidak pernah dipangkas walau
      // provider melaporkan luapan tujuh kali jendela.
      //
      // `plan.dropped` tetap benar untuk BAHAN peringkas di atas — di sana yang
      // dibutuhkan justru isi asli, bukan penanda hasil prune.
      //
      // Ringkasan diukur sebagaimana ia DIKIRIM, lewat `summaryPair`: ia berangkat
      // sebagai dua pesan JSON, bukan satu string telanjang. Mencampur byte string
      // dengan byte pesan adalah dua satuan dalam satu pengurangan.
      const sentBytes = (text: string): number =>
        summaryPair(text).reduce((total, message) => total + messageBytes(message), 0)
      const droppedBytes =
        current.slice(0, cut).reduce((total, message) => total + messageBytes(message), 0) +
        (previous ? sentBytes(previous.summary) : 0)
      summaryFreed = Math.max(0, droppedBytes - sentBytes(summary))
    }
  }

  // Upaya terakhir: pangkas hasil tool DI DALAM ekor juga.
  //
  // Ekor dipertahankan apa adanya justru supaya model bisa melanjutkan, tapi
  // satu hasil tool yang besar membuat ekor itu sendiri jadi penyebab luapan —
  // dan tidak ada pemotongan maupun peringkasan yang bisa menjangkaunya. Aman
  // dilakukan karena prune tidak pernah MENGHAPUS pesan: tidak ada hasil yang
  // jadi yatim, dan model bisa membaca ulang berkasnya.
  //
  // `doesNotFit`, bukan `needsMore`: setelah semua yang murah dijalankan, hanya
  // ketidakmuatan yang SUNGGUHAN boleh membuang isi ekor.
  //
  // Diukur atas keadaan yang SUNGGUH akan dikirim, dan itu bergantung pada
  // apakah peringkasan jadi:
  //
  //   - Jadi: ringkasan baru plus ekor. Baris sebelum `cut` sudah diwakili
  //     ringkasan itu, jadi menghitungnya lagi berarti membuang isi ekor karena
  //     beban yang sudah tidak ada.
  //   - TIDAK jadi (peringkas gagal atau dibatalkan — `summariseInChunks`
  //     memulangkan string kosong, bukan melempar): `saveCompaction` tidak
  //     dipanggil, batas air tidak maju, jadi permintaan berikutnya masih memuat
  //     SELURUH `current`. Mengukur ekor saja di sini meremehkannya, `pruneTail`
  //     — satu-satunya tuas yang masih tersisa — tidak pernah jalan, dan
  //     permintaan kebesaran berangkat untuk dipotong diam-diam provider.
  const willSend = (): ModelMessage[] => (summarised ? current.slice(cut) : current)

  // Peringkasan TIDAK jadi dan tetap tidak muat: perlindungan hasil sub-agent di
  // riwayat lama harus mengalah.
  //
  // Perlindungan itu (#4) bertumpu pada peringkas yang mewakili hasil `task`.
  // Kalau peringkasnya gagal, tidak ada yang mewakilinya, batas air tidak maju,
  // dan barisnya tetap dikirim — sementara `pruneTail` hanya menjangkau
  // [cut, akhir). Satu hasil task 22 KB di riwayat lama karena itu duduk di luar
  // jangkauan SEMUA tuas yang tersisa. Pada titik ini memotong diam-diam oleh
  // provider lebih buruk daripada kehilangan jawaban sub-agent — penilaian yang
  // sama dengan yang sudah dipakai `pruneTail` sendiri.
  if (!summarised && compaction.prune && cut > 0 && doesNotFit(summary, willSend())) {
    prune(0, cut, false)
  }

  if (doesNotFit(summary, willSend())) pruneTail()

  return done(summarised)
}
