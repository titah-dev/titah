import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { dataDir, sessionDbFile } from "../paths.ts"

/**
 * SQLite hanya untuk metadata dan pesan (Q11). Output tool yang besar TIDAK
 * masuk sini — lihat storage/blob.ts. Instalasi opencode di mesin pengembang
 * tumbuh jadi 580 MB justru karena semuanya dijejalkan ke DB.
 */

let db: DatabaseSync | undefined

const MIGRATIONS: string[] = [
  `CREATE TABLE session (
     id        TEXT PRIMARY KEY,
     title     TEXT    NOT NULL DEFAULT '',
     directory TEXT    NOT NULL,
     created   INTEGER NOT NULL,
     updated   INTEGER NOT NULL
   );
   CREATE TABLE message (
     id         TEXT PRIMARY KEY,
     session_id TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
     seq        INTEGER NOT NULL,
     role       TEXT    NOT NULL,
     created    INTEGER NOT NULL,
     data       TEXT    NOT NULL
   );
   CREATE INDEX message_session_seq ON message(session_id, seq);
   CREATE INDEX session_updated ON session(updated DESC);

   -- Riwayat dalam format AI SDK, dipakai untuk melanjutkan percakapan.
   -- Dipisah dari tabel message supaya kita tidak perlu merakit ulang
   -- plumbing tool-call/tool-result dengan tangan setiap giliran.
   CREATE TABLE model_message (
     session_id TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
     seq        INTEGER NOT NULL,
     data       TEXT    NOT NULL,
     PRIMARY KEY (session_id, seq)
   );`,

  // Pemetaan sesi eksternal (Q12): `@claude` kedua harus melanjutkan sesi Claude
  // yang sama, bukan memulai dari nol. Dipisah per (sesi Titah, agent).
  `CREATE TABLE external_session (
     session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
     agent_id    TEXT NOT NULL,
     external_id TEXT NOT NULL,
     created     INTEGER NOT NULL,
     updated     INTEGER NOT NULL,
     PRIMARY KEY (session_id, agent_id)
   );`,

  /*
   * Manajemen konteks: batas air pemadatan.
   *
   * Baris model_message TIDAK dihapus. Yang disimpan cuma "sampai seq berapa
   * sudah diringkas" plus ringkasannya, dan perakitan riwayat memakai itu.
   * Menghapus akan membuat pemadatan tidak bisa diperiksa maupun dibatalkan,
   * padahal ringkasan yang meleset justru penyebab halusinasi yang mau dicegah.
   */
  `CREATE TABLE compaction (
     session_id TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
     seq        INTEGER NOT NULL,
     summary    TEXT    NOT NULL,
     created    INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   );`,

  /*
   * Sesi anak: satu sub-agent, satu sesi, tertaut ke giliran yang melahirkannya.
   *
   * Kolom terpisah, bukan tabel baru: anak ADALAH sesi seutuhnya — ia punya
   * pesan, snapshot, dan pembatalannya sendiri. Memisahkannya ke tabel lain
   * berarti menduplikasi semuanya.
   */
  `ALTER TABLE session ADD COLUMN parent_id TEXT REFERENCES session(id) ON DELETE CASCADE;
   CREATE INDEX session_parent ON session(parent_id);`,
]

export function database(): DatabaseSync {
  if (db) return db

  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const file = process.env.TITAH_DB ?? sessionDbFile()
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })

  const connection = new DatabaseSync(file)
  connection.exec("PRAGMA journal_mode = WAL")
  connection.exec("PRAGMA foreign_keys = ON")
  connection.exec("PRAGMA busy_timeout = 5000")
  migrate(connection)

  db = connection
  return connection
}

/**
 * Menjalankan beberapa penulisan sebagai SATU satuan: semuanya jadi, atau tidak
 * ada yang jadi.
 *
 * Dibutuhkan hanya oleh jalur tulis yang terdiri dari beberapa pernyataan.
 * Pernyataan tunggal sudah atomik dengan sendirinya di SQLite, jadi
 * membungkusnya cuma menambah dua perintah tanpa mengubah jaminan apa pun.
 *
 * Kegagalan separuh jalan di jalur multi-pernyataan bukan sekadar "sebagian
 * data hilang": ia meninggalkan keadaan yang TERBACA seperti keadaan sah, lalu
 * penulisan berikutnya menambahkan lagi di atasnya. Untuk riwayat model,
 * akibatnya riwayat berganda — dan `PRIMARY KEY (session_id, seq)` tidak
 * menangkapnya, karena nomor urut berikutnya dihitung dari `MAX(seq)` yang ikut
 * bergeser.
 *
 * TIDAK boleh disarangkan: SQLite menolak `BEGIN` di dalam transaksi. Semua
 * pemanggilnya adalah jalur tulis paling dalam, jadi tidak ada penjaga
 * kedalaman di sini — menambahkannya berarti mengarang kebutuhan yang belum ada.
 */
export function transaction<T>(fn: () => T): T {
  const connection = database()
  connection.exec("BEGIN")
  try {
    const result = fn()
    connection.exec("COMMIT")
    return result
  } catch (error) {
    connection.exec("ROLLBACK")
    throw error
  }
}

function migrate(connection: DatabaseSync): void {
  const row = connection.prepare("PRAGMA user_version").get() as { user_version: number }
  let version = row.user_version
  while (version < MIGRATIONS.length) {
    connection.exec("BEGIN")
    try {
      connection.exec(MIGRATIONS[version] as string)
      version += 1
      connection.exec(`PRAGMA user_version = ${version}`)
      connection.exec("COMMIT")
    } catch (error) {
      connection.exec("ROLLBACK")
      throw error
    }
  }
}

/** Dipakai test supaya tiap berkas test punya DB sendiri. */
export function resetDatabaseForTests(): void {
  db?.close()
  db = undefined
}
