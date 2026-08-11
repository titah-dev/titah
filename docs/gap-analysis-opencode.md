# Titah vs opencode — kekurangan tambahan

Lanjutan dari [`gap-analysis.md`](./gap-analysis.md). Dokumen itu menilai Titah
sendirian: apa yang membuatnya gagal pada tugas panjang. Dokumen ini menilainya
terhadap pembanding terdekat.

## Cara saya membandingkan

Bukan dari ingatan. Sumbernya tiga, semuanya bisa Anda periksa ulang:

- **opencode 1.18.16** yang terpasang di `~/.opencode/bin/opencode` — permukaan
  CLI-nya saya baca dari `--help` tiap subcommand.
- **Skema config resminya**, `https://opencode.ai/config.json` — 36 properti
  top-level, lengkap dengan deskripsi tiap field.
- **Daftar tool** yang saya tarik dari string di dalam binernya, bukan ditebak.

Pembanding Titah: `main` @ `b334908`, 511 test hijau, 10.425 baris `src/`.

Satu catatan supaya angkanya terbaca adil: opencode di versi 1.18 dengan tim di
belakangnya; Titah di 0.1.0 dan ditulis satu orang. Daftar panjang di bawah ini
wajar. Yang penting bukan panjangnya, melainkan butir mana yang mengubah **apa
yang bisa dikerjakan**, bukan sekadar seberapa rapi konfigurasinya.

---

## Peta besar

| | Titah | opencode |
|---|---|---|
| Properti config top-level | 12 | 32 (+4 deprecated) |
| Tool | 9 | 15 |
| Sumbu izin | 3 (`edit` `write` `bash`) | 15, plus per-pola |
| Batas langkah | `MAX_STEPS = 20`, mati | `steps` per-agent |
| Kedalaman sub-agent | 1, mati | `subagent_depth`, default 1 |
| Compaction | manual (`/compact`) | otomatis + prune + tuning |
| MCP | — | lokal, remote, OAuth |
| LSP / formatter | — | ada, bisa dikonfigurasi |
| Plugin | — | modul npm |
| Delegasi ke CLI agent lain | **`@claude`, `@opencode`, `delegate:`** | — |
| Fan-out lintas agent eksternal | **`/consensus`** | — |
| Skill dari registry Claude Code | **ya** | — |

Dua baris tebal di bawah adalah tempat Titah unggul, dan keduanya bukan
kebetulan — itu memang alasan Titah dibuat.

---

## Tool: 9 lawan 15

Titah punya `read` `list` `glob` `grep` `edit` `write` `bash` `skill` `task`.
opencode punya semuanya plus enam berikut.

### 16. `question` — model tidak bisa bertanya balik

opencode punya tool `question` dengan sumbu izinnya sendiri. Modelnya boleh
berhenti di tengah kerja dan bertanya: *"dua berkas cocok dengan deskripsi Anda,
yang mana?"*

Titah tidak punya jalur itu sama sekali. Model yang menemui ambiguitas hanya
punya dua pilihan: menebak, atau berhenti dan mengarang jawaban tekstual yang
berharap dibaca user. Untuk agent otonom yang jalan lama, ini penyebab langsung
seluruh kelas kegagalan "ia mengerjakan hal yang salah dengan sangat rajin".

Ini butir favorit saya di seluruh daftar: kecil, dan mengubah karakter agent.

### 17. `patch` — edit banyak potongan dalam satu panggilan

`src/core/tool/edit.ts` menerima satu `oldString` per panggilan. Refactor yang
menyentuh 6 berkas berarti minimal 6 giliran tool, masing-masing satu
round-trip ke provider, masing-masing satu langkah dari jatah 20 (butir 2 di
dokumen pertama). Dua batasan ini saling memperburuk.

### 18. `todowrite` — sudah saya sebut sebagai butir 12

Perbandingan ini menambah satu hal: di opencode ia punya sumbu izin sendiri, jadi
memang diperlakukan sebagai tool kelas satu, bukan tempelan.

### 19. `webfetch` dan `websearch` — butir 6 di dokumen pertama

Sekarang dengan pembanding: di opencode keduanya tool terpisah dengan izin
terpisah, bukan satu tool web serba bisa.

### 20. `batch` — menjalankan beberapa tool call dalam satu langkah

Eksperimental di opencode (`experimental.batch_tool`). Menariknya, Titah sudah
punya paralelisme yang lebih ambisius di tingkat sub-agent (`task`) — yang kurang
justru versi murahnya untuk tool biasa.

---

