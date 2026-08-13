# Benchmark & gap: Titah vs opencode vs Claude Code

Revisi 3, 2026-08-13 malam, terhadap `main` @ `e7d82ad`.

Pembanding adalah biner yang **benar-benar terpasang di mesin ini**, bukan angka
dari catatan rilis: **opencode 1.18.4** dan **Claude Code 2.1.229**.

> Revisi 2 pagi ini menulis 749 test, 21 tool, 6 sumbu izin. Ketiganya sudah
> berubah. Yang lebih penting, revisi ini menambahkan hal yang tidak ada
> sebelumnya: **angka yang diukur**, bukan hanya tabel fitur.

## Cara mengukurnya, dan batasnya

| Yang diukur | Caranya |
|---|---|
| Tool & izin Titah | `allTools()` dan `Permission.shape` dievaluasi langsung |
| Tool & izin opencode | `opencode debug agent build` — peta JSON apa adanya |
| Permukaan CLI | `--help` ketiganya |
| Waktu start | 7 kali jalan, diambil yang **tercepat** |
| Ukuran terpasang | `du -sk` pada direktori instalasi |

**Yang tidak bisa saya ukur, dan tidak saya karang:** daftar tool Claude Code
tidak bisa dibaca dari luar seperti opencode. Angkanya (~17) berasal dari nama
yang terlihat di biner, jadi ia **perkiraan** dan saya tandai begitu.

Waktu start diambil yang tercepat, bukan rata-rata, karena yang dicari adalah
biaya minimum jalur itu — rata-rata di mesin yang sedang sibuk mengukur mesinnya,
bukan programnya.

---

## 1. Angka yang diukur

### Waktu start (ms, terbaik dari 7)

| Perintah | Titah | opencode | Claude Code |
|---|---|---|---|
| `--version` | 220 | 487 | **117** |
| `--help` | 221 | 502 | 224 |

Claude Code start **~2×** lebih cepat dari Titah pada `--version`; opencode
**2,2×** lebih lambat dari Titah. Titah membayar biaya start Node plus muat
`node:sqlite`; Claude Code adalah build native.

Ini bukan angka yang menentukan pengalaman harian — TUI dibuka sekali lalu
dipakai berjam-jam — tapi ia menentukan biaya `titah run` di dalam skrip dan CI,
tempat prosesnya lahir dan mati per pemanggilan.

### Ukuran terpasang

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Di disk | **80 MB** | 132 MB | 281 MB |
| Rinciannya | `dist/` 1,8 MB + `node_modules/` 78 MB | biner tunggal | bundel versi |

Titah paling ringan, dan hampir seluruhnya adalah dependensi, bukan kodenya
sendiri.

### Ukuran kode dan uji

| | Titah |
|---|---|
| Baris `src/` | 18.508 |
| Test lulus | **846** |
| Test dua pembanding | tidak publik |

846 test membuktikan **kodenya** berperilaku sesuai spesifikasi. Tidak satu pun
membuktikan **agent-nya menyelesaikan tugas** — itu butuh eval harness, dan
Titah tidak punya. Lihat §8.

---

## 2. Tool: 22 vs 12 vs ~17

**Titah — 22, terbaca dari `allTools()`:**
`bash bash_output bash_start bash_stop diagnostics edit exit_plan glob grep list
memory move patch plan question read remove skill task webfetch websearch write`

**opencode — 12, terbaca dari `opencode debug agent build`:**
`bash edit glob grep invalid question read skill task todowrite webfetch write`

**Claude Code — ~17, perkiraan dari nama di biner.**

| Kemampuan | Titah | opencode | Claude Code |
|---|---|---|---|
| Baca berkas | `read` | `read` | `Read` |
| Daftar direktori | **`list`** | — | — |
| Cari nama / isi | `glob` `grep` | `glob` `grep` | `Glob` `Grep` |
| Sunting satu tempat | `edit` | `edit` | `Edit` |
| Sunting banyak, atomik | **`patch`** | — | `MultiEdit`¹ |
| Tulis berkas | `write` | `write` | `Write` |
| Pindah berkas | **`move`** | — | — |
| Hapus berkas | **`remove`** | — | — |
| Shell | `bash` | `bash` | `Bash` |
| Proses latar | `bash_start` `bash_output` `bash_stop` | **—** | `Bash --bg` `BashOutput` `KillShell` |
| Pemeriksa atas permintaan | **`diagnostics`** | — | — |
| LSP otomatis tiap suntingan | ✅ | ✅ | ekstensi IDE |
| Formatter otomatis | **❌** | ✅ | ekstensi IDE |
| Web fetch | `webfetch` | `webfetch` | `WebFetch` |
| Web search | **`websearch`** | **—** | `WebSearch` |
| Sub-agent | `task` | `task` | `Task` |
| Skill | `skill` **dua ekosistem** | `skill` | `Skill` |
| Rencana | **`plan`** di luar transkrip | `todowrite` di transkrip | `TodoWrite` di transkrip |
| Memori lintas sesi | **`memory`** | — | — |
| Bertanya balik | `question` | `question` | `AskUserQuestion` |
| Notebook | ❌ | ❌ | **`NotebookEdit`** |
| Gambar / PDF | **❌** | ✅ | ✅ |

