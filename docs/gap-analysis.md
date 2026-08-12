# Apa yang kurang dari Titah sebagai AI agent

Ditulis 2026-08-11, terhadap `main` @ `b334908`.
Gate saat analisis ini dibuat: `npm run typecheck` bersih, `npm run build` bersih,
`npm test` **511/511 lulus**.

**Diperbarui 2026-08-12** terhadap `main` @ `b6100bf` — typecheck bersih,
`npm test` **606/606 lulus**, `src/` 11.553 baris (dari 10.425). Butir 1 dan 2
tutup, diverifikasi ulang ke source dan bukan disimpulkan dari catatan commit.
Sisanya masih terbuka: nol kecocokan untuk `maxRetries`, `mcp`, `cacheControl`,
sistem hook, dan `background` di `tool/bash.ts`. Satu temuan baru masuk sebagai
butir 10b, dan urutan rekomendasi di bawah ikut berubah karena dua teratasnya
sudah selesai.

Dokumen ini bukan daftar keinginan. Tiap butir menyebut berkas dan barisnya, dan
kenapa ketiadaannya terasa saat agent dipakai untuk kerja panjang — bukan saat
demo.

## Yang sudah ada

Supaya kekurangannya terbaca proporsional. Titah sudah punya lapisan yang
biasanya paling lama dibangun: loop tool-calling multi-step, sembilan tool
(`read` `list` `glob` `grep` `edit` `write` `bash` `skill` `task`), mesin izin
tiga sumbu dengan override per-agent, snapshot lewat shadow git repo plus
`/undo`, arsitektur klien/server SSE, sesi persisten per folder, skill aktif/pasif
yang kompatibel dengan registry Claude Code dan opencode, delegasi ke CLI
eksternal, dan sub-agent paralel dengan penjadwalan reader/writer.

Yang kurang hampir semuanya ada di **lapisan di atasnya**: bertahan lama,
menjangkau lebih jauh, dan bisa diperluas tanpa mengubah source.

---

## Tier 1 — yang membuat Titah gagal pada tugas panjang

Empat butir ini satu tema: Titah kuat untuk giliran pendek, dan rapuh begitu
tugasnya berjam-jam. Inilah pembeda paling nyata dengan Claude Code.

Dua dari empat sudah tutup per 2026-08-12. Yang tersisa di tier ini adalah butir
3 dan 4.

### 1. Tidak ada auto-compaction, dan tidak ada anggaran konteks — **TUTUP**

> Ditutup 2026-08-12. `src/core/auto-compact.ts` (11 KB) sekarang memegang
> orkestrasinya, `compaction.{auto,reserved,tailTurns,prune}` ada di config, dan
> jendela konteks dideklarasikan per model — tidak pernah ditebak, karena
> menebak ke atas berarti provider memotong diam-diam. Pemadatan juga berjalan
> di tengah giliran lewat `prepareStep`, bukan cuma di antara giliran.
>
> Yang mahal ternyata bukan meringkasnya, melainkan **akuntansinya**. Empat
> ronde review adversarial menghasilkan 20 temuan, dan diagnosis yang berulang
> di tiap ronde sama: temuan paling serius selalu berupa batas atau kredit yang
> memercayai angka yang dihitung di tempat lain. Rinciannya di
> `docs/superpowers/specs/2026-08-12-compaction-hardening-design.md`.
>
> Teks di bawah dipertahankan sebagai catatan keadaan sebelumnya.

`src/core/compact.ts` tidak mengandung satu pun kata `token`, `threshold`, atau
`auto`. Ringkasan hanya jalan lewat `/compact` manual (`src/core/agent.ts:706`).
Tidak ada tempat yang tahu berapa persen jendela konteks sudah terpakai.

Akibatnya sesi panjang tidak dipangkas — ia **mati** dengan error
context-length dari provider, di tengah pekerjaan, dan giliran itu hilang. User
harus menebak sendiri kapan mengetik `/compact`, dan tebakannya baru terbukti
salah setelah rusak.

Ini kekurangan nomor satu. Semua sisanya bisa dihindari; yang ini tidak.

### 2. `MAX_STEPS = 20` dipatok mati, dan diamnya menyesatkan — **TUTUP**

> Ditutup 2026-08-12. `agent.steps` bisa disetel per agent, dan `MAX_STEPS`
> tinggal jadi bawaan: `const maxSteps = agentDef?.steps ?? MAX_STEPS`
> (`src/core/agent.ts:461`). Batasnya juga tidak lagi diam — `lastStep`
> (`:491`) memaksa jawaban teks saat langkah terakhir tercapai, jadi pesan yang
> menyalahkan model itu tidak muncul lagi untuk sebab yang keliru.
>
> Teks di bawah dipertahankan sebagai catatan keadaan sebelumnya.

