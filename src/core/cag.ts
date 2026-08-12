import type { ModelMessage } from "ai"
import type { Config } from "./schema.ts"
import { REAL_BYTES_PER_TOKEN } from "./compact.ts"

/**
 * Cache-Augmented Generation.
 *
 * # Konsepnya
 *
 * RAG mengambil potongan yang relevan SAAT bertanya, lalu menempelkannya ke
 * prompt. CAG bergerak ke arah sebaliknya: taruh bahan yang stabil di DEPAN
 * konteks satu kali, lalu biarkan cache milik provider menyajikannya ulang
 * setiap giliran tanpa dihitung ulang.
 *
 * Yang di-cache bukan teksnya, melainkan hasil perhitungan attention atas teks
 * itu — KV cache. Karena itu satu-satunya hal yang menentukan apakah cache
 * kena adalah **awalan yang identik byte demi byte**. Satu karakter berubah di
 * posisi 10, dan seluruh 50.000 token sesudahnya dihitung ulang.
 *
 * Konsekuensinya satu aturan, dan seluruh berkas ini adalah aturan itu:
 *
 *   **Susun permintaan dari yang paling jarang berubah ke yang paling sering.**
 *
 * # Kenapa Titah butuh ini secara khusus
 *
 * Prompt kosong Titah sudah memakan 6.400 token sebelum satu berkas dibaca:
 * system prompt, katalog 29 skill, instruksi proyek, dan definisi 19 tool.
 * Semuanya identik di setiap giliran, dan tanpa CAG semuanya dibayar penuh
 * setiap giliran. Pada sesi 40 giliran itu 256.000 token yang dibeli berulang
 * untuk isi yang tidak pernah berubah.
 *
 * # Kapan CAG dipakai — dan kapan TIDAK
 *
 * Keputusannya otomatis, dan syaratnya di `shouldCache` di bawah. Ringkasnya:
 *
 * DIPAKAI ketika ketiganya benar:
 *   1. Provider punya cache yang bisa dialamati. Anthropic punya `cache_control`
 *      eksplisit; endpoint OpenAI-compatible umumnya punya prefix caching
 *      OTOMATIS, yang tidak perlu ditandai tapi tetap butuh awalan stabil.
 *   2. Awalannya cukup besar untuk melewati ambang minimum provider. Di bawah
 *      itu, menandai cache justru menambah overhead tanpa memberi apa pun.
 *   3. Awalannya memang stabil. Kalau ia berubah tiap giliran, "cache" hanya
 *      berarti menulis lalu membuang.
 *
 * TIDAK DIPAKAI ketika:
 *   - Modelnya kecil dan lokal. Ollama tidak menagih token, jadi satu-satunya
 *     yang dihemat adalah waktu prefill — dan menandai blok cache pada endpoint
 *     yang tidak memahaminya berisiko ditolak, menukar penghematan nol dengan
 *     kemungkinan gagal.
 *   - Giliran pertama sebuah sesi pendek. Menulis cache ada ongkosnya (Anthropic
 *     menagih tulis lebih mahal dari baca); kalau tidak akan ada giliran kedua,
 *     itu rugi bersih. Diperkirakan dari panjang riwayat.
 *
 * # Yang TIDAK dilakukan di sini
 *
 * Tidak ada cache milik Titah sendiri. Godaan untuk menyimpan respons dan
 * menyajikannya ulang saat prompt sama itu besar, dan itu keliru untuk agent:
 * dua prompt identik pada working tree yang berbeda adalah dua pertanyaan yang
 * berbeda. Yang di-cache di sini hanya PERHITUNGAN, tidak pernah JAWABAN.
 */

/**
 * Ambang minimum blok yang layak ditandai, dalam token.
 *
 * Anthropic menolak breakpoint di bawah 1024 token untuk sebagian besar model
 * dan mengabaikannya diam-diam untuk sisanya. Titah memakai satu angka untuk
 * semua alih-alih tabel per model: menebak terlalu tinggi berarti kehilangan
 * cache yang sebenarnya sah, dan itu jauh lebih murah daripada mengirim
 * breakpoint yang ditolak.
 */
export const MIN_CACHEABLE_TOKENS = 1024

/**
 * Berapa banyak riwayat yang harus ada sebelum menulis cache dianggap untung.
 *
 * Menulis cache lebih mahal daripada membacanya, jadi giliran yang tidak akan
 * pernah dibaca ulang adalah kerugian bersih. Dua pesan berarti percakapan ini
 * sudah punya giliran kedua — bukti termurah yang ada bahwa akan ada giliran
 * ketiga.
 */
const MIN_HISTORY_FOR_CACHE = 2

export type CacheStyle = "anthropic" | "prefix-only" | "off"

export interface CacheDecision {
  style: CacheStyle
  /** Alasan, apa adanya — dipakai `titah doctor` dan pesan debug. */
  reason: string
}

export function tokensOf(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / REAL_BYTES_PER_TOKEN)
}

