/**
 * Menyisipkan `cache_control` ke permintaan OpenAI-compatible.
 *
 * # Kenapa ini tidak bisa lewat jalur yang sudah ada
 *
 * `cag.ts` menandai titik potong cache lewat `providerOptions.anthropic`. Itu
 * bekerja untuk `@ai-sdk/anthropic` dan TIDAK BISA bekerja untuk yang lain:
 * `providerOptions` bernamespace per provider, dan provider openai-compatible
 * hanya membaca namespace-nya sendiri. Tanda yang ditulis di namespace
 * `anthropic` dibuang sebelum menyentuh kabel — diam-diam, tanpa error.
 *
 * Jadi untuk gateway yang bicara bentuk OpenAI tapi meneruskan ke Anthropic,
 * penandaan harus terjadi di lapisan yang lebih rendah: badan permintaan itu
 * sendiri, tepat sebelum dikirim. `createOpenAICompatible` menerima `fetch`
 * sendiri, dan itulah satu-satunya kait yang melihat badan permintaan utuh.
 *
 * # Di mana tandanya diletakkan, dan kenapa di situ
 *
 * Pada pesan `system`, yang selalu pertama.
 *
 * `cache_control` menandai UJUNG sebuah awalan, bukan satu blok sendirian —
 * yang di-cache adalah semua yang mendahuluinya. Urutan Anthropic adalah
 * tools → system → messages, jadi satu tanda di ujung system mencakup seluruh
 * definisi tool DAN system prompt sekaligus. Pada Titah keduanya berjumlah
 * ~10.200 token dan dikirim ulang setiap panggilan; tidak ada satu tanda lain
 * yang mencakup sebanyak itu.
 *
 * Ekor percakapan sengaja tidak ditandai: ia berubah tiap langkah, dan
 * menandainya berarti menulis cache yang tidak akan pernah dibaca.
 *
 * # Gagalnya harus TERBUKA
 *
 * Fungsi ini duduk di jalur setiap permintaan model. Badan yang bentuknya tidak
 * dikenali dikembalikan APA ADANYA, bukan dilempar: kehilangan cache berarti
 * membayar lebih, sementara permintaan yang gagal berarti giliran yang mati.
 * Yang kedua jauh lebih mahal.
 */

export const EPHEMERAL = { type: "ephemeral" } as const

interface ChatBody {
  messages?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Menandai pesan system sebagai titik potong cache.
 *
 * Isi `system` boleh berupa string atau deretan blok. String diubah menjadi
 * satu blok teks supaya ada tempat menaruh tandanya — bentuk itu diterima
 * gateway yang meneruskan ke Anthropic, dan diabaikan dengan aman oleh yang
 * benar-benar OpenAI.
 */
export function markCacheControl(body: unknown): unknown {
  if (!isRecord(body)) return body
  const messages = (body as ChatBody).messages
  if (!Array.isArray(messages) || messages.length === 0) return body

  const index = messages.findIndex(
    (message) => isRecord(message) && message["role"] === "system",
  )
  if (index === -1) return body

  const system = messages[index] as Record<string, unknown>
  const content = system["content"]

  let blocks: unknown[]
  if (typeof content === "string") {
    if (content === "") return body
    blocks = [{ type: "text", text: content }]
  } else if (Array.isArray(content) && content.length > 0) {
    blocks = [...content]
  } else {
    return body
  }

  const last = blocks.at(-1)
  if (!isRecord(last)) return body
  // Sudah ditandai: jangan tumpuk. Dua tanda pada blok yang sama bukan sekadar
  // mubazir — sebagian gateway menolak permintaannya.
  if ("cache_control" in last) return body

  blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL }

  const next = [...messages]
  next[index] = { ...system, content: blocks }
  return { ...body, messages: next }
}

/**
 * Membungkus `fetch` supaya setiap permintaan chat membawa tanda cache.
 *
 * Hanya menyentuh permintaan yang badannya JSON berisi `messages`. Apa pun
 * yang lain — daftar model, unggahan, permintaan yang badannya aliran — lewat
 * tanpa disentuh sama sekali.
 */
export function withCacheControl(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const body = init?.body
    if (typeof body !== "string") return base(input, init)

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return base(input, init)
    }

    const marked = markCacheControl(parsed)
    if (marked === parsed) return base(input, init)

    return base(input, { ...init, body: JSON.stringify(marked) })
  }
}
