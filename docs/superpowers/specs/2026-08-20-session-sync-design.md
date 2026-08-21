# Session sync: transkrip naik, tapi hanya yang aman dan hanya kalau diminta dua kali

Design, 2026-08-20. Baseline: `main` @ `836361e`, 1263 test hijau.

Lanjutan dari [heartbeat](./2026-08-20-cli-heartbeat-design.md), yang menutup
project dan analytics. Ini menutup transkrip sesi.

## Kelas risikonya berbeda, dan itu menentukan seluruh desain

Heartbeat mengirim metadata: nama folder, bahasa, angka. Yang ini mengirim
**isi percakapan** — dan percakapan agent koding memuat kode, path, dan apa pun
yang sempat dibaca agent.

Jadi pertanyaannya bukan "bagaimana mengunggah transkrip", melainkan **bagian
mana dari transkrip yang boleh keluar dari mesin ini sama sekali.**

## Apa yang naik

Viewer server merender `{ role, content, timestamp }` sebagai teks datar, jadi
`parts` diratakan:

| Part | Jadi |
|---|---|
| `text` | teksnya |
| `tool` | satu baris `▸ <nama>` |
| `reasoning` | dibuang |

### ❌ Keluaran tool, dan kenapa tidak

Di situlah rahasia tinggal. `read .env`, `bash env`, `grep -r password`,
`read ~/.aws/credentials` — semuanya panggilan yang wajar dalam pekerjaan yang
wajar, dan hasilnya masuk transkrip.

Menyaringnya otomatis bukan pilihan. Penyaring rahasia yang bisa diandalkan
tidak ada; yang ada adalah penyaring yang menangkap `AKIA…` lalu melewatkan
token internal perusahaan, dan hasilnya lebih buruk daripada tidak menyaring
karena ia menghasilkan rasa aman.

Yang hilang dengan tidak mengunggahnya nyata: transkrip di dashboard tidak
menceritakan apa yang agent baca. Yang tidak hilang: **sesi lokalnya tetap
utuh.** Dashboard adalah tampilan, bukan catatan induk.

### ❌ Argumen tool, dan kenapa juga tidak

Lebih halus, dan tetap tidak. `edit` membawa `oldString` dan `newString` — itu
kode. `write` membawa seluruh isi berkas. Sebuah baris `▸ edit` mengatakan
bahwa sesuatu disunting; `▸ edit  src/auth.ts  "SECRET_KEY=…" → …` mengatakan
apa isinya.

### ❌ `reasoning`

Bukan karena ukurannya. Titah sengaja memisahkannya dari `text` karena "`text`
adalah jawaban, ini jalan menuju jawaban". Yang paling panjang dan paling tidak
pernah dibaca ulang adalah kandidat terburuk untuk dikirim keluar mesin.

### ✅ Yang tersisa

Prompt yang kamu tulis, jawaban yang model berikan, dan urutan tool yang dipakai
di antaranya. Cukup untuk menjawab "apa yang saya minta dan apa yang ia jawab",
yang memang satu-satunya hal yang orang buka dashboard untuk melihat.

## Batas ukuran

Per pesan **32 KB** — angka yang sudah dipakai Titah sebagai ambang keluaran
tool. Satu angka, bukan dua yang bisa menyimpang.

Total payload **512 KB**. Kalau lewat, pesan **tertua** dibuang dan satu pesan
penanda disisipkan menyebut berapa banyak yang hilang.

Yang dibuang harus DISEBUT. Transkrip yang dipotong diam-diam terlihat lengkap,
dan orang akan menyimpulkan sesuatu dari percakapan yang ternyata bukan
seluruhnya.

## Tiga gerbang, semuanya harus lolos

```jsonc
{ "tracking": { "enabled": true, "sync": false } }
```

1. Warisan heartbeat: sudah login, `enabled` nyala, path tidak di-`exclude`
2. `tracking.sync: true` di config **lokal**
3. `sync_enabled: true` di **server**

### Kenapa dua-duanya, bukan cukup satu

Sakelar di dashboard adalah **kebijakan jarak jauh**. Siapa pun yang masuk ke
akunmu bisa menyalakannya; ia tidak bisa menyunting berkas config di mesinmu.
Satu sakelar jarak jauh yang bisa mulai mengunggah kode adalah bentuk yang salah
untuk keputusan sebesar itu.