`src/core/agent.ts:51` dan `:342`. Tidak ada override per-agent, tidak ada di
config, dan **tidak ada satu pun tempat yang memeriksa apakah batas itu
tercapai** — `stopWhen: stepCountIs(MAX_STEPS)` sekadar menyudahi stream.

Ada konsekuensi konkret yang bisa saya tunjuk. Kalau step ke-20 kebetulan
berakhir pada tool call tanpa teks, blok di `src/core/agent.ts:406-410` menyala
dan user membaca:

> *the model stopped without giving a text answer — try again, or use a different model with --model*

Padahal modelnya baik-baik saja; ia kehabisan langkah. Saran "ganti model" itu
salah arah, dan user akan menuruti sarannya karena tidak ada informasi lain.
Refactor 30-berkas akan berhenti di tengah dengan pesan yang menyalahkan pihak
yang keliru.

### 3. Retry tidak pernah dikonfigurasi

Tidak ada `maxRetries` di seluruh `src/`. Yang berlaku adalah default AI SDK,
yaitu 2 percobaan, tanpa backoff yang kita kendalikan dan tanpa pembedaan antara
429 (layak diulang, tunggu) dan 400 (percuma diulang).

Untuk chat, dua percobaan cukup. Untuk agent yang jalan 40 menit lalu kena
`overloaded_error`, itu artinya seluruh giliran mati dan snapshot terakhir jadi
satu-satunya penyelamat.

### 4. `bash` tidak bisa menjalankan apa pun yang hidup lebih lama dari satu panggilan

`src/core/tool/bash.ts`: `spawn` per panggilan, timeout default 120 detik, maksimum
600 detik (`:5-7`), lalu `SIGKILL`. Tidak ada mode background, tidak ada shell
persisten, tidak ada cwd yang bertahan antar panggilan, tidak ada cara membaca
output proses yang masih berjalan.

Artinya agent **tidak bisa** menyalakan dev server lalu mengetesnya, tidak bisa
menonton `tsc --watch`, tidak bisa menjalankan build 15 menit. Untuk agent coding
ini melumpuhkan satu kelas tugas utuh: apa pun yang butuh proses hidup di satu
sisi sementara ia bekerja di sisi lain.

---

## Tier 2 — jangkauan: apa yang bisa disentuh agent

### 5. Tidak ada MCP, sama sekali

Nol kecocokan untuk `mcp` di seluruh `src/`. Claude Code dan opencode dua-duanya
klien MCP, dan MCP sudah jadi cara standar tool pihak ketiga masuk ke agent —
database, issue tracker, browser, API internal.

Ini gap ekosistem terbesar Titah. Yang menarik: bentuknya **sudah ada di rumah**.
`src/core/delegate/` sudah subprocess dengan protokol dan adapter; klien MCP
stdio adalah barang yang sama dengan pesan berbeda. Ini perluasan, bukan
pekerjaan dari nol.

### 6. Tidak ada tool web

Tidak ada fetch, tidak ada search. Agent tidak bisa membaca dokumentasi library
yang sedang dipakai, tidak bisa memeriksa changelog sebelum menaikkan versi,
tidak bisa mencari pesan error yang tidak dikenalnya. Ia hanya tahu apa yang ada
di dalam repo dan apa yang ada di bobot modelnya — yang punya tanggal kedaluwarsa.

### 7. Input hanya teks

`src/core/tool/read.ts:40` menolak berkas biner, dan tidak ada jalur mana pun yang
mengirim gambar ke model. Tidak bisa menempel screenshot UI yang rusak, tidak
bisa memberi foto diagram, tidak bisa membaca PDF spesifikasi. Untuk kerja
frontend ini terasa tiap hari.

### 8. Tidak ada diagnostics setelah edit

Tidak ada LSP, tidak ada integrasi tsc/eslint. Setelah `edit`, tidak ada apa pun
yang memberi tahu model bahwa ia baru saja membuat type error — ia harus
kebetulan ingat menjalankan `npm run typecheck`, dan sering tidak.

Ini penyebab pola yang sudah Anda lihat sendiri: perubahan terlihat benar, suite
hijau, rusaknya baru ketahuan belakangan.

---

## Tier 3 — kontrol dan ekstensi

### 9. Tidak ada hooks

