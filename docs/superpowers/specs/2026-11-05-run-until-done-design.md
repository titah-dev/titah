# Jalan sampai selesai, tetap pada referensi

Desain, 2026-11-05. Baseline: `main` @ `ee3c472` (0.9.1).

## Kenapa

Pemilik Titah memakainya untuk membangun web app besar dari **folder template
HTML/CSS yang sudah ada**. Dua keluhan:

1. **Pekerjaan berhenti di tengah jalan.** User harus mengetik "lanjutkan",
   "next", atau "continue" berulang kali.
2. **Hasil akhirnya tidak mirip template.** Model mulai mengarang tampilannya
   sendiri.

Yang diminta: Titah bekerja **seperti Claude Code**. Satu perintah dijalankan
sampai tuntas, tidak keluar dari konteks yang diberikan, dan bisa dihentikan
kapan saja dengan Esc. Biaya token menjadi tanggung jawab user, **asal tidak
boros**.

### Yang diukur, bukan ditebak

Diukur dari `~/.local/share/titah/titah.db`. Skripnya ada di Lampiran A.
Ada 23 pesan user berupa "lanjutkan"/"next"/"continue". Pesan assistant tepat
sebelum masing-masing:

| Penyebab berhenti | Jumlah |
|---|---|
| Model menutup giliran sendiri, tanpa batas apa pun yang tercapai | ~14 |
| ... di antaranya, teks terakhir berakhir dengan `:` (mengumumkan aksi, tidak pernah memanggilnya) | 7 |
| Error provider atau Esc | 7 |
| Tool call ditulis sebagai teks (`<tool_call><function=read>…`, `9router/ocode`) | 1 |
| Batas 40 langkah | 1 |

Dari 261 giliran `9router/ant` tanpa error, 13 berakhir dengan `:`.

**Kesimpulan:** penyebab utamanya bukan batas Titah. Model menutup giliran
lebih awal, dan Titah memperlakukannya sebagai jawaban selesai. Fitur
lanjut-otomatis yang ada (`limits.continueTurns`, `agent.ts` sekitar baris
1430) tidak menangkap kasus ini sama sekali, karena syaratnya
`stoppedAtLimit`. Di config user nilainya juga `0`.

### Kenapa `contextWindow` dipasang rendah

Config user mendeklarasikan `contextWindow: 131072` untuk model yang aslinya
1M. Ini disengaja: jendela kecil memaksa pemadatan lebih awal, dan model tetap
fokus. Masalahnya, satu angka itu sekarang mengatur tiga hal sekaligus:

- kapan pemadatan berjalan (`overBudget`, `auto-compact.ts`),
- anggaran satu giliran (`derivedTurnBudget` = 5 × jendela, sekitar 655k),
- batas aman provider.

"Fokus" dan "kapasitas" tergabung dalam satu tombol, sehingga mengatur yang
satu ikut merusak yang lain.

### Kenapa hasil melenceng dari template (hipotesis, belum diverifikasi)

Pemadatan meringkas transkrip, termasuk isi berkas template yang dibaca di awal.
Ringkasan seperti di sesi LMS (121k menjadi 6k karakter) hanya menyimpan
*"pakai template X"*, tidak menyimpan markup dan CSS-nya. Setiap lanjutan
kemudian bekerja dari ringkasan itu. Tabel `plan` selamat dari pemadatan, tapi
isinya niat, bukan referensi.

## Tujuan

- **G1.** Satu perintah dijalankan sampai rencananya tuntas tanpa user harus
  menyenggol, untuk agent primary (`build`).
- **G2.** "Fokus" (kapan memadatkan) bisa diatur terpisah dari "kapasitas"
  (jendela asli model).
- **G3.** Referensi yang ditunjuk user (folder template) tetap terlihat oleh
  model sepanjang sesi, termasuk setelah pemadatan dan setelah lanjutan.
- **G4.** Esc menghentikan semuanya, termasuk rangkaian lanjutan, dalam satu
  tekanan.

## Bukan tujuan

- Scheduler, cron, atau daemon. Itu fase lain dan bukan kebutuhan user saat ini.
- Membuat model lemah jadi pintar. Desain ini menangani cara giliran berakhir
  dan apa yang dilihat model, bukan kualitas penalarannya.
- Menyelesaikan otomatis giliran yang gagal karena error provider. Perilaku
  retry yang ada tetap seperti sekarang. Lihat "Diserahkan ke builder".
- Sub-agent (`task`). Anak tidak melanjutkan sendiri; induknya yang mengatur.

## Anti-tujuan (gagal walau secara teknis jalan)