## Izin: 3 sumbu lawan 15

Ini kesenjangan yang paling saya tidak duga sebelum memeriksa skemanya.

opencode: `read` `edit` `glob` `grep` `list` `bash` `task` `external_directory`
`todowrite` `question` `webfetch` `websearch` `lsp` `doom_loop` `skill`, plus
`additionalProperties` sehingga tiap tool MCP dapat sumbunya sendiri.

Titah: `edit` `write` `bash` + `allowlist`.

### 21. Tidak ada izin untuk `task`, `skill`, atau delegasi

Ini melanjutkan butir 10 dokumen pertama, sekarang dengan bukti bahwa pembanding
langsungnya memang sudah punya. Konsekuensi paling nyata di Titah: tidak ada cara
menyatakan *"agent ini tidak boleh membelanjakan langganan Claude saya."*

### 22. Izin tidak bisa per-pola, kecuali untuk bash

`PermissionRuleConfig` opencode menerima objek `{pola: aksi}` untuk hampir semua
sumbu — jadi `{"edit": {"src/**": "allow", "*.env": "deny"}}` bisa dinyatakan.

Titah punya `allowlist`, tapi hanya untuk perintah bash. Tidak ada cara bilang
"boleh edit apa pun di `src/`, jangan sentuh `.env`". Yang ada cuma satu saklar
untuk seluruh pohon berkas.

### 23. Batas direktori tidak punya pintu keluar

Ini nuansa, dan arahnya dua-duanya.

Titah punya `resolveInside()` (`src/core/tool/types.ts`, dipakai `read.ts:26`,
`write.ts:34`, `edit.ts:48`) — batas keras di cwd. Defaultnya **lebih ketat**
dari opencode, dan itu bagus.

Tapi opencode punya sumbu `external_directory` yang bisa ditanya ke user, dan
`references` untuk menamai repo git atau folder lain sebagai konteks. Titah tidak
punya keduanya, jadi kerja lintas-repo — "porting perbaikan ini dari repo
sebelah" — **mustahil**, bukan sekadar merepotkan. Batas kerasnya tidak punya
kunci.

---

## Ekstensi: satu-satunya jalan ke Titah adalah fork

### 24. Sistem plugin

opencode punya `plugin` di config dan `opencode plugin <module>` untuk
memasangnya dari npm. Plugin bisa menambah tool, hook, dan provider. Anda sendiri
punya satu di `~/.config/opencode/plugins/petdex.js`.

Ini butir 9 (hooks) yang diperbesar. Titah tidak punya **permukaan ekstensi apa
pun**: setiap penyesuaian berarti mengubah source dan menunggu rilis. Untuk
proyek satu orang, ini justru argumen terkuat — sistem plugin memindahkan
pekerjaan penyesuaian ke user, dan itu persis yang dibutuhkan proyek yang
pengembangnya satu.

### 25. MCP dengan tiga transport dan OAuth

Butir 5 dokumen pertama, sekarang berukuran. opencode punya `McpLocalConfig`
(stdio, dengan `cwd`/`environment`/`timeout`), `McpRemoteConfig` (HTTP, dengan
`headers`), dan `McpOAuthConfig` — termasuk dynamic client registration RFC 7591
dan server callback lokal. Ditambah subcommand `mcp add/list/auth/logout/debug`.

Jadi "tambahkan MCP" bukan satu pekerjaan. Yang realistis untuk Titah: stdio
lokal dulu, karena itu yang bentuknya sudah mirip `src/core/delegate/`.

### 26. Skill dari URL

`skills.urls` opencode menarik skill dari `https://…/.well-known/skills/`. Titah
membaca folder lokal saja. Kecil, tapi ini yang membuat skill bisa dibagikan
tanpa menyuruh orang meng-clone repo.

---

## Kualitas hasil: tempat opencode diam-diam unggul

### 27. LSP dan formatter berjalan otomatis

Butir 8 dokumen pertama, sekarang dengan bentuk konkretnya. opencode punya `lsp`
dan `formatter` di config: server bawaan yang menyala sendiri, bisa
ditambah/dimatikan per bahasa, dengan `command`, `extensions`, `env`,
`initialization`.

Artinya di opencode, model **diberi tahu** kalau baru saja membuat type error,
dan hasil editnya diformat sebelum dilihat. Di Titah, model harus ingat
menjalankan `npm run typecheck` sendiri, dan hasilnya masuk apa adanya.

### 28. Deteksi loop (`doom_loop`)

