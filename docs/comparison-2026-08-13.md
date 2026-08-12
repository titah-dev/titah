# Titah vs opencode vs Claude Code — sejauh mana Titah sudah unggul

Ditulis 2026-08-13, terhadap `main` @ `c482e1a`: typecheck bersih, **730/730 test
lulus**, `src/` 14.737 baris, **21 tool bawaan**.

Pembanding, keduanya yang benar-benar terpasang di mesin ini:
**opencode 1.18.4** dan **Claude Code 2.1.228**.

## Cara mengukurnya

Bukan dari ingatan, dan tiap angka bisa Anda periksa ulang:

- **opencode** — `opencode debug agent build`, yang mencetak peta `tools` dan
  `permission` agent itu apa adanya. Ini otoritatif, bukan tebakan dari string
  di dalam biner.
- **Claude Code** — nama tool dicari di biner `2.1.228` (289 MB), permukaan CLI
  dari `claude --help`.
- **Titah** — `allTools()` dan `Config.shape` dievaluasi langsung.

Satu koreksi terhadap dokumen lama: `docs/gap-analysis-opencode.md` menulis
"9 lawan 15" untuk tool. Itu **tidak akurat** untuk 1.18.4 — `list`, `patch`,
`websearch`, dan `lsp` ada sebagai string di biner tapi **tidak terdaftar** di
registry tool agent mana pun yang saya periksa.

---

## 1. Tool

| | Jumlah |
|---|---|
| **Titah 0.1.0** | **21** |
| Claude Code 2.1.228 | ~17 + MCP |
| opencode 1.18.4 | 12 + MCP |

**Titah** — `read` `list` `glob` `grep` `edit` `patch` `write` `move` `remove`
`bash` `bash_start` `bash_output` `bash_stop` `diagnostics` `skill` `task`
`plan` `memory` `question` `webfetch` `websearch`

**opencode** — `read` `glob` `grep` `edit` `write` `bash` `skill` `task`
`todowrite` `webfetch` `question` `invalid`

**Claude Code** — `Read` `Glob` `Grep` `Edit` `Write` `NotebookEdit` `Bash`
`BashOutput` `KillShell` `WebFetch` `WebSearch` `Task` `Skill` `TodoWrite`
`AskUserQuestion` `ExitPlanMode` `SlashCommand`

### Per kemampuan

| Kemampuan | Titah | opencode | Claude Code |
|---|---|---|---|
| Baca / cari | `read` `list` `glob` `grep` | `read` `glob` `grep` | `Read` `Glob` `Grep` |
| Sunting satu tempat | `edit` | `edit` | `Edit` |
| Sunting banyak, atomik | **`patch`** | — | `MultiEdit`¹ |
| Tulis berkas | `write` | `write` | `Write` |
| Pindah / hapus | **`move` `remove`** | — | — |
| Shell | `bash` | `bash` | `Bash` |
| Proses latar | **`bash_start/output/stop`** | — | `Bash --bg` `BashOutput` `KillShell` |
| Pemeriksa proyek | **`diagnostics`** | LSP otomatis² | ekstensi IDE² |
| Web | `webfetch` `websearch` | `webfetch` | `WebFetch` `WebSearch` |
| Sub-agent | `task` | `task` | `Task` |
| Skill | `skill` | `skill` | `Skill` |
| Rencana | **`plan`** — tahan pemadatan | `todowrite` — di transkrip | `TodoWrite` — di transkrip |
| Memori lintas sesi | **`memory`** | — | — |
| Bertanya balik | `question` | `question` | `AskUserQuestion` |
| Notebook | — | — | `NotebookEdit` |
| MCP | **—** | ✅ | ✅ |
| Gambar / PDF | **—** | ✅ | ✅ |

¹ ada di biner, mungkin warisan. ² bukan tool yang dipanggil model.

---

## 2. Model izin

| | Bentuk |
|---|---|
| **Titah** | 5 sumbu: `edit` `write` `bash` `network` `delete`, + allowlist per-segmen |
| opencode | `*` `read` `question` `doom_loop` `external_directory` `plan_enter` `plan_exit` + peta per-tool |
| Claude Code | per-tool berpola: `Bash(git *)`, `Edit`, `WebFetch(domain:…)` |

Tiga hal yang hanya dimiliki satu pihak:

- **Titah punya `delete` sebagai sumbu sendiri.** `write: allow` yang berarti
  "boleh membuat berkas baru" tidak pernah berarti "boleh menghapus berkas
  saya". Tidak ada padanannya di dua pembanding.