- **Boros.** Lanjutan yang tidak menghasilkan kemajuan, mengulang pekerjaan
  yang sudah dicentang, atau mengirim ulang isi template utuh di setiap
  permintaan tanpa cache. Config user mencatat insiden nyata: satu "1" pernah
  menjadi tiga giliran beruntun sekitar 7,2 juta token.
- **Lanjut saat model memang bertanya ke user.** Kalau model butuh keputusan
  user, Titah harus berhenti, bukan menjawab sendiri.
- **Esc yang tidak benar-benar berhenti.** Misalnya Esc membatalkan giliran
  berjalan, lalu lanjutan berikutnya tetap mulai.
- **Jalan sendiri secara diam-diam.** Setiap lanjutan otomatis harus terlihat di
  layar, seperti notice `Continuing on its own…` yang sekarang.

## Desain

### 1. Fokus terpisah dari kapasitas

- `contextWindow` kembali berarti **jendela asli model**, dan hanya dipakai
  sebagai batas aman (provider akan menolak di atas angka ini).
- Kunci baru **`compaction.target`** (token, opsional): ukuran konteks yang
  memicu pemadatan. Ambang efektifnya `min(target, contextWindow − reserved)`.
  Tanpa `target`, perilakunya sama seperti sekarang.
  - Bisa diatur global di `compaction` dan per model (misalnya
    `provider.<id>.models.<id>.compactAt`) karena kebutuhan fokus berbeda per
    model. *Keputusan builder: nama kunci dan tempat persisnya, asal ada dua
    tingkat ini.*
- **Anggaran giliran bawaan dihapus.** `derivedTurnBudget` (5 × jendela) tidak
  lagi berlaku. `limits.turnTokens` tetap ada sebagai opt-in. Alasannya: dengan
  jendela 1M, anggaran turunan menjadi 5M dan tidak lagi bermakna, sementara
  dengan jendela kecil anggaran itu justru menjadi tembok yang memotong
  pekerjaan.
- **Batas langkah menjadi sekat, bukan tembok.** Saat `contextWindow`
  dideklarasikan, plafon langkah memakai `STEP_BACKSTOP` (200). Giliran yang
  mencapainya **selalu** dilanjutkan oleh mekanisme di bagian 2 selama masih ada
  pekerjaan terbuka. Bagi user tidak ada lagi "berhenti di batas". Batas itu
  hanya titik napas tempat transkrip disegarkan dan rencana dibaca ulang
  (alasannya sudah tercatat di komentar `continueTurns`, `schema.ts`).
- Notice dan teks `doctor` yang menyebut "naikkan `steps` atau `turnTokens`"
  disesuaikan.

### 2. Jalan sampai selesai

Syarat lanjutan otomatis diperluas. Giliran agent primary **belum selesai**
bila tidak dibatalkan, tidak error, bukan sub-agent, **dan** salah satu kondisi
berikut benar:

| Pemicu | Deteksi |
|---|---|
| A. Mentok batas (seperti sekarang) | `stoppedAtLimit` |
| B. Rencana masih terbuka | `hasOpenWork(readPlan(...))`, **dan** `plan.updated` ≥ waktu pesan user terakhir yang asli (bukan teks lanjutan), dan giliran berakhir tanpa memanggil `question` atau bertanya ke user |
| C. Mengumumkan tanpa aksi | teks terakhir (setelah trim) berakhir dengan `:`, dan tidak ada tool call di langkah terakhir |
| D. Tool call berbentuk teks | teks terakhir memuat pola `<tool_call>` / `<function=` |

**Kapan TIDAK lanjut** (diperiksa sesudah pemicu dan selalu menang):

- Langkah terakhir memanggil tool `question`, atau teks penutupnya berakhir
  dengan `?`. Model sedang bertanya ke user.
- **Tidak ada kemajuan.** Lanjutan terakhir tidak memanggil tool apa pun, *atau*
  teks rencana sama persis dengan sebelum lanjutan itu dimulai, dua kali
  berturut-turut. Ini rem utama anti-boros. Jumlah "dua kali" adalah keputusan
  saya; builder boleh menyetelnya setelah diukur.
- Esc ditekan. Esc membatalkan giliran berjalan **dan** rangkaian lanjutannya.
  `willContinue` sudah memeriksa `controller.signal.aborted`. Builder harus
  memastikan tidak ada celah antara akhir satu giliran dan awal giliran
  lanjutan di mana Esc hilang.

*Keputusan saya:* syarat kesegaran pada B mencegah pertanyaan sampingan
("fungsi ini untuk apa?") di sesi yang punya rencana lama setengah jadi
kembali mengerjakan rencana itu sendiri. Rencana dihitung hanya bila ditulis
atau diperbarui dalam rangkaian permintaan saat ini. Kolom `plan.updated`
sudah ada, jadi tidak perlu skema baru.

