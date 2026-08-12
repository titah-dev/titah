# CAG dan MAG: dua cara memberi model konteks tanpa membayarnya berulang

Design + hasil, 2026-08-13. Baseline: `main` @ `5d41033`, 701 test hijau.

Menjawab permintaan: *"tambahkan di belakang layar caching augmented generation
dan memory augmented generation; penentuan kapan gunakan saya serahkan ke kamu,
buatkan kondisi kapan harus menggunakan konsep tersebut."*

Dokumen ini menjelaskan kedua konsepnya, alasan keduanya cocok untuk Titah
secara khusus, kondisi kapan masing-masing menyala, dan apa yang sengaja
**tidak** dilakukan.

---

## Kenapa keduanya sekeluarga

Tiga huruf terakhirnya sama karena masalahnya sama: **model tidak ingat apa
pun.** Setiap permintaan harus membawa seluruh konteks yang dibutuhkannya, dari
nol, setiap kali.

Ada tiga cara menjawab itu, dan ketiganya sering dianggap saling menggantikan
padahal tidak:

| | Yang dilakukan | Ongkosnya | Gagalnya bagaimana |
|---|---|---|---|
| **RAG** | Mengambil potongan relevan saat bertanya | Satu langkah pencarian tiap giliran | Salah ambil, dan yang hilang tidak meninggalkan jejak |
| **CAG** | Menaruh bahan stabil di depan, lalu memakai ulang perhitungannya | Nyaris nol setelah giliran pertama | Awalan berubah, cache meleset, dan tidak ada yang menyadarinya selain tagihan |
| **MAG** | Menyimpan fakta di luar percakapan, dibawa lagi tiap kali | Ruang konteks tetap | Fakta jadi basi dan model mempercayainya |

Titah memakai **CAG dan MAG**, dan **tidak** memakai RAG. Alasan menolak RAG ada
di bagian terakhir.

---

# CAG — Cache-Augmented Generation

## Konsepnya

Yang di-cache bukan teksnya, melainkan **hasil perhitungan attention atas teks
itu** — KV cache. Model tetap "membaca" seluruh konteks; yang dilewati adalah
menghitung ulang bagian yang sudah pernah dihitung.

Konsekuensinya satu, dan seluruh implementasi Titah adalah konsekuensi itu:

> Cache dikunci pada **awalan yang identik byte demi byte.** Satu karakter
> berubah di posisi 10, dan seluruh 50.000 token sesudahnya dihitung ulang.

Jadi CAG bukan fitur yang dinyalakan. Ia adalah **disiplin menyusun permintaan
dari yang paling jarang berubah ke yang paling sering.**

## Kenapa Titah butuh ini secara khusus

Prompt kosong Titah — tanpa satu berkas dibaca — sudah memakan **6.400 token**:
system prompt, katalog 29 skill, instruksi proyek, dan definisi 21 tool.
Semuanya identik di setiap giliran.

Pada sesi 40 giliran itu **256.000 token yang dibeli berulang untuk isi yang
tidak pernah berubah.** Roster tool yang bertambah dari 10 ke 21 justru
memperbesar angka itu, sehingga CAG makin diperlukan, bukan makin opsional.

## Urutan yang berlaku sekarang

```
system prompt + definisi tool   ← tidak pernah berubah dalam satu sesi
memori proyek                    ← berubah beberapa kali per proyek
ringkasan pemadatan              ← berubah saat pemadatan menyala
rencana                          ← berubah beberapa kali per giliran
ekor percakapan                  ← berubah tiap langkah
```

Urutan itu ditegakkan `requestShape` di `src/core/storage/session.ts` dan
dipaku test. Menukar memori dan rencana akan membuat setiap penulisan rencana
ikut membatalkan cache memori.

## Kondisi: kapan CAG dipakai

Otomatis, di `shouldCache` (`src/core/cag.ts`). Tiga syarat, semuanya harus
benar:

1. **Awalannya ≥ 1024 token.** Di bawah itu Anthropic menolak breakpoint, dan
   menandainya hanya menambah overhead.
