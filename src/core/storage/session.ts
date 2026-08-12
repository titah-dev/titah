import crypto from "node:crypto"
import path from "node:path"
import type { ModelMessage } from "ai"
import type { Message, Session } from "../message.ts"
import { database, transaction } from "./db.ts"

interface SessionRow {
  id: string
  title: string
  directory: string
  created: number
  updated: number
  parent_id?: string | null
}

/**
 * Merakit `Session` dari `SessionRow` dengan menyebut tiap field satu-satu.
 *
 * Sengaja BUKAN spread (`{ ...row, parentID: ... }`): spread mempertahankan
 * `parent_id` mentah di objek hasil, dan itu bocor keluar lewat endpoint HTTP
 * yang men-JSON.stringify hasil `getSession` tanpa allow-list field.
 */
function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    directory: row.directory,
    created: row.created,
    updated: row.updated,
    parentID: row.parent_id ?? undefined,
  }
}

/**
 * Path proyek dibakukan sebelum disimpan maupun dicari.
 *
 * Tanpa ini `/home/a/proyek` dan `/home/a/proyek/` menjadi dua proyek berbeda,
 * dan user kehilangan seluruh riwayatnya hanya karena mengetik garis miring.
 */
export function projectKey(directory: string): string {
  return path.resolve(directory)
}

export function createSession(directory: string, title = ""): Session {
  const now = Date.now()
  const session: Session = {
    id: `ses_${crypto.randomUUID()}`,
    title,
    directory: projectKey(directory),
    created: now,
    updated: now,
  }
  database()
    .prepare("INSERT INTO session (id, title, directory, created, updated) VALUES (?, ?, ?, ?, ?)")
    .run(session.id, session.title, session.directory, session.created, session.updated)
  return session
}

export function getSession(id: string): Session | undefined {
  const row = database().prepare("SELECT * FROM session WHERE id = ?").get(id) as
    | SessionRow
    | undefined
  if (!row) return undefined
  return toSession(row)
}

/**
 * Sesi anak: satu sub-agent yang Titah jalankan sendiri, direkam sebagai sesi
 * penuh tertaut ke giliran yang melahirkannya lewat `task`.
 *
 * Direktori kerja diwariskan dari parameter, bukan dibaca dari induk, supaya
 * pemanggil (Task 6) bebas memberi sub-agent direktori berbeda kalau perlu.
 */
