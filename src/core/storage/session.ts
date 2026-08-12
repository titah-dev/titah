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
 * Riwayat SEPERTI YANG DILIHAT MODEL: ringkasan di depan, lalu pesan yang belum
 * dipadatkan apa adanya.
 *
 * Ringkasan dikirim sebagai pasangan user+assistant, bukan satu pesan user.
 * Ekor yang dipertahankan selalu diawali pesan user, jadi tanpa pasangan itu
 * akan ada dua pesan user berturut-turut — sesuatu yang ditolak sebagian
 * provider dan diam-diam digabung oleh sebagian yang lain.
 */
export function listModelMessages(sessionID: string): ModelMessage[] {
  const rows = listModelRows(sessionID)
  const compaction = latestCompaction(sessionID)
  if (!compaction) return rows.map((row) => row.message)

  const tail = rows.filter((row) => row.seq > compaction.seq).map((row) => row.message)
  return [
    { role: "user", content: compaction.summary },
    { role: "assistant", content: "Understood. I will continue from that summary." },
    ...tail,
  ]
}