- **Titah punya `network` sebagai sumbu sendiri.** Bukan soal berkas — soal
  **kerahasiaan**. Ini satu-satunya kelas tool yang mengirim isi repo ke luar
  mesin.
- **opencode punya `doom_loop`** (minta izin saat mendeteksi model berputar)
  dan **`external_directory`** (izin per-path untuk keluar cwd). Titah memakai
  `resolveInside` sebagai aturan keras — lebih sederhana, tapi tanpa pintu
  keluar yang sah untuk kerja lintas-repo.

### Allowlist bash: satu perbedaan yang terukur

Sampai kemarin, allowlist Titah mencocokkan `"<kata-pertama> *"`, sehingga
`"git *"` juga mengizinkan `git status && rm -rf ~`. Itu diperbaiki di #13:
perintah dipecah pada operator shell dan **setiap segmen** harus punya entri
yang mengizinkannya; substitusi dan redirect tidak pernah lolos otomatis.

Claude Code menerima pola berbentuk sama dan juga memeriksa rantai. opencode
tidak punya allowlist bash setingkat pola sama sekali — ia memakai peta per-tool
plus `external_directory`.

---

## 3. Manajemen konteks — di sinilah Titah unggul, dan bukan tipis

Ini bagian yang paling sulit ditambal belakangan, dan bagian yang paling banyak
dikerjakan.

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Pemadatan otomatis | ✅ | ✅ | ✅ `--autocompact auto\|100k–1M` |
| Pemadatan **di tengah giliran** | ✅ `prepareStep` | tidak terdokumentasi | tidak terdokumentasi |
| Batas prompt peringkas sendiri | ✅ berpotong, per jendela `smallModel` | — | — |
| Pengukuran **request yang dirakit** | ✅ `requestTokens` | — | — |
| Rencana yang selamat dari pemadatan | ✅ tabel `plan` | ❌ di transkrip | ❌ di transkrip |
| Memori lintas sesi | ✅ tabel `memory` | ❌ | ❌ |
| Urutan permintaan sadar-cache | ✅ stabil→volatil, dipaku test | — | — |
| Prompt caching | ✅ `cache_control` + urutan | ✅ | ✅ |

Tiga di antaranya tidak ada padanannya di kedua pembanding:

**`plan` dan `memory` disimpan di luar `model_message`.** Pemangkas hanya menulis
ulang tabel itu dan peringkas hanya membaca baris di atas batas air — jadi
keduanya tidak bisa dijangkau pemadatan. Itu **sifat skema**, bukan aturan yang
harus diingat orang. `TodoWrite` dan `todowrite` hidup di transkrip, dan
transkrip diringkas.

**Yang diukur adalah yang dikirim.** `requestShape` adalah satu-satunya tempat
bentuk permintaan ditulis, dipakai oleh yang mengirim **dan** yang mengukur.
Itu bukan kerapian: versi sebelumnya punya dua salinan, dan rencana masuk ke
salinan yang mengirim sambil luput dari yang mengukur.

**Akuntansinya sudah lewat empat ronde review adversarial** dengan tiap temuan
dipaku test — 20 temuan, dan diagnosis yang berulang di tiap ronde sama: temuan
paling serius selalu berupa batas atau kredit yang memercayai angka yang
dihitung di tempat lain.

Auto-compaction Claude Code dan opencode jelas **lebih matang secara pemakaian**
— mereka dipakai ribuan orang tiap hari, Titah belum. Tapi alasannya tidak bisa
Anda baca; di Titah bisa.

---

## 4. Ekstensibilitas — di sinilah Titah kalah, dan tidak tipis

| | Titah | opencode | Claude Code |
|---|---|---|---|
| MCP | **❌** | ✅ 3 transport + OAuth | ✅ |
| Plugin | **❌** | ✅ modul npm | ✅ + marketplace |
| Hooks | **❌** | lewat plugin | ✅ |
| Skill | ✅ dua ekosistem | miliknya sendiri | miliknya sendiri |
| Agent dari registry lain | ❌ | ❌ | `claude import` |

**MCP adalah gap terbesar Titah, dan sifatnya berbeda dari gap lain.** Ia bukan
satu kemampuan yang hilang — ia pintu ke semua kemampuan pihak ketiga. Selama
tidak ada, setiap integrasi baru berarti menulis tool di dalam Titah.

Satu-satunya tempat Titah menang di baris ini: **skill dari dua ekosistem
sekaligus.** Ia membaca registry Claude Code *dan* opencode tanpa konfigurasi.
Keduanya hanya membaca miliknya sendiri.

