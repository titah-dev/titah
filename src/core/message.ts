/** Bentuk pesan & part yang dilihat klien. Bukan format yang dikirim ke LLM. */

export interface Session {
  id: string
  title: string
  directory: string
  created: number
  updated: number
  /** Sesi induk yang melahirkan sub-agent ini lewat `task`. Kosong untuk sesi biasa. */
  parentID?: string
}

export type ToolState =
  | { status: "pending"; input?: unknown }
  | {
      status: "running"
      input: unknown
      title?: string
      started: number
      /**
       * Ekor keluaran yang sudah keluar SEJAUH INI, untuk perintah panjang.
       *
       * Opsional dengan sengaja: hanya `bash` yang mengisinya, dan dua puluh
       * tiga tool lain tidak berubah sama sekali karena field ini ada.
       *
       * Hanya EKOR, bukan seluruhnya. Keluaran penuh sudah punya tempatnya di
       * `completed.output`; yang dibutuhkan selagi berjalan cuma kabar bahwa
       * sesuatu masih bergerak, dan menyimpan megabyte di state yang
       * diterbitkan berkali-kali per detik membayar mahal untuk itu.
       */
      output?: string
    }
  | {
      status: "completed"
      input: unknown
      title: string
      /**
       * Tool yang SELESAI tanpa melempar, tapi hasilnya bukan keberhasilan.
       *
       * `task` tidak pernah melempar — pembatalan dan kegagalan sub-agent
       * adalah informasi untuk koordinator, bukan error giliran. Tanpa
       * penanda ini riwayat menggambar `✓ task penulis (failed)`: glyph
       * sukses di atas sub-agent yang jelas-jelas tidak sukses.
       */
      outcome?: "failed" | "stopped"
      /** Ringkas. Kalau output aslinya besar, isinya dipotong dan `outputRef` diisi. */
      output: string
      /** Path ke blob penuh di tool-output/ (Q11). */
      outputRef?: string
      truncated: boolean
      started: number
      ended: number
    }
  | { status: "error"; input: unknown; error: string; started: number; ended: number }
  /** Dibedakan dari error: user (atau kebijakan) menolak, tool tidak pernah jalan. */
  | { status: "denied"; input: unknown; title: string; reason: string; started: number; ended: number }

export type Part =
  | { type: "text"; text: string }
  /**
   * Penalaran model, kalau ia mengirimkannya.
   *
   * Dipisah dari `text` dan bukan digabung, karena keduanya berbeda derajat:
   * `text` adalah jawaban, ini adalah jalan menuju jawaban. Menggabungkannya
   * membuat riwayat tidak bisa lagi menjawab "apa yang sebenarnya ia katakan".
   *
   * Ia TIDAK bisa bocor ke permintaan model. Yang dikirim dibangun dari tabel
   * `model_message`, yang diisi dari `step.response.messages` milik AI SDK —
   * bukan dari `parts` di sini. Keduanya memang dua jalur yang berbeda, dan
   * satu test memaku sifat itu karena ia tidak terbaca dari satu berkas mana
   * pun.
   */
  | { type: "reasoning"; text: string }
  | { type: "tool"; callID: string; tool: string; state: ToolState }

export interface Message {
  id: string
  sessionID: string
  role: "user" | "assistant"
  created: number
  parts: Part[]
  model?: string
  /**
   * `input` adalah total penagihan seluruh langkah; `context` adalah input
   * langkah TERAKHIR, yaitu ukuran konteks sesungguhnya. Dua besaran berbeda
   * yang tidak boleh berbagi satu field — menukarnya membuat ambang pemadatan
   * menyala jauh terlalu dini.
   */
  usage?: { input?: number; output?: number; context?: number }
  /**
   * Token & biaya yang dipakai agent EKSTERNAL. Sengaja dipisah dari `usage`
   * (Q24): menjumlahkannya membuat angka biaya Titah bohong, karena keduanya
   * dibayar dari kantong yang berbeda.
   */
  externalUsage?: { input?: number; output?: number; cost?: number }
  error?: string
  /** Commit snapshot sebelum giliran ini menulis apa pun. Dipakai `/undo`. */
  snapshot?: string
}

export function textOf(message: Message): string {
  return message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}