Tidak ada hook system. User tidak punya cara menjalankan formatter setelah tiap
`write`, memblok `edit` pada berkas tertentu, mencatat tiap tool call, atau
menolak commit yang melanggar aturan — tanpa mengubah source Titah.

Ini juga pembeda besar terhadap Claude Code, dan sifatnya berlipat: satu hook
system membuka puluhan penyesuaian yang tidak perlu kita antisipasi satu per satu.

### 10. Izin hanya tiga sumbu

`src/core/schema.ts:175-185`: `edit`, `write`, `bash`, plus allowlist. Tidak ada
sumbu untuk memanggil sub-agent (`task`), untuk delegasi ke CLI eksternal, atau
untuk jaringan.

Konsekuensinya sudah terasa di fitur yang baru selesai: agent dengan `bash:
allow` tetap bisa menjalankan `claude -p` sendiri, jadi batas "agent ini tidak
boleh memakai langganan berbayar saya" tidak bisa dinyatakan. Dan begitu tool web
atau MCP masuk (butir 5 dan 6), model izin ini akan kekurangan sumbu justru pada
hal yang paling perlu dibatasi.

### 10b. Dan satu-satunya sumbu yang bisa diperhalus, tidak memperhalus apa pun

Ditemukan 2026-08-12, saat menyusun allowlist untuk config sungguhan.

Yang dicocokkan ke allowlist **bukan perintahnya**, melainkan `"<kata-pertama> *"`
— `allowlistPattern` di `src/core/tool/bash.ts:28` mengambil kata pertama lalu
menempelkan ` *`. Dicocokkan oleh `matchesPattern` (`src/core/permission.ts:134`)
yang menerjemahkan `*` menjadi `.*`.

Dua akibatnya, keduanya diverifikasi terhadap kode hasil build:

```
TANYA  pola="git status*"  perintah="git status"                     → dicocokkan ke "git *"
IZIN   pola="git *"        perintah="git status && rm -rf ~/penting" → dicocokkan ke "git *"
```

Baris pertama: pola setingkat sub-perintah **tidak pernah cocok dengan apa pun**.
Ia tidak ditolak, tidak diperingatkan — ia hanya tidak pernah menyala. User yang
menulis `"git status*"` percaya sudah mengizinkan sesuatu yang sempit, padahal
tidak mengizinkan apa-apa, dan satu-satunya gejalanya adalah dialog izin yang
tetap muncul.

Baris kedua lebih serius: pola yang **cocok** memberi izin ke seluruh executable
beserta apa pun yang dirantai di belakangnya, karena hanya kata pertama yang
pernah diperiksa. Komentar di `bash.ts:24-26` berbunyi *"bukan izin buta untuk
seluruh shell"* — rantai `&&` membatalkan maksud itu.

Pembandingnya menunjukkan ini memang bisa dilakukan dengan benar: Claude Code
menerima pola yang bentuknya persis sama, `--allowedTools "Bash(git *)"`, tapi
memeriksa perintah yang dirantai alih-alih berhenti di kata pertama.

Ini beda jenis dari butir 10. Butir 10 adalah sumbu yang belum ada — user tahu
ia tidak punya. Yang ini adalah sumbu yang ada dan berperilaku lebih longgar
daripada yang dijanjikan bentuknya sendiri, dan itu lebih buruk daripada
ketiadaan.

### 11. Agent tidak ditemukan dari registry mana pun

Skill dibaca dari `~/.claude` dan `~/.config/opencode` (`src/core/skill-sources.ts`),
agent tidak — agent hanya dari `titah.json`. Itu keputusan sadar dan alasannya
sah: agent membawa `permission`, yaitu izin terhadap mesin, dan mengimpornya
diam-diam berbahaya.

Tapi harga keputusan itu nyata, dan Anda sudah membayarnya: 13 agent yang sudah
ada harus disalin ulang dengan tangan. Jalan tengahnya belum ada — misalnya baca
definisinya, tapi masuk dengan izin paling ketat sampai user menyetujuinya
sekali.

### 12. Tidak ada tempat menaruh rencana yang bertahan lintas step

Tidak ada tool todo/plan. Untuk tugas 20 langkah, satu-satunya ingatan model
adalah transkrip — yang persis akan diringkas oleh compaction. Rencananya ikut
teringkas dan sebagian hilang.

Efeknya khas dan mudah dikenali: langkah yang sudah selesai dikerjakan ulang,
langkah yang belum dilewati diam-diam.

### 13. Prompt caching Anthropic tidak dipakai

