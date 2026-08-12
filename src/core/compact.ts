import type { ModelMessage } from "ai"
import type { ModelRow } from "./storage/session.ts"
import type { Config } from "./schema.ts"

/**
 * Manajemen konteks: memadatkan percakapan yang sudah panjang menjadi ringkasan,
 * supaya giliran berikutnya tidak melewati jendela konteks model.
 *
 * Jendela yang terlampaui adalah penyebab halusinasi yang paling senyap. Provider
 * tidak menolak permintaannya — mereka MEMOTONG bagian paling awal, dan model
 * lalu menjawab dengan percaya diri tentang keputusan yang sudah tidak dilihatnya.
 * ollama bahkan memotong di `num_ctx` 4096 tanpa satu pun peringatan.
 */

/**
 * Berapa GILIRAN user terakhir yang tetap dikirim apa adanya.
 *
 * Dihitung dalam giliran, bukan pesan: satu giliran agentic bisa berisi dua
 * puluh pesan, jadi "4 pesan terakhir" bisa berarti empat hasil tool dari
 * tengah giliran — instruksinya sudah hilang, dan tidak satu pun pertukaran
 * tersisa utuh. Giliran adalah satuan yang bisa dibayangkan user.
 */
export const KEEP_TURNS = 2

/**
 * Batas potong: indeks pesan pertama yang dipertahankan.
 *
 * Wajib jatuh di pesan `user`. Memotong di tengah pasangan tool-call/tool-result
 * meninggalkan tool-result yatim di awal riwayat, dan provider menolak itu
 * dengan error yang tidak menyebut pemadatan sama sekali.
 */
export function tailStart(messages: ModelMessage[], keepTurns = KEEP_TURNS): number {
  // keepTurns <= 0 berarti TIDAK ADA giliran yang disisakan — ringkas semuanya,
  // jadi kembalikan panjang penuh. Ini KEBALIKAN dari fallback `return 0` di
  // bawah: keduanya angka "batas", tapi 0 di sana berarti giliran yang ADA
  // lebih sedikit dari yang diminta, jadi justru pertahankan semuanya apa
  // adanya. Sama-sama "tidak ada yang dipotong di tengah", tapi satu berarti
  // ringkas total, satu berarti simpan total.
  if (keepTurns <= 0) return messages.length

  let seen = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue
    seen += 1
    if (seen === keepTurns) return index
  }
  // Giliran yang ada lebih sedikit dari yang diminta — pertahankan semuanya.
  return 0
}

/**
 * Rasio byte→token, satu-satunya di berkas ini.
 *
 * Empat byte per token adalah angka teks nyata. Dipakai tiga tempat: ukuran ekor
 * mid-turn, margin pertumbuhan satu langkah, dan pengukuran permintaan
 * (`requestTokens`). Ketiganya BATAS atau UKURAN, bukan penghematan yang
 * ditaksir, jadi satu penggaris sudah cukup.
 *
 * Dulu ada penggaris kedua, 8 byte/token, khusus untuk menaksir penghematan
 * prune supaya keputusan "masih perlu diringkas?" condong ke arah meringkas.
 * Asimetri itu hilang bersama alasannya: penghematan tidak lagi ditaksir sama
 * sekali — permintaan yang akan dikirim diukur langsung. Menaksir dua arah
 * dengan dua penggaris adalah satu perbandingan dengan dua satuan, dan itu
 * kesalahan yang lebih halus daripada rasio yang keliru.
 */
export const REAL_BYTES_PER_TOKEN = 4

/** Taksiran token yang sengaja tidak meremehkan — lihat `REAL_BYTES_PER_TOKEN`. */
export function growthTokens(bytes: number): number {
  return Math.ceil(bytes / REAL_BYTES_PER_TOKEN)
}

/** Ukuran satu pesan seperti yang benar-benar dikirim, dalam byte JSON. */
export function messageBytes(message: ModelMessage): number {
  return Buffer.byteLength(JSON.stringify(message))
}