¹ terlihat di biner; mungkin warisan.

**Hanya Titah:** `list` `patch` `move` `remove` `diagnostics`, rencana yang tahan
pemadatan, memori lintas sesi.
**Hanya pembanding:** `NotebookEdit`, formatter otomatis, gambar/PDF.

---

## 3. Izin: 10 sumbu vs 7 vs pola per-tool

**Titah — 10 kunci di `Permission.shape`:**
`edit write bash network delete mcp external_directory doom_loop allowlist rules`

**opencode — 7, dari peta agent-nya:**
`* read question doom_loop external_directory plan_enter plan_exit`

**Claude Code — per tool berpola:** `Bash(git *)`, `Edit`, `WebFetch(domain:…)`.

Bentuknya berbeda, bukan cuma jumlahnya. Titah memberi izin per **kelas
tindakan**, opencode per **tool + kondisi**, Claude Code per **tool berpola**.

Yang berubah sejak revisi 2: Titah **mengambil dua sumbu opencode**
(`external_directory`, `doom_loop`) dan **satu bentuk Claude Code**
(`rules` berpola, dengan pemeriksaan per-segmen rantai bash). Gap izin yang
sebelumnya nyata sekarang **tertutup di kedua arah**.

Yang masih hanya milik Titah: **`delete` sebagai kelas tersendiri** (menghapus
bukan menulis — `write: allow` tidak pernah berarti boleh menghapus berkas orang)
dan **`network` sebagai satu sakelar** yang berarti "tidak ada apa pun yang
keluar dari mesin ini". Claude Code lebih halus per-domain, tapi tidak punya
sakelar tunggal itu.

---

## 4. Konteks: jarak terjauh, dan Titah di depan

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Pemadatan otomatis | ✅ | ✅ | ✅ `--autocompact` |
| Pemadatan **di tengah giliran** | ✅ | tidak terdokumentasi | tidak terdokumentasi |
| Prompt peringkas ikut dibatasi | ✅ | — | — |
| Mengukur request yang **dirakit** | ✅ satu definisi kirim & ukur | — | — |
| Rencana tahan pemadatan | ✅ tabel `plan` | ❌ | ❌ |
| Memori lintas sesi | ✅ tabel `memory`, kunci **proyek** | ❌ | ❌ |
| Urutan sadar-cache, dipaku test | ✅ | — | — |
| Prompt caching | ✅ | ✅ | ✅ |

Yang membedakan bukan fiturnya, melainkan **sifat strukturalnya**: `plan` dan
`memory` hidup di luar `model_message`, dan pemadatan tidak menyentuh tabel itu.
Ketidakterjangkauannya adalah sifat skema, bukan aturan yang harus diingat orang.

Catatan jujur: auto-compaction dua pembanding **lebih matang secara pemakaian**.
Yang bisa diklaim Titah bukan "lebih baik dipakai", melainkan "alasannya bisa
diperiksa".

---

## 5. MCP: ada, belum setara

| | Titah | opencode | Claude Code |
|---|---|---|---|
| stdio | ✅ | ✅ | ✅ |
| HTTP / SSE | **❌** | ✅ | ✅ |
| OAuth | **❌** | ✅ | ✅ |
| `tools` | ✅ | ✅ | ✅ |
| `resources` / `prompts` | **❌** | ✅ | ✅ |
| Sumbu izin khusus MCP | **✅ `mcp`** | lewat peta per-tool | per-tool |
| Manajemen dari CLI | ❌ | `opencode mcp` | `claude mcp` |

Titah menutup kasus yang paling sering — server stdio yang menawarkan tool — dan
itu bentuk hampir semua server MCP yang dipasang orang. Yang belum: server
remote, dan dua kapabilitas lain.

---

## 6. Ekstensibilitas: gap yang paling belum tersentuh

| | Titah | opencode | Claude Code |
|---|---|---|---|
| MCP | ✅ stdio | ✅ penuh | ✅ penuh |
| Plugin | **❌** | ✅ modul npm | ✅ + marketplace |
| Hooks | **❌** | lewat plugin | ✅ |
| Skill | ✅ **dua ekosistem** | miliknya sendiri | miliknya sendiri |
| Impor config agent lain | ❌ | ❌ | ✅ `claude import` |

MCP menutup jalur **tool** pihak ketiga. Yang belum tertutup adalah penyesuaian
**perilaku**: menjalankan formatter setelah tiap `write`, memblok `edit` pada
berkas tertentu, mencatat tiap tool call. Di Titah semuanya masih berarti fork.

---