2. **Sudah ada giliran kedua** (riwayat ≥ 2 pesan). Menulis cache lebih mahal
   daripada membacanya; kalau tidak akan dibaca ulang, itu rugi bersih.
3. **Providernya memahami penandaan.** Hanya `@ai-sdk/anthropic` yang menerima
   `cache_control`.

Kalau (1) dan (2) benar tapi (3) tidak — endpoint OpenAI-compatible — modenya
`prefix-only`: tidak ada yang ditandai, tapi urutan stabil→volatil tetap
ditegakkan, karena endpoint semacam itu umumnya punya prefix caching otomatis
di sisi server yang tetap bergantung pada awalan yang sama.

## Kondisi: kapan CAG TIDAK dipakai

- **Model lokal (ollama).** Tidak menagih token, jadi yang dihemat cuma waktu
  prefill — dan mengirim `cache_control` ke endpoint yang tidak memahaminya
  menukar penghematan nol dengan risiko permintaan ditolak.
- **Giliran pertama.** Lihat syarat 2.
- **Awalan kecil.** Lihat syarat 1.

## Di mana tanda cache diletakkan, dan satu kesalahan yang saya buat

Rancangan pertama memindahkan `system` menjadi pesan pertama di `messages`
supaya ia bisa membawa `cache_control` sendiri. **AI SDK v7 menolaknya:**
*"System messages are not allowed in the prompt or messages fields."*

Itu ditemukan oleh test sub-agent yang berubah merah, bukan oleh membaca
dokumentasi lebih teliti.

Ternyata pemindahan itu memang tidak perlu, dan penggantinya lebih sederhana:
`cache_control` menandai **ujung sebuah awalan**, bukan satu blok sendirian.
Segmen yang di-cache adalah semua yang **mendahului** tanda itu — termasuk
system prompt dan seluruh definisi tool, yang berada paling depan dan justru
tidak pernah bisa ditandai langsung.

Jadi satu tanda di tempat yang tepat mencakup persis bagian yang paling mahal:

- Ada blok terlindungi → tanda di ujungnya.
- Tidak ada → tanda pada **pesan pertama percakapan**. Ia stabil (tidak pernah
  berubah lagi setelah ditulis), dan tanpa tanda apa pun Anthropic tidak
  meng-cache apa pun — justru pada giliran awal ketika system prompt adalah
  hampir seluruh permintaan.

Ekor tidak pernah ditandai.

## Yang sengaja TIDAK dilakukan

**Tidak ada cache milik Titah sendiri.** Godaan menyimpan respons lalu
menyajikannya ulang saat prompt sama itu besar, dan keliru untuk agent: dua
prompt identik pada working tree yang berbeda adalah dua pertanyaan berbeda.
Yang di-cache hanya **perhitungan**, tidak pernah **jawaban**.

---

# MAG — Memory-Augmented Generation

## Konsepnya

Store di luar percakapan yang model tulis sendiri, dan yang dibawa kembali ke
konteks tanpa diminta. Bedanya dari sekadar "menyimpan riwayat": yang disimpan
adalah **kesimpulan**, bukan transkrip — dan kesimpulan tidak ikut diringkas
ketika transkripnya diringkas.

## Kenapa Titah butuh ini, setelah sudah punya `plan`

`plan` sudah menyelesaikan setengahnya: rencana bertahan melewati pemadatan.
Tapi ia **mati bersama sesinya**, dan itu memang benar untuk sebuah rencana.

Yang belum ada adalah fakta yang masih benar besok pagi:

- *"Suite ini butuh Node 22 karena memakai `node:sqlite`."*
- *"Backend codex di router itu tokennya kedaluwarsa, bukan salah kunci kita."*
- *"Migrasi harus ditambahkan di ujung array, tidak pernah disisipkan."*

Tidak satu pun ada di repo. Semuanya dipelajari dengan mahal — beberapa dengan
salah dulu — dan semuanya hilang begitu sesinya ditutup.

## Kondisi: kapan MAG dipakai