export function createChildSession(parentID: string, directory: string, title: string): Session {
  const now = Date.now()
  const session: Session = {
    id: `ses_${crypto.randomUUID()}`,
    title,
    directory: projectKey(directory),
    created: now,
    updated: now,
    parentID,
  }
  database()
    .prepare(
      "INSERT INTO session (id, title, directory, created, updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(session.id, session.title, session.directory, session.created, session.updated, parentID)
  return session
}

/** Anak-anak satu giliran, urut lahir — dipakai panel sub-agent dan `task`. */
export function listChildSessions(parentID: string): Session[] {
  const rows = database()
    .prepare("SELECT * FROM session WHERE parent_id = ? ORDER BY created ASC")
    .all(parentID) as unknown as SessionRow[]
  return rows.map(toSession)
}

/**
 * Sesi yang belum punya satu pun pesan — dibuat lalu ditinggalkan.
 *
 * TUI membuat sesi saat DIJALANKAN, bukan saat prompt pertama dikirim, karena
 * langganan event butuh id sesi sejak awal. Konsekuensinya tiap `titah` yang
 * dibuka lalu ditutup meninggalkan satu baris kosong.
 */
export function isEmptySession(id: string): boolean {
  const row = database()
    .prepare("SELECT 1 AS hit FROM message WHERE session_id = ? LIMIT 1")
    .get(id) as { hit: number } | undefined
  return row === undefined
}

/**
 * Menghapus sesi HANYA kalau ia kosong.
 *
 * Sengaja tidak memakai `deleteSession` langsung: pemanggilnya membuang sesi
 * yang ia kira tidak terpakai, dan satu salah hitung tidak boleh berujung
 * hilangnya percakapan sungguhan.
 */
export function discardIfEmpty(id: string): boolean {
  if (!isEmptySession(id)) return false
  return deleteSession(id)
}

/**
 * Sesi tersimpan, terbaru dulu.
 *
 * `directory` menyaring ke satu proyek. Riwayat percakapan hampir selalu terikat
 * ke kode yang sedang dikerjakan, jadi daftar yang mencampur seluruh proyek di
 * mesin ini membuat sesi yang benar-benar dicari tenggelam di antara yang tidak
 * relevan. Dibiarkan kosong berarti seluruh mesin — dipakai retensi, yang justru
 * HARUS melihat semuanya.
 *
 * Sesi kosong tidak pernah didaftar: tidak ada yang bisa dilanjutkan darinya.
 */
export function listSessions(limit = 50, directory?: string): Session[] {
  const db = database()
  const filled = "EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)"

  if (directory === undefined) {
    const rows = db
      .prepare(
        `SELECT s.* FROM session s WHERE ${filled} AND s.parent_id IS NULL ORDER BY s.updated DESC LIMIT ?`,
      )
      .all(limit) as unknown as SessionRow[]
    return rows.map(toSession)
  }

  const rows = db
    .prepare(
      `SELECT s.* FROM session s
        WHERE s.directory = ? AND ${filled} AND s.parent_id IS NULL
        ORDER BY s.updated DESC LIMIT ?`,
    )
    .all(projectKey(directory), limit) as unknown as SessionRow[]
  return rows.map(toSession)
}

export function touchSession(id: string, patch: { title?: string } = {}): Session | undefined {
  const session = getSession(id)
  if (!session) return undefined
  const updated = Date.now()
  const title = patch.title ?? session.title
  database().prepare("UPDATE session SET updated = ?, title = ? WHERE id = ?").run(updated, title, id)
  return { ...session, updated, title }
}

export function deleteSession(id: string): boolean {
  return database().prepare("DELETE FROM session WHERE id = ?").run(id).changes > 0
}

/**
 * Menyapu sesi kosong yang tertinggal karena Titah tidak sempat membersihkan
 * diri — crash, kill -9, mesin mati.
 *
 * Ada ambang usia, dan itu bukan kehati-hatian berlebihan: sesi kosong yang
 * BARU dibuat kemungkinan besar sedang dibuka klien lain yang belum mengetik
 * apa pun. Menghapusnya membuat prompt pertama orang itu gagal dengan "session
 * not found".
 */
export function pruneEmptySessions(olderThanMs: number): { sessions: number } {
  const cutoff = Date.now() - olderThanMs
  const result = database()
    .prepare(
      // `<=`, bukan `<`: dengan tenggang nol ini harus berarti "semua sesi
      // kosong". Dengan `<`, sesi yang dibuat pada milidetik yang sama lolos,
      // dan hasilnya bergantung pada ketepatan jam.
      `DELETE FROM session
        WHERE created <= ?
          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.session_id = session.id)`,
    )
    .run(cutoff)
  return { sessions: Number(result.changes) }
}

/**
 * Menghapus sesi yang lebih tua dari `olderThanMs`. Retensi ada sejak v1 dengan
 * sengaja: menambahkannya setelah user punya DB 600 MB sudah terlambat.
 */
export function pruneSessions(olderThanMs: number): { sessions: number } {
  const cutoff = Date.now() - olderThanMs
  const result = database().prepare("DELETE FROM session WHERE updated < ?").run(cutoff)
  database().exec("VACUUM")
  return { sessions: Number(result.changes) }
}

function nextSeq(table: "message" | "model_message", sessionID: string): number {
  const row = database()
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS max_seq FROM ${table} WHERE session_id = ?`)
    .get(sessionID) as { max_seq: number }
  return row.max_seq + 1
}

export function createMessage(
  sessionID: string,
  role: Message["role"],
  parts: Message["parts"] = [],
): Message {
  const message: Message = {
    id: `msg_${crypto.randomUUID()}`,
    sessionID,
    role,
    created: Date.now(),
    parts,
  }
  database()
    .prepare(
      "INSERT INTO message (id, session_id, seq, role, created, data) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      message.id,
      sessionID,
      nextSeq("message", sessionID),
      role,
      message.created,
      JSON.stringify(message),
    )
  return message
}

export function saveMessage(message: Message): void {
  database().prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify(message), message.id)
}

export function listMessages(sessionID: string): Message[] {
  const rows = database()
    .prepare("SELECT data FROM message WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionID) as { data: string }[]
  return rows.map((row) => JSON.parse(row.data) as Message)
}

/**
 * Ukuran konteks yang terakhir SUNGGUH terukur di sesi ini.
 *
 * Bukan sekadar pesan terakhir: giliran yang gagal atau dibatalkan tidak pernah
 * sempat mengukur apa pun, dan memakai angkanya akan mematikan pemadatan
 * otomatis sampai ada giliran yang sukses.
 *
 * Dicari dari BELAKANG lalu berhenti di temuan pertama. Yang dihemat adalah
 * JSON.parse-nya SAJA: barisnya tetap diambil semua oleh `.all()`, jadi ini
 * bukan pencarian yang murah secara I/O — hanya pencarian yang berhenti
 * membongkar setiap pesan sesi hanya untuk satu angka, yang jawabannya hampir
 * selalu ada di pesan assistant paling akhir.
 */
export function lastContextTokens(sessionID: string): number | undefined {
  const rows = database()
    .prepare(
      "SELECT data FROM message WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC",
    )
    .all(sessionID) as { data: string }[]
  for (const row of rows) {
    const context = (JSON.parse(row.data) as Message).usage?.context
    if (context !== undefined) return context
  }
  return undefined
}

/**
 * Riwayat dalam format AI SDK. Disimpan apa adanya dari `response.messages`
 * supaya kita tidak pernah merakit ulang pasangan tool-call/tool-result dengan
 * tangan — sumber bug yang mahal dan senyap.
 */
export function appendModelMessages(sessionID: string, messages: ModelMessage[]): void {
  if (messages.length === 0) return
  const insert = database().prepare(
    "INSERT INTO model_message (session_id, seq, data) VALUES (?, ?, ?)",
  )
  // `nextSeq` ikut MASUK transaksi. Membaca `MAX(seq)` di luar berarti angkanya
  // bisa sudah basi sebelum insert pertama mendarat, dan dua penulis akan
  // menyusun urutan dari dasar yang sama.
  //
  // Kenapa gagal separuh jalan itu SENYAP, dan karena itu wajib utuh: pemanggil
  // memajukan offset `flushed`-nya hanya setelah panggilan ini kembali, jadi
  // penulisan akhir-giliran mengirim ulang pesan yang sama. Baris yang tadi
  // sempat tertulis membuat `MAX(seq)` bergeser, sehingga PRIMARY KEY
  // (session_id, seq) menerima duplikatnya alih-alih menolaknya — riwayatnya
  // berganda, tanpa satu pun error.
  transaction(() => {
    let seq = nextSeq("model_message", sessionID)
    for (const message of messages) {
      insert.run(sessionID, seq, JSON.stringify(message))
      seq += 1
    }
  })
}

/**
 * Menimpa satu baris riwayat di tempat.
 *
 * Dipakai pruner: nomor urut WAJIB tidak berubah, karena batas air pemadatan
 * menunjuk ke `seq`. Menulis ulang sebagai baris baru akan memindahkan pesan ke
 * sisi lain batas air dan membuatnya dikirim dua kali.
 */
export function replaceModelMessage(
  sessionID: string,
  seq: number,
  message: ModelMessage,
): void {
  database()
    .prepare("UPDATE model_message SET data = ? WHERE session_id = ? AND seq = ?")
    .run(JSON.stringify(message), sessionID, seq)
}

export interface ModelRow {
  seq: number
  message: ModelMessage
}

/** Riwayat mentah beserta nomor urutnya — dasar untuk memasang batas pemadatan. */
export function listModelRows(sessionID: string): ModelRow[] {
  const rows = database()
    .prepare("SELECT seq, data FROM model_message WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionID) as { seq: number; data: string }[]
  return rows.map((row) => ({ seq: row.seq, message: JSON.parse(row.data) as ModelMessage }))
}

export interface Compaction {
  /** seq TERAKHIR yang sudah terwakili ringkasan. Di atas ini dikirim apa adanya. */
  seq: number
  summary: string
  created: number
}

export function saveCompaction(sessionID: string, seq: number, summary: string): void {
  database()
    .prepare(
      "INSERT OR REPLACE INTO compaction (session_id, seq, summary, created) VALUES (?, ?, ?, ?)",
    )
    .run(sessionID, seq, summary, Date.now())
}

/** Pemadatan terbaru saja: tiap ringkasan sudah memuat ringkasan sebelumnya. */
export function latestCompaction(sessionID: string): Compaction | undefined {
  const row = database()
    .prepare("SELECT seq, summary, created FROM compaction WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
    .get(sessionID) as Compaction | undefined
  return row
}

/**
 * Pasangan user+assistant untuk satu blok yang dilindungi.
 *
 * Pasangan, bukan satu pesan user, dan alasannya struktural: ekor yang
 * dipertahankan selalu diawali pesan user, jadi satu pesan user sendirian di
 * sini menghasilkan dua pesan user berturut-turut — ditolak sebagian provider,
 * diam-diam digabung oleh sebagian yang lain. Berlaku sama untuk ringkasan
 * maupun rencana, jadi keduanya memakai fungsi yang sama.
 */
function protectedPair(content: string, acknowledgement: string): ModelMessage[] {
  return [
    { role: "user", content },
    { role: "assistant", content: acknowledgement },
  ]
}

/**
 * Ringkasan sebagai pasangan user+assistant, bukan satu pesan user.
 *
 * Diekspor supaya pemadatan bisa MENGUKUR permintaan dalam bentuk yang sama
 * persis dengan yang nanti dikirim. Dua salinan bentuk ini berarti yang diukur
 * bukan yang dikirim, dan selisihnya tidak akan terlihat sampai sebuah
 * permintaan meluap.
 */
export function summaryPair(summary: string): ModelMessage[] {
  return protectedPair(summary, "Understood. I will continue from that summary.")
}

/**
 * Rencana yang ditulis model untuk dirinya sendiri (issue #5).
 *
 * Teks kosong berarti tidak ada rencana, dan barisnya dihapus alih-alih
 * menyimpan string kosong — supaya "tidak punya rencana" dan "punya rencana
 * kosong" tidak jadi dua keadaan yang harus dibedakan di tiap pembaca.
 */
export function savePlan(sessionID: string, text: string): void {
  const trimmed = text.trim()
  if (trimmed === "") {
    database().prepare("DELETE FROM plan WHERE session_id = ?").run(sessionID)
    return
  }
  database()
    .prepare("INSERT OR REPLACE INTO plan (session_id, text, updated) VALUES (?, ?, ?)")
    .run(sessionID, trimmed, Date.now())
}

export interface Plan {
  text: string
  updated: number
}

export function readPlan(sessionID: string): Plan | undefined {
  return database()
    .prepare("SELECT text, updated FROM plan WHERE session_id = ?")
    .get(sessionID) as Plan | undefined
}

/** Blok rencana seperti yang dilihat model, atau kosong kalau belum ada. */
export function planPair(sessionID: string): ModelMessage[] {
  const plan = readPlan(sessionID)
  if (!plan) return []
  return protectedPair(
    `<plan>\n${plan.text}\n</plan>\n\nThis is your own working plan, carried across compaction. ` +
      "Update it with the plan tool as steps complete — a stale plan is worse than none.",
    "Understood. I will keep that plan updated as I work.",
  )
}

/**
 * Memory-Augmented Generation: fakta yang bertahan LINTAS SESI.
 *
 * Bedanya dari `plan` cuma satu, dan itu menentukan segalanya: kuncinya PROYEK,
 * bukan sesi. `plan` adalah niat untuk pekerjaan yang sedang berjalan; ini
 * adalah fakta tentang proyeknya yang masih benar besok pagi.
 */
export interface Memory {
  id: string
  text: string
  created: number
}

/**
 * Batas jumlah fakta per proyek.
 *
 * Memori menumpang di SETIAP permintaan, jadi ia bersaing langsung dengan
 * percakapan. Batas ini disengaja rendah: memori yang tumbuh tanpa batas
 * berubah jadi transkrip kedua yang tidak pernah diringkas — persis masalah
 * yang seluruh mesin pemadatan ada untuk menyelesaikannya.
 */
export const MAX_MEMORIES = 32

export function rememberFact(directory: string, text: string): Memory {
  const trimmed = text.trim()
  if (trimmed === "") throw new Error("An empty memory is not a memory.")
  const project = projectKey(directory)
  const now = Date.now()
  const id = `mem_${crypto.randomUUID().slice(0, 8)}`

  return transaction(() => {
    const existing = database()
      .prepare("SELECT COUNT(*) AS n FROM memory WHERE project = ?")
      .get(project) as { n: number }
    if (existing.n >= MAX_MEMORIES) {
      // Menolak, bukan membuang yang paling lama. Memori yang diam-diam
      // menggeser isinya sendiri adalah memori yang tidak bisa dipercaya — dan
      // yang hilang justru fakta paling awal, yang biasanya paling mendasar.
      throw new Error(
        `This project already has ${existing.n} memories, the maximum. ` +
          "Forget one before remembering something new — memory rides in every request, " +
          "so it competes with the conversation itself.",
      )
    }
    database()
      .prepare("INSERT INTO memory (id, project, text, created, updated) VALUES (?, ?, ?, ?, ?)")
      .run(id, project, trimmed, now, now)
    return { id, text: trimmed, created: now }
  })
}

export function listMemories(directory: string): Memory[] {
  return database()
    .prepare("SELECT id, text, created FROM memory WHERE project = ? ORDER BY created ASC")
    .all(projectKey(directory)) as unknown as Memory[]
}

export function forgetFact(directory: string, id: string): boolean {
  const result = database()
    .prepare("DELETE FROM memory WHERE project = ? AND id = ?")
    .run(projectKey(directory), id)
  return Number(result.changes) > 0
}

/**
 * Memori seperti yang dilihat model — SELURUHNYA, bukan hasil pencarian.
 *
 * Ini "eager recall", dan itu keputusan sadar. MAG klasik memasang langkah
 * pengambilan yang memilih fakta relevan; langkah itu punya kualitasnya sendiri,
 * dan ketika ia salah pilih, yang hilang adalah fakta yang justru dibutuhkan —
 * tanpa satu pun tanda bahwa ada yang hilang.
 *
 * Dengan store yang dibatasi 32 fakta, mengirim semuanya lebih murah daripada
 * risiko itu. Kalau batasnya suatu hari dinaikkan jauh, pengambilan jadi masuk
 * akal; pada ukuran ini, tidak.
 */
export function memoryPair(directory: string): ModelMessage[] {
  const facts = listMemories(directory)
  if (facts.length === 0) return []
  const body = facts.map((fact) => `- [${fact.id}] ${fact.text}`).join("\n")
  return protectedPair(
    `<project-memory>\n${body}\n</project-memory>\n\n` +
      "These are facts you recorded about this project in earlier sessions. " +
      "Correct or forget any that no longer hold — a wrong memory is worse than none.",
    "Understood. I will treat those as established, and correct them if I find otherwise.",
  )
}

/**
 * Bentuk permintaan, SATU definisi: ringkasan (kalau ada), lalu rencana, lalu ekor.
 *
 * Rencana diletakkan SESUDAH ringkasan dan SEBELUM ekor. Sesudah, karena
 * ringkasan adalah latar dan rencana adalah niat yang berlaku terhadap latar
 * itu; sebelum ekor, karena ekor adalah percakapan yang sedang berjalan dan
 * rencana harus sudah berlaku ketika ia dibaca.
 *
 * Fungsi ini ada karena bentuk itu sempat ditulis DUA kali: sekali di
 * `listModelMessages` yang MENGIRIM, sekali di `measure` (auto-compact.ts) yang
 * MENGUKUR. `summaryPair` sudah pernah diekstrak untuk alasan yang sama, dan
 * penambahan rencana langsung membuktikan alasan itu lagi — rencana masuk ke
 * yang mengirim dan luput dari yang mengukur, sehingga yang diukur bukan yang
 * dikirim, dan selisihnya baru terlihat ketika sebuah permintaan meluap.
 *
 * Dengan satu definisi, keduanya tidak bisa berbeda lagi.
 */
export function requestShape(
  summary: string | undefined,
  plan: ModelMessage[],
  tail: ModelMessage[],
  memory: ModelMessage[] = [],
): ModelMessage[] {
  /*
   * Urutannya bukan selera: ia diurutkan dari yang PALING JARANG berubah ke
   * yang paling sering, karena cache milik provider dikunci pada awalan yang
   * identik byte demi byte (lihat src/core/cag.ts).
   *
   *   memori   — berubah beberapa kali per proyek
   *   ringkasan — berubah saat pemadatan menyala
   *   rencana  — berubah beberapa kali per giliran
   *   ekor     — berubah tiap langkah
   *
   * Menukar memori dan rencana akan membuat setiap penulisan rencana ikut
   * membatalkan cache memori, dan tidak ada yang akan menyadarinya selain
   * tagihan yang tidak turun.
   */
  return [
    ...memory,
    ...(summary === undefined ? [] : summaryPair(summary)),
    ...plan,
    ...tail,
  ]
}

/**
 * Riwayat SEPERTI YANG DILIHAT MODEL.
 *
 * Rencana ikut dikirim meski belum pernah ada pemadatan — ia bukan pelengkap
 * ringkasan, ia berdiri sendiri.
 */
export interface SplitRequest {
  /**
   * Blok yang BERTAHAN lintas giliran: ringkasan dan rencana. Ia berubah jauh
   * lebih jarang daripada ekor.
   */
  protectedBlock: ModelMessage[]
  /** Percakapan yang sedang berjalan, tumbuh tiap langkah. */
  tail: ModelMessage[]
}

/**
 * Riwayat yang sama, tapi TERBELAH pada batas stabil/volatil.
 *
 * Pemisahan ini ada demi CAG (`src/core/cag.ts`): cache milik provider dikunci
 * pada awalan yang identik byte demi byte, jadi yang menentukan bukan APA yang
 * dikirim melainkan URUTANNYA. Pemanggil yang perlu menaruh titik potong cache
 * di antara keduanya tidak bisa melakukannya pada satu array yang sudah
 * digabung.
 *
 * `listModelMessages` di bawah tetap ada dan tetap menjadi gabungan persis dari
 * keduanya — itu yang membuat pengukuran dan pengiriman tidak bisa menyimpang.
 */
export function splitModelRequest(sessionID: string): SplitRequest {
  const rows = listModelRows(sessionID)
  const plan = planPair(sessionID)
  const memory = memoryPairForSession(sessionID)
  const compaction = latestCompaction(sessionID)

  if (!compaction) {
    return {
      protectedBlock: requestShape(undefined, plan, [], memory),
      tail: rows.map((row) => row.message),
    }
  }
  return {
    protectedBlock: requestShape(compaction.summary, plan, [], memory),
    tail: rows.filter((row) => row.seq > compaction.seq).map((row) => row.message),
  }
}

/**
 * Memori proyek untuk sebuah SESI — sesi tahu direktorinya, memori dikunci
 * direktori. Sesi yang hilang berarti tidak ada memori, bukan error: itu
 * terjadi pada sesi yang baru dibuat di dalam transaksi yang sama.
 */
function memoryPairForSession(sessionID: string): ModelMessage[] {
  const row = database()
    .prepare("SELECT directory FROM session WHERE id = ?")
    .get(sessionID) as { directory: string } | undefined
  return row ? memoryPair(row.directory) : []
}

export function listModelMessages(sessionID: string): ModelMessage[] {
  const { protectedBlock, tail } = splitModelRequest(sessionID)
  return [...protectedBlock, ...tail]
}
