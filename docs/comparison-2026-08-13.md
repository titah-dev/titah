# Titah vs opencode vs Claude Code — gap ketiganya, terinci

Revisi 2, 2026-08-13 malam, terhadap `main` @ `c862ee0`: typecheck bersih,
**749/749 test lulus**, `src/` 15.656 baris, **21 tool bawaan + tool dari server
MCP**, **6 sumbu izin**.

> Revisi 1 (siang ini) menulis *"MCP adalah gap terbesar Titah"*. Itu sudah tidak
> berlaku — MCP mendarat sore ini lewat #17. Petanya berubah cukup banyak
> sehingga dokumen ini ditulis ulang, bukan ditambal.

Pembanding, keduanya yang benar-benar terpasang di mesin ini:
**opencode 1.18.4** dan **Claude Code 2.1.228**.

## Cara mengukurnya

- **opencode** — `opencode debug agent build`, yang mencetak peta `tools` dan
  `permission` apa adanya. Otoritatif, bukan tebakan dari string di biner.
- **Claude Code** — nama tool dicari di biner `2.1.228`, permukaan CLI dari
  `claude --help`.
- **Titah** — `allTools()` dan `Permission.shape` dievaluasi langsung.

---

## 1. Angka besarnya

| | Titah 0.1.0 | opencode 1.18.4 | Claude Code 2.1.228 |
|---|---|---|---|
| Tool bawaan | **21** | 12 | ~17 |
| Tool pihak ketiga | ✅ MCP stdio | ✅ MCP 3 transport | ✅ MCP |
| Sumbu izin | **6** kelas | 7 + peta per-tool | per-tool berpola |
| Properti config | 18 | ~32 | settings.json + CLI |

---

## 2. Tool, per kemampuan

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
| Proses latar | **`bash_start` `bash_output` `bash_stop`** | — | `Bash --bg` `BashOutput` `KillShell` |
| Pemeriksa: perintah user | **`diagnostics`** | — | — |
| Pemeriksa: LSP otomatis | **✅ setelah tiap suntingan** | ✅ | ekstensi IDE |
| Formatter otomatis | ❌ | **✅** | ekstensi IDE |
| Web fetch / search | `webfetch` `websearch` | `webfetch` saja | `WebFetch` `WebSearch` |
| Sub-agent | `task` | `task` | `Task` |
| Skill | `skill` (dua ekosistem) | `skill` | `Skill` |
| Rencana | **`plan`** — di luar transkrip | `todowrite` — di transkrip | `TodoWrite` — di transkrip |
| Memori lintas sesi | **`memory`** | — | — |
| Bertanya balik | `question` | `question` | `AskUserQuestion` |
| Notebook | ❌ | ❌ | **`NotebookEdit`** |
| Gambar / PDF | ❌ | **✅** | **✅** |

¹ ada di biner, mungkin warisan.

**Yang hanya dimiliki Titah:** `list`, `patch`, `move`, `remove`, `diagnostics`,
`plan` yang tahan pemadatan, `memory`.

**Yang hanya dimiliki pembanding:** `NotebookEdit` (Claude Code), formatter
otomatis (opencode), gambar/PDF (keduanya).

---

## 3. MCP — sudah ada, belum setara

Ini perubahan terbesar hari ini, dan penting untuk tidak dilebih-lebihkan.

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Transport stdio | ✅ | ✅ | ✅ |
| Transport HTTP / SSE | **❌** | ✅ | ✅ |
| OAuth | **❌** | ✅ | ✅ |
| `tools` | ✅ | ✅ | ✅ |
| `resources` | **❌** | ✅ | ✅ |
| `prompts` | **❌** | ✅ | ✅ |
| Sumbu izin khusus MCP | **✅ `mcp`** | lewat peta per-tool | per-tool |

Titah menutup **kasus yang paling sering**: server stdio yang menawarkan tool.
Itu bentuk hampir semua server MCP yang dipasang orang. Yang belum ada adalah
server remote (butuh HTTP/SSE + OAuth) dan dua kapabilitas lain.

