import {
  COMPACT_SYSTEM,
  compactPrompt,
  estimateTokens,
  growthTokens,
  messageBytes,
  midTurnCut,
  overBudget,
  planAtCut,
  projectedContext,
  pruneToolOutputs,
  renderTranscript,
  tailStart,
  wrapSummary,
} from "./compact.ts"
import type { Compaction } from "./schema.ts"
import {
  latestCompaction,
  listModelRows,
  replaceModelMessage,
  saveCompaction,
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

  const prune = (from: number, upTo: number): void => {
    const result = pruneToolOutputs(current, upTo, from)
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

  // Estimasi HANYA untuk keputusan tingkat kedua ini. Pemicunya sendiri tetap
  // memakai angka yang dilaporkan provider, tidak pernah taksiran.
  //
  // Basisnya `projected`, BUKAN `lastStepTokens`: mengkreditkan byte yang
  // terbebas sambil tidak pernah mendebit hasil tool yang baru tiba membuat
  // jawabannya selalu "sudah muat" justru pada kasus yang paling tidak muat.
  const remaining = (freedBytes: number): number =>
    (projected ?? 0) - estimateTokens(freedBytes)

  /**
   * Masih perlu tindakan yang MURAH (prune riwayat lama, lalu ringkas)?
   *
   * Memakai margin pertumbuhan: di sinilah F3 hidup — berhenti tepat di bibir
   * anggaran berarti langkah berikutnya meluap lagi.
   */
  const needsMore = (freedBytes: number): boolean =>
    overBudget(remaining(freedBytes), input.contextWindow, compaction.reserved, growth)

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
   */
  const doesNotFit = (freedBytes: number): boolean =>
    input.contextWindow !== undefined && remaining(freedBytes) >= input.contextWindow

  /** Ukuran ekor apa adanya — yang akan dikirim utuh, berapa pun besarnya. */
  const tailTokens = (): number =>
    growthTokens(current.slice(cut).reduce((sum, message) => sum + messageBytes(message), 0))

  const pruneTail = (): void => {
    if (compaction.prune) prune(cut, current.length)
  }

  const done = (summarised: boolean): AutoCompactResult => ({
    ran: true,
    prunedBytes,
    summarised,
    changed: prunedBytes > 0 || summarised,
  })

  // Ekor yang SENDIRIAN saja sudah mengisi jendela tidak bisa ditolong
  // peringkasan: ringkasan sependek apa pun tetap ditempelkan DI ATAS ekor itu.
  // Memangkasnya sebelum memanggil peringkas bukan pelanggaran urutan "yang
  // murah dulu" — ia menghindari satu panggilan model yang sudah pasti sia-sia.
  // Peringkasan hanya bisa membebaskan bagian SEBELUM potong; kalau bagian
  // sesudahnya saja sudah sebesar jendela, tidak ada yang tersisa untuk
  // ditolong.
  if (input.contextWindow !== undefined && tailTokens() >= input.contextWindow) pruneTail()

  if (!needsMore(prunedBytes)) return done(false)

  // Batas potong yang SAMA dengan yang dipakai prune — satu aturan, bukan dua.
  const plan = planAtCut(rows, cut)
  let summarised = false
  let summaryFreed = 0

  if (plan.dropped.length > 0) {
    // Ringkasan sebelumnya ikut diringkas ulang, bukan ditumpuk — menumpuk
    // membuat ringkasan tumbuh tanpa batas, persis masalah yang mau dipecahkan.
    const droppedText = renderTranscript(plan.dropped)
    const source = previous ? `${previous.summary}\n\n${droppedText}` : droppedText

    const summary = await input.summarise(COMPACT_SYSTEM, compactPrompt(source, input.focus))
    if (summary.trim() !== "") {
      saveCompaction(sessionID, plan.watermark, wrapSummary(summary))
      summarised = true
      summaryFreed = Math.max(
        0,
        Buffer.byteLength(droppedText) - Buffer.byteLength(wrapSummary(summary)),
      )
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
  if (doesNotFit(prunedBytes + summaryFreed)) pruneTail()

  return done(summarised)
}