/**
 * Ukuran permintaan yang AKAN dikirim, diukur langsung dari pesannya.
 *
 * Menggantikan aritmetika di atas angka provider yang basi: dulu keputusan
 * "prune saja cukup?" mengambil `inputTokens` yang dilaporkan untuk permintaan
 * LAIN satu langkah sebelumnya, lalu menguranginya dengan taksiran byte yang
 * dibebaskan prune. Taksiran itu tidak mungkin benar, dan salahnya ke arah yang
 * membakar kuota: terukur, pada hasil 28 KB dengan jendela 8192, permintaan yang
 * sungguh akan dikirim hanya 490 token — 6% jendela — sementara peringkas tetap
 * menyala di 29 dari 30 langkah.
 *
 * Yang membuat ini benar bukan rasionya, melainkan bahwa objeknya nyata:
 * pesan-pesan ini persis yang akan berangkat. `extraBytes` untuk bagian yang
 * TIDAK ada di daftar pesan tapi tetap ikut terkirim — system prompt. Tanpanya
 * pengukuran ini meremehkan permintaan, dan meremehkan ukuran permintaan berarti
 * mengirim yang kebesaran: arah kesalahan yang paling mahal dari semuanya.
 *
 * Dua hal yang MASIH tidak terlihat, disebut di sini supaya tidak disangka
 * lengkap — dan yang kedua lebih besar daripada yang pernah tertulis:
 *
 *   - **Definisi tool.** Skema tool ikut dikirim tiap permintaan tapi tidak ada
 *     di daftar pesan maupun di system prompt, dan merakit ulang skema JSON-nya
 *     di sini berarti menebak bentuk yang dihasilkan AI SDK. Besarnya tetap:
 *     beberapa ratus token.
 *   - **Variasi tokenisasi.** Empat byte per token adalah angka TEKS NYATA. Isi
 *     yang padat token — kode, CJK, base64 — bisa mendarat di 2–3 byte per
 *     token, jadi pengukuran ini bisa meremehkan 30–50%, bukan "beberapa ratus
 *     token" seperti yang pernah tertulis di sini. Itu koreksi, bukan nuansa.
 *
 * Yang menahan keduanya adalah `reserved`: ia kelapangan di ATAS anggaran, jadi
 * remeh sampai sekitar sepertiga terserap tanpa permintaan mana pun melewati
 * jendela. Di atas itu ia bisa melewati jendela, dan satu-satunya pemulihnya
 * adalah pemicu — yang membaca angka provider SUNGGUHAN, termasuk definisi tool —
 * menyala lagi di langkah berikutnya. Pengganti yang benar adalah menghitung token
 * lewat tokenizer provider alih-alih rasio; itu belum ada di Titah, dan sampai ada,
 * batas ini nyata.
 */
export function requestTokens(messages: ModelMessage[], extraBytes = 0): number {
  let bytes = extraBytes
  for (const message of messages) bytes += messageBytes(message)
  return growthTokens(bytes)
}

/** Penanda yang menggantikan output tool yang dibuang. */
const PRUNED = "[output was dropped to free context — re-run the tool if you need it]"

/**
 * Penanda untuk hasil tool yang MAHAL dipulihkan.
 *
 * Sengaja menyebut ongkosnya, bukan sekadar menyuruh menjalankan ulang: nasihat
 * "re-run the tool" benar untuk `read`, dan menyesatkan untuk jawaban sub-agent
 * yang harganya satu giliran bersarang penuh. Model tidak punya cara lain
 * mengetahui bedanya.
 */
const PRUNED_EXPENSIVE =
  "[a sub-agent's answer was dropped to free context — recovering it means dispatching that sub-agent again, a full nested turn]"

/**
 * Tool yang hasilnya TIDAK dibuang oleh prune biasa.
 *
 * Yang membedakan bukan ukuran output, melainkan harga memulihkannya. Komentar
 * WHY pruner ini menyebut alasan rancangannya: risikonya model membaca ulang
 * berkas, dan itu bisa dipulihkan. Alasan itu TIDAK berlaku untuk `task` —
 * memulihkannya berarti model call sendiri, tool call sendiri, mungkin CLI
 * eksternal terdelegasi. Sebelum ini pruner tidak pernah melihat `toolName`
 * sama sekali, jadi bedanya tidak tertulis di mana pun.
 */
export const EXPENSIVE_TOOLS: ReadonlySet<string> = new Set(["task"])

/**
 * Ukuran sebuah penanda, dalam byte JSON — sebagaimana ia benar-benar tersimpan.
 *
 * Dipakai sebagai ambang: mengganti output yang SUDAH lebih kecil atau sama
 * dengan penanda tidak menghemat apa pun — riwayatnya bisa saja malah membesar.
 * `bytesFreed` harus berarti "byte yang SUNGGUH terhemat", bukan "byte yang
 * dibuang". Melebih-lebihkannya membuat pemanggil mengira sudah cukup meringan
 * padahal belum, dan melewatkan peringkasan yang justru dibutuhkan.
 *
 * Per penanda, bukan satu angka untuk semuanya: penanda mahal lebih panjang,
 * dan memakai ukuran penanda pendek untuknya akan melebih-lebihkan penghematan
 * — persis arah kesalahan yang dilarang di atas. Ini juga yang menjaga
 * idempotensi: output yang sudah berisi penanda punya ukuran yang sama persis
 * dengan penandanya sendiri, jadi ia terlewati alih-alih dihitung ulang.
 */
function markerBytes(marker: string): number {
  return Buffer.byteLength(JSON.stringify({ type: "text", value: marker }))
}