opencode punya sumbu izin bernama `doom_loop` — ia mendeteksi model yang berputar
mengulangi tindakan yang sama. Titah hanya punya `MAX_STEPS = 20`, yang bukan
deteksi loop melainkan pemutus arus: ia berhenti sama saja apakah model sedang
berputar atau sedang bekerja dengan baik.

### 29. Output tool yang meluap disimpan, bukan dibuang

`src/core/tool/bash.ts:107` memotong di 256 KB dan menulis
`[output truncated at 262144 bytes]`. **Kelebihannya hilang.** Kalau `npm test`
verbose meluap, kegagalan yang Anda cari bisa persis ada di bagian yang dibuang,
dan tidak ada cara mengambilnya.

opencode (`tool_output.max_lines` / `max_bytes`) menulis teks penuhnya ke
direktori truncation dan mengembalikan pratinjau — jadi model bisa membaca
sisanya kalau perlu.

Ini murah dan langsung terasa.

### 30. Compaction yang bisa disetel

Butir 1 dokumen pertama, sekarang dengan cetak biru yang sudah terbukti:
`compaction.auto` (default **true**), `prune` untuk membuang output tool lama,
`tail_turns` (default 2, dan `KEEP_TAIL` Titah sudah sebangun dengan ini),
`preserve_recent_tokens`, dan `reserved` — buffer token supaya proses
peringkasannya sendiri tidak ikut meluap.

`reserved` itu detail yang mudah terlewat kalau membangun dari nol: meringkas
butuh ruang konteks, dan kalau menunggu sampai benar-benar penuh, peringkasannya
gagal juga.

### 31. File watcher

`watcher.ignore` di opencode. Ia tahu kalau berkas berubah dari luar — editor
Anda, `git pull`, proses lain. Titah tidak punya watcher.

Untungnya `edit.ts:58` membaca ulang berkas sebelum mengganti, jadi tidak ada
edit yang menimpa perubahan orang lain secara diam-diam. Yang basi hanya konteks
model, dan itu terasa sebagai model yang berdebat soal isi berkas yang sudah
Anda ubah.

---

## Per-agent: yang tidak bisa disetel di Titah

### 32. Tanpa `temperature`, `top_p`, atau `steps` per agent

`AgentConfig` opencode punya `model` `variant` `temperature` `top_p` `prompt`
`description` `mode` `permission` `steps` `hidden` `color` `disable` `options`.

Titah punya `description` `mode` `prompt` `model` `tools` `permission`
`delegate`.

Yang hilang dan terasa:

- **`steps`** — batas langkah per agent. Ini yang membuat butir 2 dokumen pertama
  bisa dituntaskan: agent penjelajah cukup 5 langkah, agent refactor butuh 60,
  dan sekarang dua-duanya dipaksa ke 20. Deskripsi opencode juga menyebut
  perilaku yang benar saat batas tercapai: *"before forcing text-only response"* —
  paksa model menjawab dengan teks, jangan diamkan.
- **`temperature` / `top_p`** — tidak ada kendali sampling sama sekali di Titah.
  Agent reviewer tidak bisa dibuat deterministik.
- **`disable` / `hidden`** — tidak ada cara mematikan agent bawaan atau
  menyembunyikannya dari pelengkapan otomatis.

### 33. `subagent_depth` dipatok mati

Di dokumen pertama saya membela kedalaman satu tingkat, dan saya masih
membelanya — opencode pun **defaultnya 1**. Tapi di sana angkanya bisa diubah.

Jadi rumusan yang jujur: defaultnya benar, yang jadi kekurangan adalah tidak bisa
digeser. Beda antara keputusan desain dan angka yang tertanam di source.

---

## Operasional dan ekosistem

### 34. Server ACP

`opencode acp` menjalankan server Agent Client Protocol, sehingga opencode bisa
ditanam sebagai agent di dalam Zed dan editor lain.

Titah **mengonsumsi** antarmuka berbentuk ACP untuk memanggil agent lain
(`src/core/delegate/`) tapi tidak pernah **menyajikannya**. Ada ironi di situ:
proyek yang identitasnya "agent yang memanggil agent lain" adalah satu-satunya
dari ketiganya yang tidak bisa dipanggil sebagai agent.

### 35. Share, export, import, stats

- `share: manual | auto | disabled` — sesi jadi URL yang bisa dikirim.
- `opencode export/import` — sesi keluar-masuk sebagai JSON.
- `opencode stats` — statistik token dan biaya lintas sesi.

