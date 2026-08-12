# Dari 10 tool ke 20: roster bawaan Titah

Design, 2026-08-12. Baseline: `main` @ `35235c2`, 658 test hijau.

Menjawab permintaan "tambahkan hingga 20 tool bawaan, sekalian web fetch/search",
dan sekaligus menutup butir 4, 6, 8, 10, 16, dan 17 di `docs/gap-analysis.md`.

## Aturan yang saya pakai untuk memilih

Bukan "apa lagi yang bisa ditambah", melainkan **tool mana yang ketiadaannya
sudah tercatat sebagai kekurangan**. Setiap baris di bawah menunjuk butir gap
yang sudah ditulis sebelum permintaan ini ada, supaya rosternya tidak jadi daftar
keinginan yang dirasionalkan belakangan.

Tiga hal yang saya TOLAK meski muat di angka 20:

- **`multiedit`** — `patch` sudah mengerjakannya. Dua tool untuk satu pekerjaan
  berarti model harus memilih, dan pilihan yang tidak penting tetap memakan
  langkah.
- **`todowrite`** — `plan` sudah ada, dan ia disimpan di tempat yang selamat dari
  pemadatan. Tool todo kedua yang isinya hidup di transkrip justru mengajari
  model kebiasaan yang salah.
- **`tree`** — `list` plus `glob` sudah menutupinya, dan output pohon adalah
  salah satu penghasil token terbesar yang paling sedikit isinya.

## Roster

Sepuluh yang sudah ada: `read` `list` `glob` `grep` `edit` `write` `bash`
`skill` `task` `plan`.

Sepuluh yang ditambahkan:

| Tool | Menutup | Kenapa |
|---|---|---|
| `webfetch` | gap 6 | Agent tidak bisa membaca dokumentasi library yang sedang ia pakai |
| `websearch` | gap 6 | Tidak bisa mencari pesan error yang tidak dikenalnya |
| `question` | gap 16 | Menemui ambiguitas, model hanya bisa menebak — opencode punya jalan ketiga |
| `patch` | gap 17 | Sepuluh edit kecil = sepuluh giliran izin dan sepuluh putaran model |
| `move` | — | Rename lewat `bash` berarti membuka seluruh shell untuk satu operasi |
| `remove` | — | Sama, dan lebih berbahaya |
| `bash_start` | gap 4 | Tidak bisa menyalakan dev server lalu mengetesnya |
| `bash_output` | gap 4 | Proses hidup tanpa cara membaca keluarannya tidak ada gunanya |
| `bash_stop` | gap 4 | Proses hidup tanpa cara menghentikannya adalah kebocoran |
| `diagnostics` | gap 8 | Setelah `edit`, tidak ada yang memberi tahu model ia baru membuat type error |

## Dua sumbu izin baru

Gap 10 memperingatkan hal ini sebelum tool-nya ada: *"begitu tool web atau MCP
masuk, model izin ini akan kekurangan sumbu justru pada hal yang paling perlu
dibatasi."* Menambahkan tool web di atas tiga sumbu yang ada berarti mewujudkan
peringatan itu, jadi sumbunya ditambah lebih dulu.

- **`network`** — `webfetch`, `websearch`. Ini satu-satunya kelas tool yang
  mengirim isi repo ke luar mesin. Ia butuh sumbunya sendiri bukan karena
  berbahaya bagi berkas, tapi karena berbahaya bagi **kerahasiaan**, dan tidak
  satu pun sumbu yang ada menyatakan itu.
- **`delete`** — `remove`. Menghapus bukan menulis. Agent dengan `write: allow`
  yang dimaksudkan untuk "boleh membuat berkas baru" tidak pernah dimaksudkan
  untuk "boleh menghapus berkas saya".

`move` sengaja TIDAK memakai `delete`: ia menolak menimpa tujuan yang sudah ada,
jadi tidak ada yang hilang. Dengan aturan itu ia cukup di `write`.

Bawaan keduanya `ask`, sama seperti tiga yang sudah ada.

## `websearch`: backend yang bisa diganti, dan kenapa

Tidak ada mesin pencari yang bisa dipakai tanpa syarat. Karena itu backend-nya
dinyatakan di config, dengan tiga pilihan dan satu bawaan yang jalan tanpa kunci:

```jsonc
"search": {
  "backend": "ddg",              // "ddg" | "brave" | "tavily"
  "apiKey": "${env:BRAVE_KEY}"   // hanya untuk brave/tavily
}
```

`ddg` memakai endpoint HTML DuckDuckGo dan **tidak butuh kunci**. Ia juga yang
paling rapuh: ia mengurai HTML orang lain, dan HTML itu boleh berubah kapan saja.
Itu ditulis apa adanya di deskripsi tool dan di `titah doctor`, bukan disembunyikan
— backend yang diam-diam berhenti bekerja lebih buruk daripada backend yang
menyatakan dirinya rapuh.

## `webfetch`: tiga batas, semuanya keras

- **Ukuran.** Respons dipotong pada batas byte, dan potongannya DIBERITAHUKAN.
- **Waktu.** Timeout, karena giliran yang menggantung karena satu URL lambat
  adalah kegagalan yang tidak bisa dibedakan dari model yang macet.
- **Alamat.** Skema hanya `http`/`https`. `file:`, `ftp:`, dan `data:` ditolak —
  `file:` khususnya, karena ia jalan pintas melewati `resolveInside` yang menjaga
  seluruh tool berkas tetap di dalam cwd.