/**
 * Membuang output hasil tool di rentang `[from, upTo)`, tanpa menghapus satu
 * pesan pun.
 *
 * Pesan `tool` yang dihapus akan meninggalkan tool-call tanpa hasilnya, dan
 * provider menolak riwayat semacam itu. Karena itu yang diganti hanya ISI-nya.
 *
 * Ini mekanisme yang murah: tidak ada panggilan model sama sekali, sementara di
 * giliran agentic output tool memang bagian terbesar konteks. Risikonya model
 * membaca ulang berkas — itu bisa dipulihkan, beda dari ringkasan yang
 * diam-diam menjatuhkan sebuah keputusan.
 *
 * `from` ada karena ekor pun kadang harus dipangkas sebagai upaya terakhir:
 * satu hasil tool yang lebih besar dari seluruh anggaran tidak bisa ditolong
 * oleh pemotongan mana pun, dan karena prune tidak pernah MENGHAPUS pesan, ia
 * tetap aman dilakukan di dalam ekor.
 *
 * `sparing` memisahkan dua situasi yang ongkosnya berbeda:
 *
 *   - `true` (prune biasa, riwayat lama) — hasil `EXPENSIVE_TOOLS` dilewati.
 *     Peringkas yang menanganinya: ringkasan sebuah jawaban sub-agent lossy,
 *     tapi tidak destruktif.
 *   - `false` (upaya terakhir di ekor) — tidak ada yang dilewati. Mengecualikan
 *     `task` di sini justru mengembalikan bahaya aslinya: permintaan tetap
 *     kebesaran, provider memotong diam-diam, dan model menjawab yakin tentang
 *     bahan yang tidak pernah dilihatnya. Kehilangan isi ekor kerugian yang
 *     lebih kecil — tapi penandanya menyebut harganya.
 */
export function pruneToolOutputs(
  messages: ModelMessage[],
  upTo: number,
  from = 0,
  sparing = true,
): { messages: ModelMessage[]; bytesFreed: number } {
  let bytesFreed = 0

  const out = messages.map((message, index) => {
    if (index < from || index >= upTo) return message
    if (message.role !== "tool" || typeof message.content === "string") return message

    const parts = message.content as { type: string; [key: string]: unknown }[]
    let changed = false
    const next = parts.map((part) => {
      if (part["type"] !== "tool-result") return part
      const expensive = EXPENSIVE_TOOLS.has(String(part["toolName"] ?? ""))
      if (expensive && sparing) return part
      const marker = expensive ? PRUNED_EXPENSIVE : PRUNED
      const size = markerBytes(marker)
      const output = part["output"]
      const rendered = JSON.stringify(output ?? "")
      const removed = Buffer.byteLength(rendered)
      // Output yang sudah <= ukuran penanda TIDAK disentuh: mengganti output
      // sebesar ini tidak membebaskan apa pun (kasus sudah-dipangkas termasuk
      // di sini, karena rendernya sama persis dengan penanda). Satu giliran
      // penuh hasil edit/confirm pendek adalah kasus nyata di mana ini terjadi
      // pada SEMUA bagiannya sekaligus, bukan pengecualian langka.
      if (removed <= size) return part
      bytesFreed += removed - size
      changed = true
      return { ...part, output: { type: "text", value: marker } }
    })

    return changed ? ({ ...message, content: next } as ModelMessage) : message
  })

  return { messages: out, bytesFreed }
}

/**
 * Batas ATAS jumlah pesan yang dipertahankan saat memadatkan DI TENGAH giliran.
 *
 * Bukan giliran, karena di tengah giliran tidak ada batas giliran untuk
 * dihitung. Enam cukup untuk menyisakan beberapa hasil tool terakhir, yang
 * biasanya persis yang sedang dipakai model untuk memutuskan langkah berikutnya.
 *
 * Ini SEKADAR batas atas, bukan target: ekor kecil tidak boleh tumbuh jadi enam
 * hanya karena murah. Batas sesungguhnya adalah ukuran — lihat `TAIL_FRACTION`.
 */
export const MID_TURN_KEEP = 6

/**
 * Bagian anggaran yang paling banyak boleh ditempati EKOR mid-turn: seperempat.
 *
 * Menghitung ekor dalam PESAN saja tidak membatasi apa pun, karena satu pesan
 * bisa berisi hasil `read` 22 KB. Terukur: satu berkas 22 KB dibaca berulang
 * pada jendela 8192 membuat konteks yang dikirim memuncak di 19.407 token —
 * 2,4x jendelanya — dan bertahan di sana sepanjang giliran, karena ekor enam
 * pesan itu sendiri sudah lebih besar dari seluruh jendela. Prune tidak
 * menjangkaunya (potongnya nol) dan peringkas tidak menyentuhnya (ia memang
 * dipertahankan apa adanya), jadi setiap panggilan smallModel sesudahnya
 * membakar kuota tanpa mengubah apa pun.
 *
 * Seperempat, sama dengan `RESERVE_FRACTION`: sisanya (tiga perempat) harus
 * memuat ringkasan, system prompt, DAN pertumbuhan langkah berikutnya. Ekor
 * yang boleh menelan setengah anggaran membuat pemadatan cuma memindahkan
 * masalahnya satu langkah ke depan. Angkanya sengaja sama supaya user yang
 * membaca salah satunya tidak perlu menghafal dua bentuk yang berbeda.
 */
export const TAIL_FRACTION = 4

/** Anggaran konteks yang benar-benar boleh dipakai, dalam token. */
export function budgetTokens(contextWindow: number, reserved: number): number {
  return contextWindow - effectiveReserved(contextWindow, reserved)
}

