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

  /*
   * Intent state (issue #5): rencana yang ditulis model untuk dirinya sendiri.
   *
   * Tabel SENDIRI, dan itulah yang membuatnya selamat dari pemadatan. Pemangkas
   * hanya menulis ulang baris `model_message`, dan peringkas hanya membaca baris
   * di atas batas air. Keduanya tidak menyebut tabel ini, dan tidak bisa — itu
   * sifat skema, bukan aturan yang harus diingat orang.
   *
   * Bukan kolom di `session`: membaca rencana tidak boleh berarti memuat lalu
   * menulis ulang metadata sesi setiap giliran.
   */
  `CREATE TABLE plan (
     session_id TEXT    PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
     text       TEXT    NOT NULL,
     updated    INTEGER NOT NULL
   );`,

  /*
   * Memory-Augmented Generation: fakta yang bertahan LINTAS SESI.
   *
   * Kuncinya PROYEK, bukan sesi — dan itulah satu-satunya hal yang
   * membedakannya dari `plan` di atas. `plan` adalah niat untuk pekerjaan yang
   * sedang berjalan dan mati bersama sesinya; ini fakta tentang proyeknya yang
   * masih benar besok pagi.
   *
   * Tabel sendiri, dengan alasan yang sama seperti `plan`: pemadatan hanya
   * menyentuh `model_message`, jadi ia tidak bisa menjangkau yang ini.
   *
   * DITAMBAHKAN DI UJUNG, dan itu wajib. `migrate` menjalankan migrasi
   * berdasarkan INDEKS lewat `PRAGMA user_version` — menyisipkan satu di tengah
   * akan membuat database yang sudah ada melewatinya lalu mencoba menjalankan
   * migrasi berikutnya yang SUDAH pernah dijalankan, dan gagal dengan "table
   * already exists" di mesin yang justru paling tidak boleh rusak: mesin yang
   * sudah dipakai.
   */
  `CREATE TABLE memory (
     id      TEXT    PRIMARY KEY,
     project TEXT    NOT NULL,
     text    TEXT    NOT NULL,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE INDEX memory_project ON memory(project, created);`,

  /*
   * Giliran yang berjalan di latar, sebagai proses TERPISAH.
   *
   * Tabel, bukan berkas JSON di dataDir: registri ini ditulis oleh satu proses
   * dan dibaca oleh proses lain — persis keadaan yang membuat berkas JSON
   * rusak, karena dua penulis yang bertemu di tengah menghasilkan berkas yang
   * tidak bisa diurai siapa pun. SQLite sudah menangani itu, dan sudah ada.
   *
   * `pid` yang dicatat mungkin sudah mati saat dibaca — proses latar memang
   * bisa selesai kapan saja, dan tidak ada yang membersihkan barisnya. Yang
   * membaca WAJIB memeriksa apakah pidnya masih hidup, bukan mempercayai
   * `status` di sini.
   *
   * DITAMBAHKAN DI UJUNG — lihat komentar `memory` di atas.
   */
  `CREATE TABLE background (
     id         TEXT    PRIMARY KEY,
     session_id TEXT    NOT NULL,
     pid        INTEGER NOT NULL,
     prompt     TEXT    NOT NULL,
     directory  TEXT    NOT NULL,
     log        TEXT    NOT NULL,
     started    INTEGER NOT NULL
   );
   CREATE INDEX background_started ON background(started DESC);`,
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
  // `IMMEDIATE`, bukan `BEGIN` biasa (DEFERRED).
  //
  // DEFERRED membuka snapshot BACA dulu, lalu berusaha menaik ke transaksi TULIS
  // pada pernyataan tulis pertama. Di mode WAL, kalau ada proses lain yang commit
  // di antara keduanya, kenaikan itu gagal dengan `SQLITE_BUSY_SNAPSHOT` — dan
  // `PRAGMA busy_timeout` TIDAK mengulang yang itu. Sebelum ada transaksi di sini,
  // insert telanjangnya justru tercakup timeout tersebut, jadi membungkusnya
  // dengan DEFERRED menukar satu jaminan dengan kegagalan kelas baru: satu TUI
  // dan satu `titah run` pada DB yang sama membuat flush akhir-giliran melempar,
  // giliran yang sebenarnya BERHASIL ditandai error, dan riwayat modelnya hilang.
  //
  // `IMMEDIATE` mengambil kunci tulis di awal, sehingga tunggu-dan-ulang milik
  // `busy_timeout` berlaku sebagaimana mestinya.
  connection.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    connection.exec("COMMIT")
    return result
  } catch (error) {
    // `ROLLBACK` sendiri bisa melempar — paling gampang kalau yang gagal justru
    // `COMMIT` dan SQLite sudah menggulung sendiri, sehingga tidak ada transaksi
    // aktif untuk digulung. Membiarkannya lepas berarti error yang dilihat
    // pemanggil adalah "cannot rollback — no transaction is active", menutupi
    // penyebab SUNGGUHAN yang justru satu-satunya yang berguna untuk didiagnosis.
    try {
      connection.exec("ROLLBACK")
    } catch {
      // Sengaja ditelan: keadaan DB sudah benar (tergulung atau tidak pernah
      // terbuka), dan error aslinya di bawah ini yang harus sampai.
    }
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