Satu hal yang **hanya Titah** punya di sini: sumbu izin `mcp` tersendiri. Tool
MCP adalah kode yang tidak bisa diklasifikasikan host-nya — sebuah server boleh
menulis berkas, memanggil API berbayar, atau keduanya — jadi memaksanya ke sumbu
seperti `edit` berarti user menyetujui hal yang berbeda dari yang terjadi.

---

## 4. Model izin — bentuknya berbeda, bukan cuma jumlahnya

| | Bentuk | Sumbu |
|---|---|---|
| **Titah** | per **kelas tindakan** | `edit` `write` `bash` `network` `delete` `mcp` + allowlist per-segmen |
| opencode | per **tool** + kondisi | `*` `read` `question` `doom_loop` `external_directory` `plan_enter` `plan_exit` |
| Claude Code | per **tool berpola** | `Bash(git *)`, `Edit`, `WebFetch(domain:…)` |

**Hanya Titah punya `delete`.** Menghapus bukan menulis: `write: allow` yang
berarti "boleh membuat berkas baru" tidak pernah berarti "boleh menghapus berkas
saya".

**Hanya Titah punya `network` sebagai kelas.** Claude Code punya `WebFetch(domain:…)`
yang lebih halus per-domain, tapi tidak ada satu sakelar yang berarti "tidak ada
apa pun yang keluar dari mesin ini".

**Hanya opencode punya `doom_loop`** (minta izin saat mendeteksi model berputar)
dan **`external_directory`** (izin per-path untuk keluar cwd). Titah memakai
`resolveInside` sebagai aturan keras — lebih sederhana, tapi **tanpa pintu keluar
yang sah** untuk kerja lintas-repo. Itu gap nyata.