/** Ukuran maksimum ekor mid-turn, dalam byte — lihat `TAIL_FRACTION`. */
export function tailBudgetBytes(contextWindow: number, reserved: number): number {
  const tokens = Math.floor(budgetTokens(contextWindow, reserved) / TAIL_FRACTION)
  return Math.max(0, tokens) * REAL_BYTES_PER_TOKEN
}

/**
 * Batas potong untuk pemadatan di tengah giliran.
 *
 * Dua batas sekaligus, dan yang lebih ketat menang: paling banyak
 * `keepMessages` pesan, DAN paling banyak `budgetBytes` byte. Satu pesan
 * terakhir SELALU dipertahankan berapa pun besarnya — tanpanya model tidak
 * punya apa pun untuk melanjutkan, dan hasil tool yang kebesaran itu toh masih
 * bisa dipangkas isinya belakangan (`pruneToolOutputs` dengan `from`).
 *
 * Aturan lama tetap berlaku: JANGAN memotong di pesan `tool`. Pesan itu memuat
 * hasil dari tool-call di pesan sebelumnya; memotong di situ meninggalkan hasil
 * tanpa panggilannya, dan provider menolak riwayat seperti itu dengan error
 * yang tidak menyebut pemadatan sama sekali. Memotong di pesan `assistant` yang
 * berisi tool-call justru aman, karena hasilnya menyusul dan ikut disimpan.
 *
 * Selalu MUNDUR ke indeks aman, tidak pernah maju: maju berarti membuang lebih
 * banyak dari yang diminta.
 */
export function midTurnCut(
  messages: ModelMessage[],
  keepMessages: number,
  budgetBytes = Number.POSITIVE_INFINITY,
): number {
  let cut = messages.length
  let bytes = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const kept = messages.length - index
    if (kept > keepMessages) break
    bytes += messageBytes(messages[index] as ModelMessage)
    // `kept > 1`: pesan pertama lolos tanpa diukur, itulah jaminan
    // "selalu sisakan satu".
    if (kept > 1 && bytes > budgetBytes) break
    cut = index
  }

  while (cut > 0 && messages[cut]?.role === "tool") cut -= 1
  return cut
}

export interface CompactionPlan {
  /** Pesan yang akan diringkas. Kosong berarti tidak ada yang perlu dipadatkan. */
  dropped: ModelMessage[]
  /** seq terakhir yang diwakili ringkasan, untuk disimpan sebagai batas air. */
  watermark: number
  /** Berapa pesan yang tetap dikirim apa adanya. */
  kept: number
}

/**
 * `planCompaction` dengan batas potong yang sudah ditentukan pemanggil.
 *
 * Dipakai jalur mid-turn, yang batas amannya dihitung `midTurnCut` dan bukan
 * dari giliran user. Aturan batas air hidup DI SINI SAJA — dua salinan akan
 * menandai titik berbeda sebagai "sudah diringkas", dan sebagian riwayat lalu
 * terkirim dua kali atau hilang sama sekali.
 */
export function planAtCut(rows: ModelRow[], cut: number): CompactionPlan {
  const dropped = rows.slice(0, cut).map((row) => row.message)
  // Batas air = seq terakhir yang diringkas. Kalau semuanya diringkas, itu seq
  // baris terakhir; kalau tidak, satu di bawah baris pertama yang dipertahankan.
  const firstKept = rows[cut]
  const lastRow = rows.at(-1)
  const watermark = firstKept ? firstKept.seq - 1 : (lastRow?.seq ?? -1)
  return { dropped, watermark, kept: rows.length - cut }
}

/**
 * Menyusun rencana pemadatan dari baris yang BELUM dipadatkan.
 *
 * `rows` harus sudah disaring ke atas batas air sebelumnya, sehingga pemadatan
 * berulang tidak pernah meringkas dua kali hal yang sama.
 */
export function planCompaction(rows: ModelRow[], keepTurns = KEEP_TURNS): CompactionPlan {
  const messages = rows.map((row) => row.message)
  return planAtCut(rows, tailStart(messages, keepTurns))
}

/** Menjadikan satu pesan model teks datar yang bisa dibaca peringkas. */
export function renderMessage(message: ModelMessage): string {
  const { role, content } = message
  if (typeof content === "string") return `${role}: ${content}`

  const parts: string[] = []
  for (const part of content as { type: string; [key: string]: unknown }[]) {
    if (part["type"] === "text") parts.push(String(part["text"]))
    else if (part["type"] === "tool-call") {
      parts.push(`[calls ${String(part["toolName"])} ${JSON.stringify(part["input"] ?? {})}]`)
    } else if (part["type"] === "tool-result") {
      const output = JSON.stringify(part["output"] ?? "")
      parts.push(`[result of ${String(part["toolName"])}: ${output.slice(0, 400)}]`)
    } else if (part["type"] === "reasoning") {
      // Penalaran sengaja dibuang: ia panjang, dan ia PROSES menuju keputusan,
      // bukan keputusannya. Meringkasnya membuang ruang untuk fakta.
      continue
    }
  }
  return `${role}: ${parts.join("\n")}`
}

