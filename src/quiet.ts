/**
 * Meredam SATU peringatan: `node:sqlite` yang masih eksperimental.
 *
 * Node menuliskannya ke stderr setiap kali modulnya dimuat, dan modul itu
 * dimuat di setiap perintah — termasuk `titah --version`. Jadi dua baris
 * peringatan menyambut user sebelum satu pun keluaran yang ia minta muncul.
 * Ia bukan tanda ada yang salah: `node:sqlite` memang dipilih dengan sadar,
 * dan itulah alasan Node ≥22.6 jadi syarat.
 *
 * Yang diredam hanya peringatan itu. Peringatan lain diteruskan ke penangan
 * bawaan Node apa adanya — termasuk `--trace-warnings`, yang tetap bekerja
 * karena penangan bawaannya yang kita panggil, bukan tiruan buatan sendiri.
 *
 * Diimpor PALING ATAS di `cli.ts`, sebelum apa pun yang menyeret
 * `node:sqlite`: modul ESM dievaluasi urut, dan peringatan yang sudah
 * terlanjur tercetak tidak bisa ditarik kembali.
 */
const bawaan = process.listeners("warning")
process.removeAllListeners("warning")

process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return
  for (const penangan of bawaan) penangan(warning)
})