**Cakupan default** (*keputusan saya*): lanjutan "sampai selesai" menyala
secara bawaan hanya bila ada client interaktif (TUI/web) yang bisa menekan Esc.
`titah run` headless tetap memakai nilai `continueTurns` yang ditulis eksplisit,
default 0, karena tidak ada siapa pun yang bisa menekan Esc. User sudah
menyatakan token adalah tanggung jawabnya. Untuk user lain, `sessionTokens`
tetap tersedia sebagai rem opt-in.

**Teks lanjutan** dipilih sesuai pemicunya, dan semuanya tetap diawali
`[titah]` seperti `CONTINUE_TEXT`:

- A/B memakai `CONTINUE_TEXT` yang ada.
- C: *"Your previous message announced a next step but ended without doing it.
  Do it now."*
- D: *"Your previous message contained a tool call written as text, which was
  not executed. Call the tool properly."*

**`limits.continueTurns`:**

- Default berubah dari `0` menjadi "sampai selesai", dengan jaring patologi
  yang tinggi (misalnya 50) supaya tetap punya ujung.
- `0` tetap berarti mati.
- Ini mengubah arti default sebuah kunci config. Migrasi config (lihat commit
  `c9092a7`) **tidak** boleh menimpa nilai eksplisit user. Config user saat ini
  memuat `"continueTurns": 0` secara eksplisit, dan user yang mengubahnya
  sendiri. Lihat "Rollout".

**Rencana adalah kontrak "selesai".** Pemicu B hanya bekerja kalau model
menulis rencana. Prompt `build` (`prompt.ts`) sudah menyuruh menulis rencana
untuk pekerjaan lebih dari beberapa langkah. Tambahkan pengingat seperti
system-reminder Claude Code: jika agent primary sudah menjalankan N tool call
(misalnya 8) tanpa rencana, sisipkan satu pengingat lewat `instructions`
(bukan pesan di riwayat, alasannya sama dengan `LAST_STEP_NOTE`). Pengingat
itu meminta model menulis rencana bercentang. *Keputusan builder: nilai N,
setelah diukur.*

### 3. Referensi yang dikunci (melengkapi intent state)

Tabel `plan` sudah menyimpan **niat**. Bagian ini menambah **referensi**.

- **Cara menunjuk:**
  - Model memakai field baru `references: string[]` (path relatif ke proyek)
    di tool `plan`.
  - User memakai perintah `/pin <path>` dan `/unpin <path>` di TUI.
  - Path boleh berada **di luar proyek**, misalnya template di `~/Downloads`.
    Path di luar proyek melewati dimensi izin `external_directory` yang sudah
    ada, dan izinnya ditanya sekali saat di-pin, bukan setiap dibaca.
    *Keputusan saya*: template nyata sering tinggal di luar repo.
  - Keduanya menulis ke penyimpanan yang sama, per sesi, di luar
    `model_message`. Bisa berupa kolom baru di `plan` atau tabel sendiri;
    builder yang memilih.
  - Prompt `build` memberi tahu model: kalau user menyebut template, desain,
    atau contoh yang harus diikuti, kunci path-nya sebagai referensi.
- **Cara dibacakan:** sebagai pasangan terlindung dengan pola yang sama seperti
  `planPair`. Posisinya **sebelum** ringkasan dan rencana, tepat setelah
  memori. `requestShape` (`session.ts`) mengurutkan dari yang jarang berubah ke
  yang sering berubah, dan rencana ditulis ulang beberapa kali per giliran.
  Referensi yang ditaruh sesudah rencana akan kehilangan cache-nya setiap kali
  rencana ditulis. *Keputusan saya.* Isinya:
  - **manifest:** daftar berkas di bawah setiap path, beserta ukurannya;
  - **isi berkas**, dalam anggaran **25% dari ambang pemadatan efektif, dalam
    token**. Konversinya ke byte memakai `REAL_BYTES_PER_TOKEN` (4), jadi
    sekitar 130 KB untuk ambang 131k. *Keputusan saya.* Prioritasnya berkas yang dirujuk dari
    `index.html`/entry, lalu CSS, lalu sisanya;
  - berkas yang tidak muat hanya disebut di manifest, dengan instruksi untuk
    `read` sebelum menulis UI yang bersesuaian.