export function renderTranscript(messages: ModelMessage[]): string {
  return messages.map(renderMessage).join("\n\n")
}

/**
 * Instruksi peringkas.
 *
 * Ditulis seluruhnya seputar satu kegagalan: ringkasan yang mengarang. Ringkasan
 * yang meleset lebih berbahaya daripada tidak ada ringkasan, karena ia terbaca
 * sebagai catatan yang sudah disepakati dan model tidak punya cara memeriksanya.
 */
export const COMPACT_SYSTEM = [
  "You compress a coding session's history into a briefing for the same assistant to continue from.",
  "",
  "Rules, in order of importance:",
  "1. Never invent. Every file path, command, identifier, number, and decision must appear in the transcript. If you are unsure whether something was decided, write that it is unresolved.",
  "2. Copy identifiers verbatim — file paths, function names, flags, error messages, versions. Do not normalise, translate, or tidy them.",
  "3. Preserve what constrains future work: decisions and the reasoning behind them, constraints the user stated, things that were tried and failed and why, and anything the user explicitly asked for or refused.",
  "4. Drop what is reconstructible: tool output that can be re-read, exploration that led nowhere, restatements.",
  "5. A <skill name=\"…\"> block is loaded instructions, not conversation. Record which skills were loaded and any decision made because of them — never copy the skill text itself.",
  "6. Record unfinished work explicitly, including what the next step was.",
  "",
  "Write it under these headings, omitting any that have no content:",
  "  Goal · Decisions · Constraints · Files touched · Done · Not done · Open questions",
  "",
  "Write plain prose and short lists. No preamble, no closing remarks, no offer to help.",
].join("\n")

export function compactPrompt(transcript: string, focus?: string): string {
  const instruction = focus?.trim()
    ? `\n\nThe user asked you to pay particular attention to: ${focus.trim()}\nKeep that material in full detail. Summarise the rest normally — do not drop it.`
    : ""
  return `Here is the session transcript to compress.\n\n<transcript>\n${transcript}\n</transcript>${instruction}`
}

/**
 * Penanda pemotongan yang EKSPLISIT.
 *
 * Satu pesan yang sendirian lebih besar dari jendela peringkas tetap harus
 * dipotong — bedanya, dipotong di sini dan diberi tahu, bukan dipotong provider
 * tanpa jejak. Itu seluruh perbedaan antara "ada yang hilang, dan model tahu"
 * dengan "ada yang hilang, dan model menjawab yakin seolah tidak".
 */
const TRUNCATED = "\n[… this part of the transcript was truncated to fit the summariser's window …]"

/**
 * Anggaran satu potongan transkrip untuk peringkas, dalam byte.
 *
 * Dikurangi instruksi peringkas dan teks pembungkus `compactPrompt`: keduanya
 * ikut memakan jendela yang sama dengan transkripnya. Anggaran yang mengabaikan
 * itu tetap meluap, dan itu versi naif dari perbaikan ini.
 *
 * Lantai `MIN_CHUNK_BYTES` bukan kehati-hatian: potongan nol atau negatif berarti
 * pemotongan tidak pernah maju, dan giliran menggantung selamanya di jalur yang
 * user tidak pernah minta. Kalau jendelanya sungguh lebih kecil dari instruksinya
 * sendiri, tidak ada anggaran yang bisa menolong — yang bisa dilakukan hanyalah
 * memotong sekecil mungkin dan tetap bergerak.
 */
const MIN_CHUNK_BYTES = 512

/**
 * Jendela yang TIDAK diketahui berarti jangan memotong sama sekali.
 *
 * Aturan yang sama yang sudah berlaku di `contextWindowFor`: batas yang tidak
 * dideklarasikan berarti MATI, bukan ditebak. Untuk pemotongan, "mati" berarti
 * satu panggilan seperti sebelum pemotongan ada.
 *
 * Versi pertama memulangkan `0` untuk kasus ini, dan `0` melewati aritmetika di
 * bawah menjadi angka negatif yang lalu dijinakkan lantai jadi 512 byte —
 * potongan TERKECIL yang mungkin, bukan tidak memotong. Terukur akibatnya di
 * jalur `/compact`: transkrip 200 KB jadi ~400 panggilan smallModel berurutan,
 * pada konfigurasi yang memang didukung (doctor hanya memperingatkan), padahal
 * sebelum pemotongan ada ia satu panggilan.
 */
export function summariserChunkBytes(contextWindow: number | undefined, reserved: number): number {
  if (contextWindow === undefined) return Number.POSITIVE_INFINITY
  return budgetTokens(contextWindow, reserved) * REAL_BYTES_PER_TOKEN
}

