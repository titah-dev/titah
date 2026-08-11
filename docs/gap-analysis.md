# Apa yang kurang dari Titah sebagai AI agent

Ditulis 2026-08-11, terhadap `main` @ `b334908`.
Gate saat analisis ini dibuat: `npm run typecheck` bersih, `npm run build` bersih,
`npm test` **511/511 lulus**.

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

### 1. Tidak ada auto-compaction, dan tidak ada anggaran konteks

`src/core/compact.ts` tidak mengandung satu pun kata `token`, `threshold`, atau
`auto`. Ringkasan hanya jalan lewat `/compact` manual (`src/core/agent.ts:706`).
Tidak ada tempat yang tahu berapa persen jendela konteks sudah terpakai.

Akibatnya sesi panjang tidak dipangkas — ia **mati** dengan error
context-length dari provider, di tengah pekerjaan, dan giliran itu hilang. User
harus menebak sendiri kapan mengetik `/compact`, dan tebakannya baru terbukti
salah setelah rusak.

Ini kekurangan nomor satu. Semua sisanya bisa dihindari; yang ini tidak.

### 2. `MAX_STEPS = 20` dipatok mati, dan diamnya menyesatkan

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

Urutan yang saya rekomendasikan, dan alasannya bukan "yang paling mudah":

1. **Auto-compaction + anggaran konteks** (butir 1). Satu-satunya butir yang
   membuat Titah gagal dengan cara yang tidak bisa dihindari user.
2. **Batas langkah: bisa diatur, dan bicara saat tercapai** (butir 2). Kecil,
   dan menghapus pesan error yang aktif menyesatkan.
3. **Bash background/persisten** (butir 4). Membuka satu kelas tugas utuh yang
   sekarang mustahil.
4. **MCP** (butir 5). Pekerjaan paling besar, hasil paling luas, dan fondasinya
   sudah ada di `delegate/`.
5. **Hooks** (butir 9). Setelah ini, sebagian permintaan penyesuaian bisa
   dijawab user sendiri tanpa menunggu rilis.

Butir 13 (prompt caching) di luar urutan — kerjakan kapan saja, biayanya sejam
dan hasilnya langsung terasa di tagihan.

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
