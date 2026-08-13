import crypto from "node:crypto"

/**
 * Deteksi perulangan — dimensi SITUASI dari model izin.
 *
 * Ini satu-satunya kendali di Titah yang tidak menjaga berkas, shell, atau
 * jaringan. Ia menjaga **uang dan waktu user**: model yang berputar memanggil
 * perintah yang sama yang gagal dengan cara yang sama, dua puluh kali, dan
 * setiap putaran dibayar penuh.
 *
 * Dipisahkan dari izin karena ia bukan pertanyaan tentang kewenangan. Ia
 * pertanyaan tentang keadaan: *"ini sudah pernah, dan hasilnya tidak berubah."*
 * Izin hanya cara meneruskan jawabannya ke user.
 *
 * # Yang dideteksi, dan yang TIDAK
 *
 * Yang dideteksi: **panggilan identik yang berulang** dalam jendela bergerak —
 * tool yang sama dengan argumen yang sama, tiga kali dalam sepuluh panggilan
 * terakhir.
 *
 * Yang TIDAK dideteksi: siklus banyak langkah yang setiap anggotanya berbeda
 * (baca A, sunting B, baca A, sunting B), dan pengulangan yang argumennya
 * berubah sedikit tiap kali. Keduanya nyata, dan keduanya butuh perbandingan
 * yang jauh lebih mahal.
 *
 * Batas itu dinyatakan alih-alih disamarkan: deteksi yang mengaku menangkap
 * semua perulangan akan membuat user berhenti waspada terhadap yang lolos.
 */

/** Berapa panggilan terakhir yang diingat. */
const WINDOW = 10

/**
 * Berapa kali panggilan identik boleh muncul sebelum dianggap berputar.
 *
 * Tiga, bukan dua. Dua panggilan identik adalah kejadian biasa dan sah — model
 * membaca berkas, menyuntingnya, lalu membacanya lagi untuk memastikan. Yang
 * ketiga sudah bukan pemeriksaan; ia pola.
 */
const REPEATS = 3

interface Entry {
  key: string
}

const windows = new Map<string, Entry[]>()

function fingerprint(tool: string, input: unknown): string {
  // Hash, bukan string mentah: input tool bisa memuat seluruh isi berkas, dan
  // menyimpan sepuluh salinannya per sesi adalah kebocoran memori yang tumbuh
  // dengan ukuran berkas yang disunting.
  const body = `${tool}:${JSON.stringify(input ?? null)}`
  return crypto.createHash("sha1").update(body).digest("hex")
}

/**
 * Mencatat satu panggilan, dan menjawab apakah ia berputar.
 *
 * Dipanggil SEBELUM tool dijalankan — kalau dicatat sesudah, panggilan yang
 * memicu deteksi adalah yang sudah terlanjur jalan.
 */
export function noteCall(sessionID: string, tool: string, input: unknown): boolean {
  const key = fingerprint(tool, input)
  const window = windows.get(sessionID) ?? []
  window.push({ key })
  if (window.length > WINDOW) window.shift()
  windows.set(sessionID, window)

  return window.filter((entry) => entry.key === key).length >= REPEATS
}

/**
 * Melupakan riwayat sebuah sesi.
 *
 * Dipanggil saat giliran BARU dimulai: perulangan adalah properti satu giliran,
 * dan membawa hitungannya lintas giliran berarti user yang sengaja menjalankan
 * perintah yang sama tiga kali di tiga giliran berbeda akan disela seolah model
 * sedang macet.
 */
export function clearLoopWindow(sessionID: string): void {
  windows.delete(sessionID)
}