**Claude Code paling halus** untuk bash: pola per-perintah dengan pemeriksaan
rantai. Titah sekarang setara di sana (#13); opencode tidak punya padanannya.

---

## 5. Manajemen konteks — jarak terjauh, dan Titah di depan

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Pemadatan otomatis | ✅ | ✅ | ✅ `--autocompact` |
| Pemadatan **di tengah giliran** | **✅** | tidak terdokumentasi | tidak terdokumentasi |
| Batas prompt peringkas sendiri | **✅** berpotong, per jendela `smallModel` | — | — |
| Mengukur request yang **dirakit** | **✅** satu definisi untuk kirim & ukur | — | — |
| Rencana selamat dari pemadatan | **✅** tabel `plan` | ❌ | ❌ |
| Memori lintas sesi | **✅** tabel `memory` | ❌ | ❌ |
| Urutan sadar-cache, dipaku test | **✅** | — | — |
| Prompt caching | ✅ | ✅ | ✅ |

Empat baris di tengah tidak ada padanannya di kedua pembanding.

Yang membuatnya berbeda bukan fiturnya melainkan **sifat strukturalnya**:
`plan` dan `memory` disimpan di luar `model_message`, dan pemadatan hanya
menyentuh tabel itu. Ketidakterjangkauannya adalah **sifat skema**, bukan aturan
yang harus diingat orang.

Catatan jujur: auto-compaction Claude Code dan opencode **lebih matang secara
pemakaian** — ribuan orang tiap hari. Titah belum. Yang bisa diklaim Titah bukan
"lebih baik dipakai", melainkan "alasannya bisa diperiksa".

---

## 6. Ekstensibilitas — masih tertinggal

| | Titah | opencode | Claude Code |
|---|---|---|---|
| MCP | ✅ stdio | ✅ penuh | ✅ penuh |
| Plugin | **❌** | ✅ modul npm | ✅ + marketplace |
| Hooks | **❌** | lewat plugin | ✅ |
| Skill | ✅ **dua ekosistem** | miliknya sendiri | miliknya sendiri |
| Impor config agent lain | ❌ | ❌ | ✅ `claude import` |

MCP menutup jalur *tool* pihak ketiga. Yang belum tertutup adalah **penyesuaian
perilaku**: menjalankan formatter setelah tiap `write`, memblok `edit` pada
berkas tertentu, mencatat tiap tool call. Di Titah semuanya masih berarti fork.

---

## 7. Operasional dan jangkauan — tertinggal paling jauh

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Server headless | `serve` **tanpa auth** | `serve` | — |
| Antarmuka web | ❌ | ✅ + mDNS + CORS | claude.ai/code |
| Tertanam di editor | ❌ | ✅ ACP (Zed dll) | ekstensi VS Code / JetBrains |
| Jalan di mesin lain | ❌ | ❌ | ✅ `--cloud`, `--bg` |
| Integrasi GitHub | ❌ | ✅ `github`, `pr <n>` | ✅ |
| Statistik / export | ❌ | ✅ `stats` `export` `import` | `/cost` `/usage` |
| Telemetri enterprise | ❌ | OpenTelemetry | `gateway` |
| Delegasi ke CLI agent lain | **✅ `@claude` `@opencode`** | ❌ | ❌ |
| Fan-out lintas agent | **✅ `/consensus`** | ❌ | `ultrareview` (miliknya sendiri) |

`titah serve --hostname 0.0.0.0` memberi siapa pun di jaringan API yang bisa
menjalankan `bash`, **tanpa token**. Ini kekurangan yang bisa merugikan user
secara langsung, bukan sekadar membatasinya — dan satu-satunya di daftar ini
yang begitu.

---

## 8. Gap Titah, berurut menurut yang paling mengubah apa yang bisa dikerjakan

1. **Gambar dan PDF.** `read` menolak biner, dan tidak ada jalur mana pun yang
   mengirim gambar ke model. Sekarang **gap fungsional terbesar** — tidak bisa
   menempel screenshot UI yang rusak, tidak bisa membaca PDF spesifikasi.
2. **Auth pada server.** Satu-satunya kekurangan yang bisa merugikan, bukan
   sekadar membatasi.
3. **Hooks / plugin.** MCP menutup jalur tool; ini menutup jalur perilaku.
4. **MCP remote** (HTTP/SSE + OAuth) dan `resources`/`prompts`.
5. **Formatter otomatis.** LSP sudah masuk; formatter belum, dan opencode
   punya keduanya.
6. **`external_directory`.** Batas cwd Titah keras dan tanpa pintu keluar sah.
7. **Notebook**, `temperature`/`top_p` per agent, `subagent_depth`, retry.
8. **Eval harness.** 749 test membuktikan kodenya berperilaku sesuai
   spesifikasi. Tidak satu pun membuktikan **agent-nya menyelesaikan tugas**.
9. **Kematangan pemakaian.** Tidak bisa dikejar dengan kode.

## 9. Gap pembanding terhadap Titah

**opencode tidak punya:** `list` `patch` `move` `remove` `diagnostics` `websearch`,
proses latar, memori lintas sesi, rencana yang tahan pemadatan, sumbu `delete`,
delegasi ke CLI agent lain, skill dua ekosistem.

**Claude Code tidak punya:** `list` `patch` `move` `remove` `diagnostics`,
memori lintas sesi, rencana yang tahan pemadatan, sumbu `delete`/`network`/`mcp`
sebagai kelas, delegasi ke agent lain, skill dua ekosistem.

---

## 10. Rumusan satu paragraf

Untuk **satu orang mengerjakan satu repo dalam sesi panjang**, Titah sekarang
**unggul**: lebih banyak tool, izin yang lebih jujur per kelas tindakan, dan
manajemen konteks yang tidak ada padanannya — rencana dan memori yang tidak bisa
dijangkau pemadatan, plus pengukuran yang dijamin sama dengan yang dikirim.
Dengan MCP mendarat, ia juga sudah bisa memakai ekosistem tool pihak ketiga.

Yang masih memisahkannya bukan lagi kemampuan inti, melainkan **tiga hal yang
lebih membosankan**: input multimodal, keamanan operasional, dan penyesuaian
tanpa fork. Ketiganya bisa ditambal dan tidak satu pun butuh membongkar apa yang
sudah ada.

Yang **tidak** bisa ditambal, dan tidak dimiliki Titah, adalah bukti dari ribuan
orang yang memakainya tiap hari.