/**
 * Bagian anggaran prompt yang paling banyak boleh diambil teks FOKUS: seperempat,
 * angka yang sama dengan `RESERVE_FRACTION` dan `TAIL_FRACTION`.
 *
 * `focus` adalah teks prompt user apa adanya (`focus: text` di agent.ts), jadi ia
 * tidak dibatasi apa pun — dan `compactPrompt` menempelkannya ke SETIAP potongan.
 * Terukur sebelum batas ini ada: anggaran potongan 11.047 byte, prompt nyata
 * 42.515 byte ≈ 10.629 token pada jendela 4096 — 2,6x, dan transkripnya duduk di
 * DEPAN prompt, jadi yang dipotong provider justru bahan yang sedang diringkas.
 * Batas issue #1 dikalahkan oleh satu paste berkas sebagai prompt.
 *
 * Dipotong, bukan dibuang: fokus tetap menajamkan ringkasan, ia cuma tidak lagi
 * boleh menelan jendela yang seharusnya memuat transkripnya.
 */
export const FOCUS_FRACTION = 4

/**
 * Berapa kali paling banyak "ringkas ringkasannya" boleh berulang.
 *
 * Rekursinya hanya menyelesaikan sesuatu kalau hasilnya MENYUSUT. Peringkas yang
 * membalas sepanjang bahannya adalah kejadian nyata pada model kecil yang
 * bingung, dan tanpa batas ini giliran menggantung — di jalur yang user tidak
 * pernah minta, jadi ia bahkan tidak akan tahu harus menekan Esc.
 */
const MAX_CHUNK_ROUNDS = 3

/**
 * Memotong teks ke `limit` BYTE, tanpa membelah karakter multibyte.
 *
 * `String.prototype.slice` memotong per code unit UTF-16, dan seluruh anggaran di
 * berkas ini dalam byte. Terukur pada versi yang memakai `slice`: satu bagian
 * 2.000 karakter CJK dengan anggaran 1.000 byte menghasilkan potongan 2.834 byte
 * — 2,8x. Untuk transkrip non-ASCII prompt peringkas jadi tetap melewati
 * jendelanya, yaitu luapan yang justru mau dicegah.
 *
 * Karakter yang terbelah di ujung didekode `TextDecoder` menjadi U+FFFD; itu
 * dibuang, bukan dibiarkan masuk ke prompt sebagai sampah.
 */
export function sliceBytes(text: string, limit: number): string {
  if (limit <= 0) return ""
  if (Buffer.byteLength(text) <= limit) return text
  let out = new TextDecoder().decode(Buffer.from(text, "utf8").subarray(0, limit))
  while (out.endsWith("�")) out = out.slice(0, -1)
  return out
}

/** Memaketkan bagian transkrip jadi potongan yang tiap potongnya muat. */
export function packChunks(parts: string[], chunkBytes: number): string[] {
  const limit = Math.max(MIN_CHUNK_BYTES, chunkBytes)
  const chunks: string[] = []
  let current: string[] = []
  let bytes = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(current.join("\n\n"))
    current = []
    bytes = 0
  }

  for (const part of parts) {
    const size = Buffer.byteLength(part)
    // Satu bagian yang sendirian tidak muat: ia potongannya sendiri, dipotong
    // eksplisit. Memaksanya berbagi potongan dengan bagian lain cuma membuat
    // keduanya terpotong.
    if (size > limit) {
      flush()
      chunks.push(sliceBytes(part, limit - Buffer.byteLength(TRUNCATED)) + TRUNCATED)
      continue
    }
    if (bytes > 0 && bytes + size > limit) flush()
    current.push(part)
    bytes += size
  }
  flush()
  return chunks
}

/**
 * Meringkas transkrip yang mungkin JAUH lebih besar dari jendela peringkas.
 *
 * Ini perbaikan issue #1, dan satu-satunya pintu masuk ke peringkas: `/compact`
 * maupun jalur otomatis melewati fungsi yang sama, supaya keduanya tidak bisa
 * berbeda perilaku. Sebelum ini prompt peringkas tidak dibatasi apa pun —
 * terukur 78.964 token pada smallModel yang menyatakan jendela 4096, dan
 * provider tidak menolaknya melainkan memotong bagian paling awal, lalu
 * peringkas menulis ringkasan yang yakin tentang bahan yang tidak dilihatnya.
 *
 * Panggilan dibuat BERURUTAN, bukan paralel: paralel menggandakan beban model
 * kecil sekaligus membuat pembatalan lewat Esc lebih sulit dihormati, dan tidak
 * ada urutan yang bisa dipercepat di sini — hasilnya toh disatukan.
 *
 * `focus` dipasang di panggilan TERAKHIR juga, bukan cuma per potongan: yang
 * dibaca model adalah ringkasan akhir, dan fokus yang hanya hidup di potongan
 * bisa hilang justru saat ringkasan-ringkasan itu diringkas lagi.
 */