## 7. Jangkauan operasional: tertinggal paling jauh

Terbaca langsung dari `--help` ketiganya.

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Sub-command | 17 | 21 | 13 + opsi sangat banyak |
| Server headless | `serve` **tanpa auth** | `serve` | — |
| Antarmuka web | ❌ | `web` + mDNS | claude.ai/code |
| Tertanam di editor | ❌ | `acp` (Zed dll) | VS Code / JetBrains |
| Jalan di mesin lain | ❌ | ❌ | `--bg`, `agents` |
| GitHub | ❌ | `github`, `pr <n>` | ✅ |
| Statistik / export | ❌ | `stats` `export` `import` | `/cost` `/usage` |
| Telemetri enterprise | ❌ | OpenTelemetry | `gateway` |
| Review multi-agent | **`/consensus`** | ❌ | `ultrareview` (cloud) |
| Delegasi ke CLI agent lain | **✅ `@claude` `@opencode`** | ❌ | ❌ |
| Akun / SSO | ✅ device flow | ✅ | ✅ |
| Penjelas izin | **✅ `permission explain`** | ❌ | `auto-mode` |

`titah serve --hostname 0.0.0.0` memberi siapa pun di jaringan sebuah API yang
bisa menjalankan `bash`, **tanpa token**. Ini satu-satunya kekurangan di seluruh
dokumen ini yang bisa **merugikan** user, bukan sekadar membatasinya.

---

## 8. Gap Titah, berurut menurut dampaknya

1. **Gambar dan PDF.** Diverifikasi lagi hari ini: tidak ada jalur mana pun yang
   mengirim gambar ke model. Tidak bisa menempel screenshot UI yang rusak, tidak
   bisa membaca PDF spesifikasi. **Gap fungsional terbesar.**
2. **Auth pada `serve`.** Diverifikasi: tidak ada pemeriksaan token sama sekali
   di `src/server/`. Satu-satunya yang merugikan, bukan sekadar membatasi.
3. **Hooks / plugin.** Diverifikasi: tidak ada di skema config. Menutup jalur
   perilaku, sementara MCP hanya menutup jalur tool.
4. **MCP remote** (HTTP/SSE + OAuth) dan `resources`/`prompts`.
5. **Formatter otomatis.** Diverifikasi: tidak ada. LSP sudah masuk, formatter
   belum; opencode punya keduanya.
6. **Waktu start 220 ms.** Tidak terasa di TUI, terasa di skrip dan CI. Claude
   Code 117 ms karena native.
7. **Notebook**, `temperature`/`top_p` per agent, retry terkonfigurasi.
8. **Eval harness.** 846 test menguji kode, bukan kemampuan agent. Tidak ada
   SWE-bench, tidak ada suite tugas. Ini gap **metodologis**: tanpa itu, klaim
   "lebih baik" untuk kualitas jawaban tidak punya dasar sama sekali.
9. **Kematangan pemakaian.** v0.1.0, satu orang. Tidak bisa dikejar dengan kode.

## 9. Gap pembanding terhadap Titah

**opencode tidak punya:** `list` `patch` `move` `remove` `diagnostics`
`websearch`, proses latar, memori lintas sesi, rencana tahan pemadatan, sumbu
`delete`/`network`, delegasi ke CLI agent lain, skill dua ekosistem,
`permission explain`. Juga **paling lambat start** (487 ms, 2,2× Titah).

**Claude Code tidak punya:** `list` `patch` `move` `remove` `diagnostics`,
memori lintas sesi, rencana tahan pemadatan, `delete`/`network`/`mcp` sebagai
kelas izin, delegasi ke agent lain, skill dua ekosistem. Juga **paling besar di
disk** (281 MB, 3,5× Titah).

---

## 10. Rumusan

Untuk **satu orang, satu repo, sesi panjang**, Titah unggul dalam hal yang bisa
diukur dari dalam: **tool terbanyak** (22 vs 12 vs ~17), **sumbu izin terbanyak
dan paling jujur per kelas tindakan** (10), **manajemen konteks yang tidak ada
padanannya**, dan **paling ringan di disk** (80 MB).

Yang memisahkannya bukan lagi kemampuan inti. Tiga hal yang tersisa lebih
membosankan dan semuanya bisa ditambal: **input multimodal**, **keamanan
operasional**, **penyesuaian tanpa fork**.

Dua hal yang **tidak** bisa ditambal dengan menulis fitur:

- **Bukti kualitas.** Tidak ada eval harness. 846 test membuktikan kode
  berperilaku sesuai spesifikasi, bukan bahwa jawabannya lebih baik. Selama itu
  belum ada, setiap klaim keunggulan di dokumen ini hanya berlaku untuk
  **kemampuan yang tersedia**, bukan untuk **hasil kerjanya**.
- **Kematangan pemakaian.** Ribuan orang tiap hari menemukan hal yang tidak
  ditemukan satu orang, sebanyak apa pun test-nya.