Sebuah fakta layak masuk memori kalau **ketiganya** benar:

1. **Masih benar di sesi lain.** Kalau hanya berlaku untuk pekerjaan yang sedang
   berjalan, itu `plan`.
2. **Tidak ada di repo.** Kalau jawabannya ada di kode, `read` dan `grep` yang
   menjawabnya — dan mereka selalu benar karena membaca keadaan sekarang.
   Menyalin isi repo ke memori adalah cara membuat dua sumber kebenaran, dan
   yang di memori akan basi lebih dulu.
3. **Mengubah tindakan.** Fakta yang benar tapi tidak pernah mengubah apa pun
   hanya memakan ruang konteks setiap giliran.

## Kondisi: kapan MAG TIDAK dipakai

- **Rencana dan langkah.** Itu `plan`.
- **Isi berkas, struktur direktori, nama simbol.** Itu `read`/`grep`/`glob`.
- **Preferensi yang sudah ada di `AGENTS.md`/`CLAUDE.md`.** Sudah dimuat tiap
  giliran; menyalinnya berarti membayarnya dua kali.
- **Apa pun yang sedang berubah.** Fakta tentang kode yang sedang di-refactor
  akan basi sebelum sesi berikutnya.

## Recall: eager, bukan retrieval — dan kenapa

MAG klasik memasang langkah pengambilan yang memilih fakta relevan. Titah
**tidak**: seluruh store dikirim, setiap permintaan.

Alasannya bukan kemalasan. Langkah pengambilan punya kualitasnya sendiri, dan
ketika ia salah pilih, **yang hilang adalah fakta yang justru dibutuhkan, tanpa
satu pun tanda bahwa ada yang hilang.** Itu kelas kegagalan yang sama dengan
ringkasan yang dipotong diam-diam — persis yang seluruh siklus pemadatan
dihabiskan untuk menutupnya.

Dengan batas 32 fakta, mengirim semuanya lebih murah daripada risiko itu. Kalau
suatu hari batasnya dinaikkan jauh, retrieval jadi masuk akal; pada ukuran ini,
tidak.

## Batasnya menolak, tidak menggeser

Fakta ke-33 **ditolak** dengan pesan yang menyuruh melupakan satu dulu. Ia tidak
menggeser yang paling lama, karena memori yang diam-diam membuang isinya sendiri
tidak bisa dipercaya — dan yang terbuang justru fakta paling awal, yang biasanya
paling mendasar.

---

## Kenapa RAG ditolak

RAG akan berarti: indeks isi repo, cari potongan relevan tiap giliran, tempelkan.

Titah sudah punya sesuatu yang mengerjakan itu lebih baik, dan namanya `grep`.
Pencarian yang dijalankan **model** dengan pola yang ia pilih sendiri, atas
keadaan repo **sekarang**, mengalahkan indeks yang dibangun kemarin dan
dicocokkan lewat kemiripan vektor — untuk kode, di mana nama yang tepat lebih
berarti daripada makna yang mirip.

Indeks juga punya masalah yang tidak dimiliki `grep`: ia bisa basi tanpa
memberi tahu siapa pun.

---

## Hasil

| | Sebelum | Sesudah |
|---|---|---|
| Tool | 19 | **21** (`memory`, `question`) |
| Ongkos awalan stabil | dibayar penuh tiap giliran | ditandai untuk cache, diurutkan stabil→volatil |
| Fakta lintas sesi | tidak ada | tabel `memory`, 32 fakta per proyek |
| Model bertanya balik | tidak bisa | `question`, kanal berjawaban bebas |

Gate: typecheck bersih, **730/730 lulus** (dari 701).

Satu catatan kejujuran: **penghematan CAG belum saya ukur ujung-ke-ujung.**
Yang terbukti adalah bentuk permintaannya benar dan deterministik — itu yang
ada di tangan Titah. Angka cache-hit sesungguhnya datang dari provider, dan
untuk membacanya butuh sesi Anthropic panjang yang belum dijalankan. Menyebut
persentase penghematan sekarang berarti mengarang.
