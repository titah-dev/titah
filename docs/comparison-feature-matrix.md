# Perbandingan Fitur: Titah vs OpenCode vs Claude Code

Berdasarkan benchmark terbaru (2026-08-13) — Titah v0.1.0, OpenCode 1.18.4, Claude Code 2.1.229

## Ringkasan Eksekutif

| Metrik | Titah | OpenCode | Claude Code |
|--------|-------|----------|-------------|
| **Tool bawaan** | **22** | 12 | ~17 |
| **Waktu start (ms)** | 220 | 487 | **117** |
| **Ukuran disk (MB)** | **80** | 132 | 281 |
| **Test coverage** | **846 test** | tidak publik | tidak publik |
| **Baris kode src/** | 18.508 | tidak publik | tidak publik |

---

## 1. Tool Bawaan

| Fitur | Titah | OpenCode | Claude Code | Catatan |
|-------|:-----:|:--------:|:-----------:|---------|
| **Baca & Navigasi** |
| `read` — baca berkas | ✅ | ✅ | ✅ | |
| `list` — daftar direktori | ✅ | ❌ | ❌ | **Hanya Titah** |
| `glob` — cari nama berkas | ✅ | ✅ | ✅ | |
| `grep` — cari isi berkas | ✅ | ✅ | ✅ | |
| **Menulis & Sunting** |
| `edit` — sunting satu tempat | ✅ | ✅ | ✅ | |
| `patch` — sunting banyak atomik | ✅ | ❌ | ✅¹ | ¹ MultiEdit mungkin warisan |
| `write` — tulis berkas | ✅ | ✅ | ✅ | |
| `move` — pindah/rename | ✅ | ❌ | ❌ | **Hanya Titah** |
| `remove` — hapus berkas | ✅ | ❌ | ❌ | **Hanya Titah** |
| **Eksekusi** |
| `bash` — shell sync | ✅ | ✅ | ✅ | |
| Proses latar (background) | ✅ | ❌ | ✅ | 3 tool: start/output/stop |
| **Quality Assurance** |
| `diagnostics` — periksa manual | ✅ | ❌ | ❌ | **Hanya Titah** |
| LSP otomatis tiap edit | ✅ | ✅ | via ekstensi | |
| Formatter otomatis | ❌ | ✅ | via ekstensi | **Gap Titah** |
| **Web & Network** |
| `webfetch` — ambil URL | ✅ | ✅ | ✅ | |
| `websearch` — cari web | ✅ | ❌ | ✅ | |
| **Agent & Skill** |
| `task` — sub-agent | ✅ | ✅ | ✅ | |
| `skill` — prompt injection | ✅ | ✅ | ✅ | |
| Skill dua ekosistem | ✅ | ❌ | ❌ | **Hanya Titah**: Claude + opencode |
| **Rencana & Memori** |
| `plan` — tahan pemadatan | ✅ | ❌ | ❌ | **Hanya Titah**: di luar transkrip |
| `todowrite` — di transkrip | ❌ | ✅ | ✅ | |
| `memory` — lintas sesi | ✅ | ❌ | ❌ | **Hanya Titah**: kunci per proyek |
| **Interaksi** |
| `question` — bertanya balik | ✅ | ✅ | ✅ | |
| **Multimodal** |
| Gambar / PDF | ❌ | ✅ | ✅ | **Gap terbesar Titah** |
| `NotebookEdit` | ❌ | ❌ | ✅ | Hanya Claude Code |

**Ringkasan:** Titah **22 tool** vs OpenCode 12 vs Claude Code ~17

**Yang hanya Titah punya:** `list` `patch` `move` `remove` `diagnostics` `websearch`, rencana tahan pemadatan, memori lintas sesi, skill dua ekosistem

**Yang tidak Titah punya:** gambar/PDF (keduanya), formatter otomatis (OpenCode), notebook (Claude Code)

---

## 2. Model Izin

| Aspek | Titah | OpenCode | Claude Code |
|-------|-------|----------|-------------|
| **Bentuk sistem** | Per **kelas tindakan** | Per **tool + kondisi** | Per **tool berpola** |
| **Jumlah sumbu** | 10 | 7 | pola per-tool |
| **Sumbu yang ada** | edit, write, bash, network, delete, mcp, external_directory, doom_loop, allowlist, rules | *, read, question, doom_loop, external_directory, plan_enter, plan_exit | Bash(git *), Edit, WebFetch(domain:…) |

### Detail Keunggulan

| Fitur Izin | Titah | OpenCode | Claude Code | Catatan |
|------------|:-----:|:--------:|:-----------:|---------|
| `delete` sebagai kelas sendiri | ✅ | ❌ | ❌ | **Hanya Titah**: hapus ≠ tulis |
| `network` sebagai sakelar tunggal | ✅ | ❌ | ❌ | **Hanya Titah**: "tidak keluar mesin" |
| `mcp` sebagai kelas sendiri | ✅ | lewat per-tool | per-tool | **Hanya Titah**: izin eksplisit MCP |
| `doom_loop` deteksi model berputar | ✅ | ✅ | ❌ | Titah adopsi dari OpenCode |
| `external_directory` keluar cwd | ✅ | ✅ | ❌ | Titah adopsi dari OpenCode |
| Pola per-domain web | ❌ | ❌ | ✅ | Claude Code paling halus |
| Pemeriksaan rantai bash | ✅ | ❌ | ✅ | Titah & Claude: cek `&&` / `||` |
| `permission explain` penjelas | ✅ | ❌ | auto-mode | **Hanya Titah**: CLI explain |

**Filosofi:**
- **Titah**: izin per kelas, paling jujur & transparan
- **OpenCode**: per-tool + kondisi, paling sederhana
- **Claude Code**: per-tool berpola, paling halus

---

## 3. Manajemen Konteks

| Fitur | Titah | OpenCode | Claude Code | Catatan |
|-------|:-----:|:--------:|:-----------:|---------|
| Pemadatan otomatis | ✅ | ✅ | ✅ | Semua punya |
| Pemadatan **di tengah giliran** | ✅ | tidak terdokumentasi | tidak terdokumentasi | **Hanya Titah terdokumentasi** |
| Batas prompt peringkas | ✅ | ❌ | ❌ | **Hanya Titah**: hindari overflow |
| Mengukur request yang dirakit | ✅ | ❌ | ❌ | **Hanya Titah**: satu definisi kirim & ukur |
| Rencana selamat pemadatan | ✅ | ❌ | ❌ | **Hanya Titah**: tabel `plan` terpisah |
| Memori lintas sesi | ✅ | ❌ | ❌ | **Hanya Titah**: tabel `memory` per proyek |
| Urutan sadar-cache, dipaku test | ✅ | ❌ | ❌ | **Hanya Titah**: verifikasi test |
| Prompt caching Anthropic | ✅ | ✅ | ✅ | Semua punya |

**Keunggulan struktural Titah:** `plan` dan `memory` di luar `model_message` → tidak bisa dijangkau pemadatan. Sifat skema, bukan aturan.

**Catatan jujur:** Auto-compaction Claude Code & OpenCode **lebih matang secara pemakaian** (ribuan user). Titah: alasannya bisa diperiksa.

---

## 4. MCP (Model Context Protocol)

| Fitur | Titah | OpenCode | Claude Code | Catatan |
|-------|:-----:|:--------:|:-----------:|---------|
| **Transport** |
| stdio | ✅ | ✅ | ✅ | |
| HTTP / SSE | ❌ | ✅ | ✅ | **Gap Titah** |
| OAuth | ❌ | ✅ | ✅ | **Gap Titah** |
| **Kapabilitas** |
| `tools` | ✅ | ✅ | ✅ | |
| `resources` | ❌ | ✅ | ✅ | **Gap Titah** |
| `prompts` | ❌ | ✅ | ✅ | **Gap Titah** |
| **Izin** |
| Sumbu khusus MCP | ✅ | lewat per-tool | per-tool | **Hanya Titah**: `mcp` eksplisit |
| Manajemen dari CLI | ❌ | ✅ `opencode mcp` | ✅ `claude mcp` | **Gap Titah** |

**Status:** Titah menutup **kasus paling sering** (stdio + tools). Yang belum: server remote & kapabilitas lain.

---

## 5. Ekstensibilitas

| Fitur | Titah | OpenCode | Claude Code | Catatan |
|-------|:-----:|:--------:|:-----------:|---------|
| MCP | ✅ stdio | ✅ penuh | ✅ penuh | |
| Plugin | ❌ | ✅ modul npm | ✅ + marketplace | **Gap terbesar Titah** |
| Hooks | ❌ | lewat plugin | ✅ | **Gap Titah** |
| Skill | ✅ dua ekosistem | milik sendiri | milik sendiri | **Hanya Titah**: Claude + opencode |
| Impor config agent lain | ❌ | ❌ | ✅ `claude import` | |

**Gap nyata:** MCP menutup jalur **tool** pihak ketiga. Yang belum: penyesuaian **perilaku** (formatter otomatis, block edit, log tool call) → butuh plugin/hooks.

---

## 6. Jangkauan Operasional

| Fitur | Titah | OpenCode | Claude Code | Catatan |
|-------|:-----:|:--------:|:-----------:|---------|
| **Deployment** |
| Sub-command CLI | 17 | 21 | 13 + banyak opsi | |
| Server headless | ✅ **tanpa auth** | ✅ | ❌ | **⚠️ Kerentanan Titah** |
| Antarmuka web | ❌ | ✅ + mDNS | claude.ai/code | |
| Tertanam editor | ❌ | ✅ ACP (Zed dll) | VS Code / JetBrains | |
| Jalan di mesin lain | ❌ | ❌ | ✅ `--bg` `agents` | |
| **Integrasi** |
| GitHub | ❌ | ✅ `github` `pr` | ✅ | |
| Statistik / export | ❌ | ✅ `stats` `export` `import` | `/cost` `/usage` | |
| Telemetri enterprise | ❌ | OpenTelemetry | `gateway` | |
| **Fitur Unik Titah** |
| Review multi-agent | ✅ `/consensus` | ❌ | `ultrareview` (cloud) | **Hanya Titah**: fan-out CLI |
| Delegasi ke CLI agent lain | ✅ `@claude` `@opencode` | ❌ | ❌ | **Hanya Titah** |
| Penjelas izin | ✅ `permission explain` | ❌ | `auto-mode` | **Hanya Titah**: CLI explain |
| **Akun & Auth** |
| Akun / SSO | ✅ device flow | ✅ | ✅ | |

**⚠️ Kerentanan serius:** `titah serve --hostname 0.0.0.0` memberi akses bash **tanpa token** ke jaringan.

---

## 7. Performa & Ukuran

| Metrik | Titah | OpenCode | Claude Code | Pemenang |
|--------|-------|----------|-------------|----------|
| **Waktu Start** |
| `--version` | 220 ms | 487 ms | **117 ms** | Claude Code |
| `--help` | 221 ms | 502 ms | 224 ms | Claude Code |
| **Ukuran Disk** |
| Total | **80 MB** | 132 MB | 281 MB | **Titah** |
| Rincian | 1.8 MB dist + 78 MB node_modules | biner tunggal | bundel versi | |
| **Kode & Test** |
| Baris `src/` | 18.508 | tidak publik | tidak publik | |
| Test lulus | **846** | tidak publik | tidak publik | **Titah terdokumentasi** |

**Interpretasi:**
- **Start tercepat**: Claude Code (native binary)
- **Paling ringan**: Titah (hampir semua dari dependencies)
- **Test terbanyak**: Titah satu-satunya dengan angka publik

---

## 8. Gap Analisis

### Gap Titah (Terurut Menurut Dampak)

| # | Gap | Status | Dampak | Solusi |
|---|-----|--------|--------|--------|
| 1 | **Gambar & PDF** | ❌ | Tidak bisa screenshot UI, baca PDF spek | Gap fungsional terbesar |
| 2 | **Auth pada `serve`** | ❌ | Kerentanan keamanan | Satu-satunya yang merugikan |
| 3 | **Hooks / plugin** | ❌ | Tidak bisa customize perilaku tanpa fork | Gap ekstensibilitas |
| 4 | **MCP remote** (HTTP/SSE + OAuth) | ❌ | Tidak bisa server MCP remote | Stdio sudah cukup 80% kasus |
| 5 | **Formatter otomatis** | ❌ | Kode tidak diformat setelah edit | OpenCode punya |
| 6 | **Waktu start** 220ms | ~ | Terasa di skrip & CI | Claude Code 2× lebih cepat |
| 7 | **Notebook** | ❌ | Tidak bisa edit Jupyter | Hanya Claude Code punya |
| 8 | **Eval harness** | ❌ | Tidak ada bukti kualitas agent | Gap metodologis |
| 9 | **Kematangan pemakaian** | ~ | v0.1.0, satu orang | Tidak bisa dikejar dengan kode |

### Gap Pembanding Terhadap Titah

#### OpenCode Tidak Punya:

- `list` `patch` `move` `remove` `diagnostics` `websearch`
- Proses latar (background)
- Memori lintas sesi
- Rencana tahan pemadatan
- Sumbu `delete` / `network`
- Delegasi ke CLI agent lain
- Skill dua ekosistem
- `permission explain`
- **Paling lambat start**: 487 ms (2,2× Titah)

#### Claude Code Tidak Punya:

- `list` `patch` `move` `remove` `diagnostics`
- Memori lintas sesi
- Rencana tahan pemadatan
- Sumbu `delete` / `network` / `mcp` sebagai kelas
- Delegasi ke agent lain
- Skill dua ekosistem
- **Paling besar disk**: 281 MB (3,5× Titah)

---

## 9. Kesimpulan & Rekomendasi

### Kapan Pilih Titah

✅ **Cocok untuk:**
- Satu orang, satu repo, sesi panjang
- Butuh tool terlengkap (22 tool)
- Butuh izin transparan per kelas
- Butuh rencana & memori tahan pemadatan
- Butuh delegasi ke CLI agent lain
- Butuh `/consensus` multi-agent review
- Butuh ringan di disk (80 MB)

❌ **Tidak cocok untuk:**
- Butuh gambar/PDF
- Butuh server production (belum ada auth)
- Butuh plugin/hooks
- Butuh MCP remote
- Butuh integrasi editor

### Kapan Pilih OpenCode

✅ **Cocok untuk:**
- Butuh platform lengkap (web UI, mDNS, GitHub)
- Butuh formatter otomatis
- Butuh MCP lengkap (3 transport + OAuth)
- Butuh plugin npm
- Butuh OpenTelemetry

❌ **Tidak cocok untuk:**
- Butuh tool lengkap (cuma 12 tool)
- Butuh proses background
- Butuh start cepat (2× lebih lambat dari Titah)

### Kapan Pilih Claude Code

✅ **Cocok untuk:**
- Butuh gambar/PDF
- Butuh notebook editing
- Butuh integrasi editor (VS Code, JetBrains)
- Butuh jalan di mesin lain (`--bg`, `--cloud`)
- Butuh start tercepat (117 ms)
- Butuh `ultrareview` cloud

❌ **Tidak cocok untuk:**
- Butuh tool lengkap (cuma ~17 tool)
- Butuh ringan di disk (281 MB, 3,5× Titah)
- Butuh memori lintas sesi

---

## 10. Roadmap Prioritas Titah

Berdasarkan gap analysis, urutan perbaikan yang direkomendasikan:

1. **Gambar & PDF** — gap fungsional terbesar
2. **Auth pada server** — satu-satunya kerentanan
3. **Hooks / plugin** — buka ekstensibilitas
4. **MCP remote** — lengkapi MCP
5. **Formatter otomatis** — OpenCode sudah punya
6. **Eval harness** — bukti kualitas

---

## Catatan Metodologi

**Cara pengukuran:**
- Tool & izin Titah: `allTools()` dan `Permission.shape` dievaluasi langsung
- Tool & izin OpenCode: `opencode debug agent build` — peta JSON otoritatif
- Permukaan CLI: `--help` ketiganya
- Waktu start: 7× jalan, ambil tercepat (bukan rata-rata)
- Ukuran terpasang: `du -sk` direktori instalasi

**Yang tidak bisa diukur:**
- Daftar tool Claude Code: perkiraan dari nama di biner (~17)
- Test coverage pembanding: tidak publik
- Kualitas agent: tidak ada eval harness

**Versi yang diukur:**
- Titah: v0.1.0 @ `main` `e7d82ad`
- OpenCode: 1.18.4 (homebrew)
- Claude Code: 2.1.229

---

*Dokumen ini adalah ringkasan dari:*
- `docs/benchmark-2026-08-13.md` — angka yang diukur
- `docs/comparison-2026-08-13.md` — perbandingan terinci
- `docs/gap-analysis-opencode.md` — gap tambahan vs OpenCode
- `docs/gap-analysis.md` — gap internal Titah

*Diperbarui: 2026-08-13*