---

## 5. Operasional dan jangkauan

| | Titah | opencode | Claude Code |
|---|---|---|---|
| Server headless | `serve` **tanpa auth** | `serve` | — |
| Antarmuka web | ❌ | ✅ + mDNS + CORS | claude.ai/code |
| Jalankan di tempat lain | ❌ | ACP (Zed dll) | `--cloud`, `--bg`, gateway |
| Integrasi GitHub | ❌ | `github`, `pr <n>` | ✅ |
| Statistik / export | ❌ | `stats`, `export`, `import` | `/cost`, `/usage` |
| Delegasi ke CLI agent lain | **`@claude` `@opencode`** | ❌ | ❌ |
| Fan-out lintas agent | **`/consensus`** | ❌ | `ultrareview` (miliknya sendiri) |

`titah serve --hostname 0.0.0.0` memberi siapa pun di jaringan itu API yang bisa
menjalankan `bash`, tanpa token. Ini kekurangan operasional paling serius yang
tersisa.

---

## 6. Jawaban langsung: sejauh mana Titah sudah unggul

**Unggul, dan bisa ditunjuk:**

1. **Jumlah tool** — 21 lawan 17 dan 12.
2. **Tool berkas berizin sendiri** (`move`, `remove`). Dua pembanding memaksa
   lewat `bash`: memindahkan satu berkas berarti membuka seluruh shell.
3. **`patch` atomik** — beberapa suntingan, semua-atau-tidak.
4. **Sumbu `delete` dan `network`** — tidak ada padanannya.
5. **State yang selamat dari pemadatan** (`plan`, `memory`) — tidak ada
   padanannya, dan ini yang paling berarti untuk kerja berjam-jam.
6. **Yang diukur = yang dikirim**, satu definisi, dipaku test.
7. **Delegasi ke Claude Code dan opencode sebagai sub-agent** plus
   `/consensus` — tidak ada padanannya.
8. **Skill dua ekosistem.**

**Kalah, dan tidak tipis:**

1. **MCP** — pintu ke seluruh ekosistem pihak ketiga.
2. **Gambar dan PDF** — `read` menolak biner; untuk kerja frontend ini terasa
   tiap hari.
3. **Hooks dan plugin** — satu-satunya jalan penyesuaian di Titah adalah fork.
4. **LSP sungguhan** — `diagnostics` menjalankan perintah, ia tidak tahu simbol.
5. **Jangkauan operasional** — cloud, web, ACP, GitHub, dan **auth server**.
6. **Kematangan pemakaian** — ini yang paling jujur. 730 test membuktikan
   kodenya berperilaku sesuai spesifikasi. Tidak satu pun membuktikan
   **agent-nya menyelesaikan tugas**, dan tidak ada eval harness yang bisa
   mengukurnya.

**Rumusan yang paling jujur:**

> Untuk **satu orang mengerjakan satu repo dalam sesi panjang**, Titah sekarang
> punya inti yang setara — dan pada manajemen konteks, lebih baik dan lebih bisa
> diperiksa daripada keduanya.
>
> Untuk **menjangkau apa pun di luar repo itu** — layanan pihak ketiga, gambar,
> editor lain, mesin lain, atau penyesuaian tanpa mengubah source — ia masih
> tertinggal jauh, dan jaraknya adalah MCP plus plugin.

Gap Titah adalah **jangkauan**, dan jangkauan bisa ditambal belakangan.
Kebenaran loop intinya tidak bisa, dan bagian itu sudah dibayar.

---

## 7. Urutan yang saya rekomendasikan berikutnya

1. **MCP stdio lokal.** Terbesar, hasil terluas, dan fondasinya sudah ada di
   `src/core/delegate/` — subprocess dengan protokol dan adapter adalah barang
   yang sama dengan pesan berbeda.
2. **Gambar di `read`.** Kecil dibanding MCP, dan menutup satu kelas tugas.
3. **Auth server.** Satu-satunya kekurangan yang bisa merugikan user secara
   langsung, bukan sekadar membatasinya.
4. **Hooks.** Setelah ini, sebagian permintaan penyesuaian bisa dijawab user
   sendiri.
5. **Eval harness.** Tanpa ini, setiap perubahan pada system prompt atau
   deskripsi tool dinilai dengan kesan, bukan angka — dan roster 21 tool membuat
   deskripsi tool jadi permukaan yang jauh lebih besar daripada sebelumnya.