HTML diubah jadi teks sebelum dikirim ke model. Halaman dokumentasi yang mentah
sebagian besar isinya adalah `<script>` dan atribut kelas, dan itu dibayar penuh
oleh jendela konteks.

**Alamat privat TIDAK diblokir.** Agent coding memang perlu memeriksa dev
server-nya sendiri di `localhost`, dan memblokirnya berarti mematikan salah satu
kegunaan utamanya. Yang menjaga bukan daftar blokir alamat, melainkan sumbu
`network` di atas: user yang tidak mau ada permintaan keluar sama sekali menyetel
`network: "deny"`, dan itu pernyataan yang jauh lebih jelas daripada heuristik
rentang IP.

## `bash_start` / `bash_output` / `bash_stop`

Tiga tool, bukan satu dengan mode, karena izinnya berbeda: menyalakan proses
adalah `bash`, membaca keluarannya bukan apa-apa, dan menghentikannya juga bukan
apa-apa. Satu tool bermode akan memaksa ketiganya memakai sumbu yang paling ketat.

Output disangga di memori dengan batas cincin: proses yang mencetak selamanya
tidak boleh menghabiskan RAM, dan yang dibuang adalah yang paling LAMA — pada
log, yang baru hampir selalu yang dicari, kebalikan dari berkas.

**Koreksi terhadap rencana ini, ditemukan saat mengerjakan.** Paragraf ini
semula berbunyi "hidup selama sesi, dan dibunuh saat sesi berakhir". Itu tidak
bisa dibangun: tidak ada satu pun pemanggil `clearSession` di `src/` — sesi tidak
punya hook pengakhiran sama sekali, hanya test yang memanggilnya.

Jadi yang sebenarnya: proses hidup selama **proses Titah**, dan dibunuh lewat
`process.on("exit")`. Yang mencegah kebocoran di dalam satu sesi panjang adalah
batas jumlah (delapan proses hidup per sesi) plus `bash_stop`, bukan pembersihan
otomatis. Menulis "per sesi" dan membangun "per proses" akan membuat pembaca
berikutnya mencari kode pembersihan yang tidak pernah ada.

## `diagnostics`

Menjalankan perintah yang **user nyatakan** di config, bukan yang ditebak Titah:

```jsonc
"diagnostics": { "command": "npm run typecheck" }
```

Tanpa itu tool-nya melapor bahwa ia belum dikonfigurasi, bukan menebak-nebak
`tsc` lalu gagal dengan cara yang membingungkan. Ini aturan yang sama dengan
`contextWindow`: angka atau perintah yang tidak dinyatakan tidak pernah ditebak.

## Urutan pengerjaan

Tiga fase, tiap fase satu PR yang berdiri sendiri dengan gate-nya sendiri.

1. **Sumbu `network` + `webfetch` + `websearch`.** Yang diminta eksplisit, dan
   sumbunya harus mendarat lebih dulu supaya tool web tidak pernah ada tanpa
   kendalinya.
2. **`question` + `patch` + `move` + `remove` + sumbu `delete`.**
3. **`bash_start` / `bash_output` / `bash_stop` + `diagnostics`.**

Fase 1 lebih dulu karena ia satu-satunya yang mengubah bentuk izin, dan dua fase
sesudahnya lebih mudah dibaca kalau bentuk itu sudah tetap.

## Hasil, dicatat setelah dikerjakan

**Fase 1 dan 3 selesai penuh; fase 2 selesai kecuali `question`.** Yang mendarat:
`webfetch` `websearch` `patch` `move` `remove` `bash_start` `bash_output`
`bash_stop` `diagnostics` — sembilan dari sepuluh, jadi **19 tool bawaan**, bukan
20.

Dua penyesuaian terhadap rencana di atas, keduanya dibuat saat mengerjakannya:

- **Sumbu `delete` ikut mendarat di fase 1**, bukan fase 2 seperti tertulis.
  Bentuk izin lebih baik berubah sekali daripada dua kali, dan mode `plan`
  membutuhkannya untuk menepati janjinya sebelum `remove` ada.
- **`question` tidak jadi dikerjakan**, dan ini bukan kehabisan waktu melainkan
  keputusan yang berbeda dari asumsi rencana ini. Sembilan tool lain adalah
  fungsi murni plus I/O: mereka selesai di dalam `execute`. `question` tidak — ia
  harus BERHENTI di tengah dan menunggu manusia mengetik. Mesin izin sudah punya
  bentuk itu (`ask()` menerbitkan event lalu menunggu `respond`), tapi jawabannya
  bertipe tiga pilihan tetap: `once`, `always`, `reject`.

  Membuat `question` berarti kanal kedua dengan jawaban BEBAS: event baru,
  route server baru, dan penanganan input di TUI. Yang terakhir bukan tempelan —
  TUI harus tahu bahwa ia sedang dalam keadaan "sedang ditanya" dan mengarahkan
  ketikan ke sana, bukan ke prompt.

  Memaksanya masuk lewat dialog izin yang ada akan menghasilkan `question` yang
  cuma bisa ya/tidak, sementara kegunaannya yang disebut gap 16 justru
  disambiguasi: *"dua berkas cocok dengan deskripsi Anda, yang mana?"* Tool
  bernama `question` yang tidak bisa menanyakan pertanyaan itu lebih buruk
  daripada tidak ada — ia menutup butirnya di atas kertas dan membiarkan
  masalahnya hidup.

Jadi angka 20 dicapai dengan `question`, dan `question` adalah pekerjaan TUI,
bukan pekerjaan tool.