Ini alasan yang sama persis dengan `external_directory`, yang sengaja dinilai
saat config DIMUAT dan bukan saat runtime: batas struktural tidak boleh jadi
pertanyaan runtime, karena itu menukar jaminan dengan kebijakan.

### Kenapa bawaannya `false`, padahal heartbeat `true`

Argumen heartbeat adalah "login itu sendiri yang jadi opt-in". Argumen itu
**tidak** merentang sampai ke sini. Login adalah persetujuan untuk dihitung,
bukan persetujuan untuk dibaca.

## Kapan

Menempel di heartbeat yang sudah ada. Responsnya sudah mengembalikan
`sync_enabled` — jadi tidak ada request tambahan untuk mencari tahu, dan tidak
ada percobaan yang berakhir 403 tiap giliran.

Nilainya disimpan di tabel `tracking` lewat **entri migrasi baru** yang
`ALTER TABLE`. Entri yang membuat tabelnya sudah dijalankan mesin yang memakai
0.2.0+, jadi menyuntingnya tidak akan berpengaruh apa pun di sana — dan itu
justru aturan yang sudah ditulis di `db.ts`: migrasi DITAMBAHKAN DI UJUNG.

Unggahannya replace penuh (server `update_or_create` by `session_id`), jadi sesi
yang tumbuh aman diunggah ulang, dan debounce 5 menit ikut gratis.

Hanya sesi **top-level**. Sesi sub-agent punya barisnya sendiri secara lokal;
mengunggahnya memunculkan baris dashboard yang tidak diminta siapa pun.

### Batas yang perlu disebut

Hanya sesi yang mendapat giliran **sesudah** sync dinyalakan yang naik. Sesi lama
tidak akan muncul kecuali dikerjakan lagi.

Tidak ada backfill, dan itu disengaja: 23 sesi terunggah sekaligus pada giliran
pertama sesudah seseorang menyalakan satu sakelar adalah kejutan yang arahnya
salah.

## Sisi server: satu migrasi yang wajib

`Session.session_id` adalah `CharField(max_length=36)`. Id sesi Titah adalah
`ses_` + UUID = **40 karakter**. Postgres menolaknya, dan kegagalannya baru
terlihat pada unggahan sungguhan yang pertama.

Dilebarkan ke 64. ❌ Memotong prefiks `ses_` supaya pas 36 adalah arah yang
salah: idnya adalah idnya, dan id yang dipotong tidak lagi cocok dengan apa pun
yang bisa dicari user di mesinnya sendiri.

## Kalau gagal

Senyap, aturan yang sama dengan heartbeat: tidak ada apa pun ke stdout maupun
stderr, satu baris ke `~/.config/titah/tracking.log`.

`403 sync_disabled` ditangani khusus — ia **mematikan flag lokal**, supaya tidak
mencoba lagi setiap giliran sampai heartbeat berikutnya mengabarkan sebaliknya.
Server adalah pemegang kebenaran untuk sakelarnya sendiri.

## Tes

- transkrip tidak memuat argumen maupun keluaran tool, hanya nama
- `reasoning` tidak pernah ikut
- tiga gerbang: masing-masing gagal sendiri mematikan sync
- `sync: true` lokal tanpa server tidak mengirim; server tanpa lokal juga tidak
- batas per-pesan memotong, dan batas total membuang yang tertua SERTA
  menyisipkan penanda yang menyebut jumlahnya
- sesi anak tidak diunggah
- id 40 karakter diterima server
- 403 mematikan flag yang tersimpan
- respons heartbeat yang bilang `sync_enabled: true` tersimpan
- tetap tidak menulis sebyte pun ke stdout/stderr

## File

| File | Perubahan |
|---|---|
| `src/core/tracking.ts` | transkrip, gerbang ketiga, unggahan |
| `src/core/schema.ts` | `tracking.sync` |
| `src/core/storage/db.ts` | satu entri migrasi `ALTER TABLE` |
| `src/cli.ts` | baris sync di bagian doctor |
| `test/tracking.test.ts` | diperluas |
| titah-web `apps/tracking/models.py` + migrasi | `session_id` 36 → 64 |
| README, docs titah-web | menyusul |