export async function summariseInChunks(
  summarise: (system: string, prompt: string) => Promise<string>,
  parts: string[],
  promptBytes: number,
  focus?: string,
  round = 0,
): Promise<string> {
  // Seluruh aritmetika batas hidup DI SINI, bukan dibagi dengan pemanggil.
  // `promptBytes` adalah anggaran SELURUH prompt — instruksi, pembungkus, fokus,
  // dan transkripnya — karena itulah yang dilihat provider. Pemanggil yang
  // menghitung sebagian sendiri adalah bagaimana teks fokus bisa lolos dari
  // hitungan sama sekali.
  const trimmedFocus =
    focus === undefined ? undefined : sliceBytes(focus, Math.floor(promptBytes / FOCUS_FRACTION))
  const overhead =
    Buffer.byteLength(COMPACT_SYSTEM) + Buffer.byteLength(compactPrompt("", trimmedFocus))
  const chunkBytes = Math.max(MIN_CHUNK_BYTES, promptBytes - overhead)

  const chunks = packChunks(parts, chunkBytes)
  if (chunks.length === 0) return ""
  if (chunks.length === 1) {
    return summarise(COMPACT_SYSTEM, compactPrompt(chunks[0] as string, trimmedFocus))
  }

  const summaries: string[] = []
  for (const chunk of chunks) {
    const written = await summarise(COMPACT_SYSTEM, compactPrompt(chunk, trimmedFocus))
    // SATU potongan kosong menghentikan semuanya, dan mengembalikan kosong.
    //
    // Dua alasan, dan keduanya menolak "lewati saja yang gagal":
    //
    //   - Melewatinya berarti ringkasan yang diam-diam kehilangan satu bagian
    //     transkrip, lalu disimpan seolah utuh. Itu PERSIS kegagalan yang
    //     seluruh fitur ini ada untuk mencegah — ringkasan yang yakin tentang
    //     bahan yang tidak pernah dilihatnya. Kosong jauh lebih baik: pemanggil
    //     membiarkan riwayat lama apa adanya.
    //   - `synthesizerFor` mengembalikan string kosong, bukan melempar, ketika
    //     model gagal ATAU dibatalkan (streamText meneruskan error ke `onError`).
    //     Melanjutkan sesudah pembatalan berarti memanggil model dengan signal
    //     yang SUDAH abort — dan pendengar `abort` di sana tidak akan menyala
    //     lagi, jadi panggilan itu menggantung selamanya. Terukur: satu giliran
    //     tergantung 20 detik sampai test-nya menyerah, di jalur yang user tidak
    //     pernah minta.
    if (written.trim() === "") return ""
    summaries.push(written)
  }

  if (round + 1 >= MAX_CHUNK_ROUNDS) {
    // Batas kedalaman tercapai: satukan SEMUA ringkasan, lalu potong ke anggaran
    // dengan penanda kalau memang harus memotong.
    //
    // Versi pertama mengambil `packChunks(...)[0]` — potongan PERTAMA — dan
    // menjatuhkan sisanya. Terukur: bahan 15.908 byte jadi ringkasan 506 byte,
    // tanpa satu pun penanda, lalu disimpan sementara batas air maju. Sekitar
    // 97% riwayat hilang permanen, senyap — persis kegagalan yang seluruh berkas
    // ini ada untuk mencegah, dan komentarnya sendiri menjanjikan "dipotong
    // eksplisit" yang tidak pernah terjadi.
    //
    // Dibatasi anggaran, bukan dibiarkan sepanjang apa adanya: ringkasan ini
    // ikut di SETIAP permintaan berikutnya, jadi ringkasan yang tidak dibatasi
    // adalah masalah konteks yang kedua.
    const joined = summaries.join("\n\n")
    if (Buffer.byteLength(joined) <= chunkBytes) return joined
    return sliceBytes(joined, chunkBytes - Buffer.byteLength(TRUNCATED)) + TRUNCATED
  }
  return summariseInChunks(summarise, summaries, promptBytes, trimmedFocus, round + 1)
}

/** Membungkus ringkasan supaya model tahu ini catatan, bukan ucapan user. */
export function wrapSummary(summary: string): string {
  return [
    "<context-summary>",
    "This is a compacted summary of the earlier part of this session, not a new request.",
    "Treat it as the record of what happened. If something you need is not in it, say so and ask — do not assume.",
    "",
    summary.trim(),
    "</context-summary>",
  ].join("\n")
}

/**
 * Berapa bagian jendela yang paling banyak boleh diambil `reserved`.
 *
 * Tanpa lantai ini, `reserved` bawaan (8192) sama besar dengan jendela model
 * 8k, ambangnya jadi nol, dan pemadatan menyala di TIAP giliran walau
 * konteksnya cuma dua belas token — terukur. Model 8k lokal itu setelan yang
 * umum, jadi tabrakannya milik Titah, bukan salah setelan user.
 */
export const RESERVE_FRACTION = 4

/**
 * `reserved` yang benar-benar dipakai: tidak pernah lebih dari seperempat
 * jendela.
 *
 * Ini batas ATAS, bukan bawah — `reserved: 0` tetap nol, karena user yang
 * menyetelnya nol memang minta pemadatan sedekat mungkin ke batas jendela.
 */
export function effectiveReserved(contextWindow: number, reserved: number): number {
  return Math.min(reserved, Math.floor(contextWindow / RESERVE_FRACTION))
}