`src/core/provider.ts:92-103` membuat klien Anthropic tanpa menyetel
`cacheControl` di mana pun. System prompt Titah tidak kecil — instruksi proyek,
katalog skill, roster agent — dan seluruhnya dibayar ulang tiap giliran.

Ini murni soal biaya, bukan kemampuan, tapi ini juga butir termurah di seluruh
daftar ini.

---

## Tier 4 — operasional

### 14. Server tanpa autentikasi

`src/server/index.ts:269` menerima hostname apa pun; default `127.0.0.1`
(`src/cli.ts:162`) aman. Tapi tidak ada token sama sekali, jadi
`titah serve --hostname 0.0.0.0` memberi siapa pun di jaringan itu API yang bisa
menjalankan `bash`. Tidak ada yang memperingatkan.

### 15. Tidak ada cara mengukur apakah agent-nya membaik

Tidak ada eval harness, tidak ada telemetry. 511 test membuktikan kodenya
berperilaku sesuai spesifikasi; tidak ada satu pun yang membuktikan **agent-nya
menyelesaikan tugas**. Setiap perubahan pada system prompt, deskripsi tool, atau
penjadwalan sub-agent saat ini dinilai dengan kesan, bukan angka.

---

## Kalau harus memilih

**Urutan asli (2026-08-11).** Dua teratasnya sudah selesai; disimpan supaya
alasan pemilihannya bisa dinilai belakangan.

1. ~~Auto-compaction + anggaran konteks (butir 1)~~ — selesai.
2. ~~Batas langkah: bisa diatur, dan bicara saat tercapai (butir 2)~~ — selesai.
3. **Bash background/persisten** (butir 4). Membuka satu kelas tugas utuh yang
   sekarang mustahil.
4. **MCP** (butir 5). Pekerjaan paling besar, hasil paling luas, dan fondasinya
   sudah ada di `delegate/`.
5. **Hooks** (butir 9). Setelah ini, sebagian permintaan penyesuaian bisa
   dijawab user sendiri tanpa menunggu rilis.

Butir 13 (prompt caching) di luar urutan — kerjakan kapan saja, biayanya sejam
dan hasilnya langsung terasa di tagihan.

**Urutan yang berlaku sekarang (2026-08-12).** Berubah karena dua teratas tutup,
dan karena dua hal terukur muncul saat Titah dipakai dengan config sungguhan:

1. **Perbaiki pencocokan allowlist** (butir 10b). Naik ke nomor satu bukan
   karena besar, tapi karena ini satu-satunya butir yang membuat Titah **kurang
   aman daripada yang dijanjikan configny sendiri**. Semua butir lain adalah
   ketiadaan yang jujur; yang ini janji yang tidak ditepati.
2. **Prompt caching Anthropic** (butir 13). Keluar dari "di luar urutan" dan
   masuk ke nomor dua, karena sekarang ada angkanya: prompt kosong dengan 29
   skill terdaftar sudah memakan **6120 token input** sebelum satu berkas pun
   dibaca. Tiap giliran membayar itu ulang.
3. **Bash background/persisten** (butir 4). Tidak berubah alasannya.
4. **Tempat menaruh rencana yang bertahan lintas step** (butir 12, dan issue #5
   yang desainnya sudah ada). **Naik**, dan justru *karena* butir 1 tutup:
   sekarang transkrip memang benar-benar diringkas, jadi rencana yang cuma hidup
   di transkrip memang akan hilang. Dulu ini risiko teoretis; sekarang ini
   konsekuensi langsung dari fitur yang baru dipasang.
5. **MCP** (butir 5). Tetap terbesar, tetap terakhir dari yang berbobot.

Yang turun: hooks (butir 9). Bukan karena kurang berguna, tapi karena empat di
atasnya sekarang punya bukti pemakaian dan hooks belum.

## Yang sengaja TIDAK saya masukkan

Bukan kekurangan, melainkan keputusan desain yang menurut saya benar:

- **Kedalaman sub-agent satu tingkat.** Batas ini mencegah ledakan biaya dan
  membuat penjadwalan writer bisa dipahami. Menambah kedalaman menambah masalah,
  bukan kemampuan.
- **`@claude` / `@opencode` dipicu user, bukan model.** Itu batas biaya, dan
  batas biaya memang milik user.
- **`mode` default `"primary"`.** Lebih ketat dari opencode, dan itu tepat:
  `build-auto` mengizinkan segalanya.
- **Tidak ada batas langkah per-agent.** Ini masuk butir 2 sebagai bagian dari
  perbaikan yang sama, bukan sebagai fitur terpisah.