- **Biaya:** pasangan ini berada di prefiks yang stabil, jadi ia harus masuk
  titik `cache-control` yang sudah ada (`cache-control.ts`). Pada lanjutan
  berikutnya, yang dibayar penuh hanya cache read, bukan input baru. Ini syarat
  anti-boros, bukan optimasi.
  - Jalur OpenAI-compatible (`cache-control.ts`, dipakai 9router) saat ini
    hanya menandai pesan `system`. Tambahkan tanda kedua di akhir pasangan
    referensi. Beberapa gateway menolak tanda tambahan (lihat komentar di
    `cache-control.ts`), jadi tanda kedua ini harus bisa dimatikan per
    provider. Builder memverifikasi terhadap 9router sungguhan. Kalau 9router
    menolak, laporkan; jangan diam-diam membuangnya. *Keputusan saya.*
- **Kesegaran:** isi dibaca dari disk saat permintaan dibangun, bukan disalin
  sekali. Kalau user mengubah template, model melihat versi baru. Untuk menjaga
  cache, isi hanya dibaca ulang bila mtime atau ukuran berubah.
- **Sub-agent** tidak mewarisi referensi induk (sama dengan rencana). Brief
  `task` tetap tempatnya. Prompt koordinator mengingatkan untuk menyebut path
  referensi di brief.
- **TUI:** referensi aktif terlihat di layar bersama rencana, supaya user tahu
  apa yang sedang dipegang model.

### Batasan kode

- `erasableSyntaxOnly`: tanpa `enum` dan tanpa parameter properties.
- String UI dalam bahasa Inggris, komentar kode dalam Bahasa Indonesia.
- `src/extension.ts` dan `EXTENSION_API` tidak disentuh. Kalau ternyata harus
  disentuh, berhenti dan tanyakan.
- `config.schema.json` diregenerasi (`npm run schema`).

## Pengujian (pin perilaku yang mudah rusak diam-diam)

- Pemicu C dan D: giliran yang berakhir dengan `:` atau `<tool_call>` memicu
  lanjutan. Giliran yang berakhir dengan `?` atau memanggil `question` tidak.
- Rem tanpa kemajuan: dua lanjutan tanpa tool call menghentikan rangkaian.
- Esc di tengah rangkaian menghentikan giliran berjalan dan memastikan tidak ada
  giliran lanjutan yang mulai.
- **"Yang diukur bukan yang dikirim":** ambang pemadatan yang dipakai pemicu
  `auto-compact` sama dengan yang dipakai `doctor`/notice. Pasangan referensi
  yang dihitung `projectedContext` sama dengan yang benar-benar dikirim.
- Pasangan referensi ada di permintaan setelah pemadatan, tengah giliran
  maupun antar giliran.
- `contextWindow` dideklarasikan tanpa `turnTokens`: plafon 200, tidak ada
  anggaran turunan.

## Pengukuran (wajib per AGENTS.md: perilaku di bawah model)

- **Sebelum:** jalankan Lampiran A pada DB sekarang dan simpan angkanya.
- **Sesudah:** satu tugas tetap, yaitu *"bangun web app X dari folder template
  ./template"* di repo uji, dijalankan dengan `9router/ant` dan
  `9router/gapis`. Catat:
  - jumlah intervensi user sampai selesai (target 0),
  - jumlah lanjutan otomatis dan pemicunya,
  - total token,
  - kemiripan dengan template, berupa penilaian manual berdampingan:
    screenshot template vs hasil.
- Ulangi minimal 3 kali per model, karena satu kali bukan bukti.

## Rollout

- Ubah config user: `continueTurns` dihapus atau dinaikkan,
  `contextWindow` dikembalikan ke angka asli, `compaction.target` diset ke
  angka fokus yang selama ini dipakai (131072). Ini dilakukan dengan
  persetujuan user, bukan oleh migrasi.
- Catat di `CHANGELOG.md` bahwa default `continueTurns` berubah arti.

## Diserahkan ke builder

- Nama kunci untuk ambang pemadatan per model.
- Skema penyimpanan referensi (kolom vs tabel).
- Nilai N pengingat rencana dan ambang "tanpa kemajuan", setelah diukur.
- Apakah giliran yang gagal karena error provider *transient* (setelah retry
  habis) ikut dilanjutkan. Default desain ini: tidak.

## Lampiran A: skrip pengukuran

Kelompokkan pesan user yang cocok dengan
`^(lanjut(kan)?|next|continue|teruskan|go on|ya)\.?$` berdasarkan keadaan
pesan assistant sebelumnya:

- ada `error`,
- jumlah part `tool` ≥ 39,
- teks terakhir berakhir dengan `:`,
- teks terakhir memuat `<tool_call>`.

Skrip satu file dengan `node:sqlite`, read-only, terhadap `titah.db`.
Simpan di `scripts/` agar bisa diulang untuk pengukuran sesudah.