Titah punya `sessions list` dan `sessions prune`, dan menampilkan usage per sesi
di TUI. Tidak ada agregat, tidak ada ekspor, tidak ada berbagi. Untuk menunjukkan
transkrip ke rekan kerja, satu-satunya cara adalah membaca database SQLite.

### 36. Antarmuka web, mDNS, CORS

`opencode web` membuka UI browser; `--mdns` mengumumkan server di jaringan lokal;
`--cors` mengizinkan domain lain. Titah punya `attach` tapi TUI saja.

Yang paling relevan buat Anda: dengan `serve` + `attach` yang sudah ada, klien
web itu **pekerjaan klien saja**. Servernya sudah HTTP + SSE.

### 37. Integrasi GitHub

`opencode github` (agent GitHub) dan `opencode pr <number>` (ambil dan checkout
branch PR lalu jalankan). Titah tidak punya kesadaran git di luar shadow repo
untuk snapshot.

### 38. Auto-update, shell completion, `--continue`, fork sesi

Kelas kenyamanan: `opencode upgrade`, `opencode completion`, `--continue` untuk
melanjutkan sesi terakhir, `--fork` untuk mencabangkannya. Titah punya
`-s <id>` — Anda harus tahu id-nya.

`--fork` yang paling berguna dari empat ini: mencoba dua pendekatan dari titik
percakapan yang sama, tanpa merusak yang asli.

### 39. OpenTelemetry

`experimental.openTelemetry` opencode menyalakan span AI SDK. Ini butir 15
dokumen pertama dengan jalur yang sudah jelas — AI SDK v7 sudah punya
`experimental_telemetry`, dan Titah sudah memakai AI SDK v7.

---

## Di mana Titah unggul

Bukan basa-basi penyeimbang. Tiga hal ini tidak ada padanannya di opencode:

**Delegasi ke CLI agent lain sebagai warga kelas satu.** `@claude`, `@opencode`,
dan `delegate:` pada agent. opencode tidak bisa memakai Claude Code sebagai mesin
sub-agent-nya. Ini fitur pembeda Titah dan ia tetap utuh setelah semua
perbandingan di atas.

**`/consensus`.** Sebar satu pertanyaan ke seluruh agent eksternal, bandingkan
jawabannya. Tidak ada padanannya.

**Skill dari registry Claude Code.** Titah membaca `~/.claude` **dan**
`~/.config/opencode`. opencode membaca miliknya sendiri. Titah adalah satu-satunya
dari ketiganya yang menjalankan skill dua ekosistem tanpa konfigurasi.

Satu lagi, lebih halus: **default izinnya lebih ketat**. `resolveInside` adalah
batas keras, dan `mode` bawaan `"primary"` lebih ketat dari `"all"` milik
opencode. Titah memilih ketat lalu melonggarkan; opencode sebaliknya.

---

## Urutan yang saya rekomendasikan setelah perbandingan ini

Berubah dari dokumen pertama. Tiga hal menyodok naik.

1. **Auto-compaction** (butir 1 & 30). Tetap nomor satu, dan sekarang cetak
   birunya jelas: `auto`, `tail_turns`, `reserved`, `prune`.
2. **`steps` per-agent yang bicara saat tercapai** (butir 2 & 32). Kecil,
   menghapus pesan error yang menyesatkan, dan opencode sudah menunjukkan
   perilaku yang benar: paksa jawaban teks.
3. **Tool `question`** (butir 16). **Naik tajam.** Ini yang paling murah di
   seluruh daftar dan paling mengubah karakter agent — dari yang menebak jadi
   yang bertanya. Anda sudah punya seluruh infrastrukturnya: dialog izin di TUI
   adalah pertanyaan model ke user yang menunggu jawaban. Tool `question` adalah
   mekanisme yang sama dengan isi berbeda.
4. **Output tool meluap disimpan, bukan dibuang** (butir 29). Sejam kerja, dan
   berhenti membuang bukti kegagalan.
5. **Bash background/persisten** (butir 4 dokumen pertama). Membuka kelas tugas
   yang sekarang mustahil.
6. **Plugin atau hooks** (butir 24 & 9). Untuk proyek satu orang, ini yang
   memindahkan beban penyesuaian ke user.
7. **MCP stdio lokal** (butir 25). Terbesar, dan fondasinya sudah ada di
   `delegate/`. Kerjakan setelah ada permukaan plugin, supaya keduanya berbagi
   jalur pendaftaran tool yang sama.

Prompt caching Anthropic (butir 13 dokumen pertama) tetap di luar urutan —
kerjakan kapan saja.