/**
 * Apakah, dan bagaimana, permintaan ini di-cache.
 *
 * `npm` adalah paket AI SDK provider yang dipakai — satu-satunya hal yang
 * memberi tahu kita apakah `cache_control` akan dipahami atau ditolak.
 */
export function shouldCache(options: {
  npm: Config["provider"][string]["npm"]
  systemText: string
  historyLength: number
}): CacheDecision {
  const size = tokensOf(options.systemText)

  if (size < MIN_CACHEABLE_TOKENS) {
    return {
      style: "off",
      reason: `stable prefix is ~${size} tokens, below the ${MIN_CACHEABLE_TOKENS}-token floor`,
    }
  }
  if (options.historyLength < MIN_HISTORY_FOR_CACHE) {
    // Bukan "off" untuk selamanya — hanya untuk giliran ini. Giliran berikutnya
    // memanggil fungsi ini lagi dengan riwayat yang sudah lebih panjang.
    return { style: "prefix-only", reason: "first turn — a cache write would not be read back" }
  }
  if (options.npm === "@ai-sdk/anthropic") {
    return { style: "anthropic", reason: `explicit cache_control on a ~${size}-token prefix` }
  }
  return {
    style: "prefix-only",
    reason: "openai-compatible endpoints cache prefixes automatically; ordering is what matters",
  }
}

/**
 * Menandai satu pesan sebagai titik potong cache.
 *
 * Hanya berlaku untuk Anthropic. Untuk provider lain fungsi ini mengembalikan
 * pesannya apa adanya — bukan diam-diam tidak melakukan apa pun, melainkan
 * karena pada provider itu memang tidak ADA yang perlu dilakukan: awalan yang
 * stabil sudah cukup, dan penandaannya dikerjakan server.
 */
export function withCacheBreakpoint(message: ModelMessage, style: CacheStyle): ModelMessage {
  if (style !== "anthropic") return message
  return {
    ...message,
    providerOptions: {
      ...(message.providerOptions ?? {}),
      anthropic: {
        ...((message.providerOptions?.["anthropic"] as Record<string, unknown> | undefined) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  } as ModelMessage
}

export interface CachedRequest {
  messages: ModelMessage[]
  decision: CacheDecision
  /** Berapa breakpoint yang benar-benar dipasang, untuk dilaporkan. */
  breakpoints: number
}

/**
 * Merakit permintaan dalam urutan stabil→volatil, dengan SATU titik potong cache.
 *
 * # Kenapa system prompt tidak ikut di sini, dan kenapa itu tetap ter-cache
 *
 * Rancangan pertama memindahkan `system` menjadi pesan pertama di `messages`,
 * supaya ia bisa membawa `cache_control` sendiri. AI SDK v7 MENOLAK itu:
 * "System messages are not allowed in the prompt or messages fields." Ditemukan
 * oleh test sub-agent, bukan oleh pembacaan dokumentasi.
 *
 * Ternyata pemindahan itu memang tidak perlu, dan rancangan penggantinya lebih
 * sederhana: `cache_control` menandai UJUNG sebuah awalan, bukan satu blok
 * sendirian. Segmen yang di-cache adalah SEMUA yang mendahului tanda itu —
 * termasuk system prompt dan seluruh definisi tool, yang keduanya berada paling
 * depan dan tidak pernah bisa ditandai langsung.
 *
 * Jadi satu tanda di tempat yang tepat mencakup persis bagian yang paling mahal.
 *
 * # Di mana tandanya diletakkan
 *
 * Pada pesan TERAKHIR yang masih stabil:
 *
 *   - Kalau ada blok terlindungi (memori, ringkasan, rencana), pada ujungnya.
 *   - Kalau tidak ada, pada pesan PERTAMA percakapan. Ia stabil karena tidak
 *     pernah berubah lagi setelah ditulis, dan tanpa tanda apa pun Anthropic
 *     tidak meng-cache apa pun sama sekali — justru pada giliran-giliran awal
 *     ketika system prompt adalah hampir seluruh permintaan.
 *
 * Ekor tidak pernah ditandai: ia berubah tiap langkah, dan menandainya berarti
 * menulis cache yang tidak akan pernah dibaca.
 */
export function buildCachedRequest(options: {
  /** Blok yang bertahan lintas giliran: memori, ringkasan, rencana. */
  protectedBlock: ModelMessage[]
  /** Percakapan yang sedang berjalan. */
  tail: ModelMessage[]
  decision: CacheDecision
}): CachedRequest {
  const { protectedBlock, tail, decision } = options
  const messages = [...protectedBlock, ...tail]

  if (decision.style !== "anthropic" || messages.length === 0) {
    return { messages, decision, breakpoints: 0 }
  }

  // Indeks pesan stabil TERAKHIR. Blok terlindungi kalau ada; kalau tidak,
  // pesan pertama percakapan — yang juga tidak pernah berubah lagi.
  const mark = protectedBlock.length > 0 ? protectedBlock.length - 1 : 0

  return {
    messages: messages.map((message, index) =>
      index === mark ? withCacheBreakpoint(message, decision.style) : message,
    ),
    decision,
    breakpoints: 1,
  }
}