/**
 * Batas atas margin pertumbuhan: seperempat anggaran, angka yang sama dengan
 * `RESERVE_FRACTION` dan `TAIL_FRACTION`.
 *
 * Tanpa batas ini, satu hasil tool raksasa menarik ambang ke bawah sampai
 * hampir nol dan pemadatan menyala di TIAP langkah walau konteksnya masih
 * lapang — dan tiap nyala yang tidak menemukan apa pun untuk dibuang tetap
 * membayar satu panggilan peringkas. Pertumbuhan sebesar itu pun memang tidak
 * bisa ditolong: hasil yang lebih besar dari seperempat anggaran tetap tidak
 * muat sesudah pemadatan mana pun, jadi memesan tempat untuknya cuma
 * memindahkan luapan, bukan mencegahnya.
 */
export function effectiveGrowth(budget: number, growth: number): number {
  return Math.min(growth, Math.floor(budget / RESERVE_FRACTION))
}

/**
 * Ukuran konteks yang AKAN dikirim: yang terakhir terukur, DITAMBAH yang sudah
 * menempel sesudah pengukuran itu.
 *
 * Dua besaran yang gampang tertukar, dan pernah tertukar:
 *
 *   - `lastStepTokens` — FAKTA dari provider, tapi tentang permintaan yang
 *     SUDAH lewat. Ia belum memuat hasil tool yang baru saja tiba.
 *   - `arrivedTokens` — juga FAKTA, tapi tentang pesan yang sudah ada di tangan
 *     dan pasti ikut di permintaan berikutnya. Karena itu ia TIDAK dijepit:
 *     menjepitnya berarti berpura-pura sesuatu yang sudah ada lebih kecil
 *     daripada sebenarnya.
 *   - `growthMargin` di `overBudget` — TAKSIRAN tentang langkah yang belum
 *     terjadi. Itu yang dijepit, karena ia spekulasi.
 *
 * Terukur: satu hasil `read` 28 KB (≈7.000 token) tiba saat langkah sebelumnya
 * baru memakai 322 token. Tanpa menjumlahkan yang baru tiba, ambang membandingkan
 * 322 dengan 4.608 dan memutuskan semuanya baik-baik saja — permintaan
 * berikutnya berangkat dengan 8.354 token pada jendela 8192, dan begitu
 * seterusnya di 29 dari 30 langkah.
 */
export function projectedContext(
  lastStepTokens: number | undefined,
  arrivedTokens: number,
): number | undefined {
  return lastStepTokens === undefined ? undefined : lastStepTokens + arrivedTokens
}

/**
 * Apakah konteks sudah cukup penuh untuk dipadatkan.
 *
 * `lastStepTokens` WAJIB input token satu langkah, bukan `totalUsage` yang
 * menjumlahkan seluruh langkah. Giliran 20 langkah dengan konteks tetap 15k
 * melaporkan totalUsage ~300k; memakainya di sini memicu pemadatan terus-menerus
 * sambil terlihat persis seperti fitur yang sedang bekerja.
 *
 * `growthMargin` memesan tempat untuk SATU langkah berikutnya. Pemicunya
 * membaca angka langkah SEBELUMNYA, jadi tanpa margin ia bisa lolos di
 * ambang−1 lalu langkah sesudahnya menempelkan satu hasil tool utuh. Terukur:
 * jendela 8192, ambang 6144, langkah pertama berhenti di 6142, satu baca 6 KB
 * menyusul, dan konteks berikutnya mendarat 257 token dari bibir jendela —
 * tanpa satu pun pemadatan pernah menyala.
 *
 * Batas yang tidak dideklarasikan berarti mati, bukan ditebak — lihat
 * `contextWindowFor`.
 */
export function overBudget(
  lastStepTokens: number | undefined,
  contextWindow: number | undefined,
  reserved: number,
  growthMargin = 0,
): boolean {
  if (lastStepTokens === undefined || contextWindow === undefined) return false
  const budget = budgetTokens(contextWindow, reserved)
  return lastStepTokens >= budget - effectiveGrowth(budget, growthMargin)
}

/**
 * Model yang `reserved`-nya menelan seperempat jendelanya atau lebih.
 *
 * Lantai di `effectiveReserved` sudah membuat perilakunya waras, jadi ini
 * bukan peringatan soal kerusakan — ini memberi tahu user bahwa angka yang ia
 * tulis TIDAK dipakai apa adanya, supaya ia tidak menyetel ulang berkali-kali
 * dan bingung kenapa tidak ada bedanya.
 */
export function reservedCollisions(
  config: Config,
): { model: string; reserved: number; contextWindow: number }[] {
  const reserved = config.compaction.reserved
  const out: { model: string; reserved: number; contextWindow: number }[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const contextWindow = model.contextWindow
      if (contextWindow === undefined) continue
      if (reserved <= Math.floor(contextWindow / RESERVE_FRACTION)) continue
      out.push({ model: `${providerId}/${modelId}`, reserved, contextWindow })
    }
  }
  return out
}
