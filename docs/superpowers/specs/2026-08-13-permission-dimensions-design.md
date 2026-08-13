# Tiga dimensi izin: kelas, argumen, situasi

Design + hasil, 2026-08-13. Baseline: `main` @ `42c9aa4`, 749 test hijau.

Menjawab: *"jika saya ingin menggunakan konsep sumbu izinnya seperti opencode
dan Claude Code, apakah memungkinkan keduanya?"* — jawabannya ya, lalu
diminta mengerjakan keempat bagiannya.

## Kenapa bisa digabung

Ketiganya bukan desain yang bersaing. Mereka menjawab pertanyaan yang berbeda,
jadi mereka **ortogonal** dan bisa berurutan:

| Dimensi | Pertanyaannya | Asalnya |
|---|---|---|
| **Kelas** | jenis kerusakan apa? | Titah |
| **Argumen** | panggilan yang seperti apa persisnya? | Claude Code |
| **Situasi** | apa yang terjadi di sekitarnya? | opencode |

Titah sudah punya dua dari tiga, meski kasar: kebijakan kelas, lalu allowlist
bash sebagai dimensi argumen versi paling sederhana. Yang dikerjakan di sini
adalah **memperdalam lapisan kedua** dan **menyisipkan lapisan ketiga**.

## Aturan penggabungan — bagian yang benar-benar sulit

Tiga kandidat, dan dua di antaranya salah:

**❌ Yang paling longgar menang.** Menambah satu aturan halus diam-diam
melebarkan larangan kasar. `network: deny` berhenti berarti apa-apa begitu ada
satu `allow` di suatu tempat.

**❌ Yang paling ketat menang.** Aman, tapi membuat dimensi argumen tidak
berguna: `bash: ask` + `bash(git *): allow` tidak akan pernah bisa berarti
"tanya untuk bash, kecuali git".

**✅ Yang dipakai:**

1. **`deny` setingkat ATURAN adalah tembok mutlak.** Tidak ada yang bisa
   membukanya. Bentuknya eksplisit: `"network(*)": "deny"`.

   **Direvisi beberapa jam kemudian:** aturan ini semula juga berlaku untuk
   `deny` setingkat KELAS, dan itu keliru. Lihat "Revisi" di bawah.
2. **Di antara `ask` dan `allow`, yang paling spesifik menang.** Diukur dari
   karakter bukan-wildcard, **bukan urutan di berkas** — urutan adalah hal yang
   paling mudah berubah tanpa disengaja.
3. **Seri dimenangkan `ask`.** Dua aturan sama spesifik yang bertentangan adalah
   config ambigu, dan menebak ke arah longgar pada yang ambigu adalah cara
   membuat izin yang tidak pernah user maksud.

Dimensi situasi **hanya boleh mengetatkan**: ia mengubah `allow` jadi `ask`,
tidak pernah sebaliknya. Perulangan tidak pernah mengizinkan apa pun.

## Syarat yang saya tetapkan sendiri, dan kenapa

> **Penilaiannya harus SATU fungsi.**

Bug allowlist (#12) terjadi karena logika pencocokan hidup terpisah dari apa
yang ia klaim cocokkan, dan gejalanya diam. Tiga dimensi berarti tiga kesempatan
mengulangnya.

Karena itu seluruh keputusan ada di `decide()` (`src/core/decide.ts`), dan
`ask()`, `titah permission explain`, serta test memanggil fungsi yang **sama**.
Yang dijelaskan tidak bisa berbeda dari yang dijalankan.

---

## 1. Dimensi argumen

```jsonc
"permission": {
  "bash": "ask",
  "rules": {
    "bash(git *)": "allow",
    "bash(git push *)": "deny",
    "network(https://docs.*)": "allow",
    "delete(build/*)": "allow",
    "mcp(github/*)": "allow"
  }
}
```

Untuk `bash`, setiap **segmen** dinilai dan semuanya harus lolos — aturan #12,
sekarang hidup di dalam `decide()` alih-alih di pemanggilnya, dan sekarang
berlaku untuk `deny` juga.

Untuk sumbu lain, tool menyediakan `subject`: path untuk `edit`/`write`/`delete`,
URL untuk `network`, `server/tool` untuk `mcp`.

## 2. `external_directory`

**Config-only, bukan ditanyakan saat berjalan.** Ini penyimpangan sadar dari
opencode, dan alasannya dua:

`resolveInside` dipanggil sinkron dari dalam sebelas tool. Menjadikannya bisa
bertanya berarti menjadikannya async dan menyalurkan mesin izin ke setiap tool
berkas.

Lebih penting: batas cwd sekarang **tembok struktural yang tidak bisa salah**.
Menjadikannya keputusan saat berjalan menukar jaminan dengan kebijakan. Bentuk
ini menahan sebagian besar jaminannya — himpunan akar sah ditetapkan sekali saat
config dimuat, dan tidak ada yang bisa menambahnya di tengah giliran.

Tidak ada bentuk `allow` umum. Setiap akar disebut satu per satu, dan daftar
kosong berarti perilaku lama persis.

## 3. `doom_loop`

Bukan fitur izin — ia butuh **deteksi perulangan** lebih dulu (`src/core/loop.ts`).

Yang dideteksi: panggilan **identik** yang muncul tiga kali dalam sepuluh
panggilan terakhir. Tiga, bukan dua: dua panggilan identik itu biasa dan sah —
baca, sunting, baca lagi untuk memastikan. Yang ketiga sudah pola.

Yang **tidak** dideteksi, dan dinyatakan alih-alih disamarkan: siklus banyak
langkah yang tiap anggotanya berbeda, dan pengulangan yang argumennya berubah
sedikit tiap kali. Deteksi yang mengaku menangkap semua perulangan membuat user
berhenti waspada terhadap yang lolos.

Jendelanya dibersihkan tiap giliran baru: perulangan adalah properti satu
giliran.

## 4. `titah permission explain`

**Wajib, bukan pemanis.** Dengan enam sakelar user bisa memegang postur
keamanannya di kepala; dengan tiga dimensi ia tidak bisa. Presisi yang tidak bisa
diaudit hanyalah rasa aman.

```
$ titah permission explain bash "git push origin main"

bash: git push origin main

  class policy   bash = "ask"
  segments       "git push origin main"
  decided by     rule "bash(git push *)"
  also matched   "bash(git *)" = allow (less specific)

  → DENY
    Denied by rule "bash(git push *)".
```

`bash` dijelaskan **per segmen**, sama seperti saat sungguhan — menjelaskan
perintah berantai sebagai satu kesatuan akan memberi jawaban yang berbeda dari
yang akan terjadi, persis kegagalan yang perintah ini ada untuk mencegahnya.

---

## Satu bug yang ditemukan test, dan bentuknya khas

Versi pertama menyimpan grant "always" sebagai polanya saja, lalu membungkusnya
jadi `bash(...)` saat dipakai. Itu **memutus setiap grant non-bash**: `"edit"`
jadi `bash(edit)`, yang tidak pernah cocok dengan apa pun.

Gejalanya persis gejala #12 — grant yang diam-diam berhenti bekerja. Perbaikannya
menghapus tebakan itu: grant disimpan sebagai **aturan utuh** sejak awal
(`ruleSource`), jadi tidak ada titik di mana bentuknya perlu ditebak.

## Yang berubah pada pesan izin

Dari `Matched allowlist: "git *"` jadi `Allowed by rule "bash(git *)"`. Empat
test ikut diperbarui, dan itu perbaikan bukan kerusakan: pesannya sekarang
menyebut **aturan mana** yang memutuskan, yang merupakan seluruh alasan
`explain` ada.

## Revisi: kelas-deny jadi *default* deny

Ditemukan saat mengerjakan mode Plan, beberapa jam setelah dokumen ini ditulis.

Mode Plan ingin menyatakan hal yang paling wajar: **"tolak semua perintah shell,
kecuali yang benar-benar hanya membaca."** Dengan aturan asli itu **tidak bisa
diungkapkan sama sekali** — `bash: "deny"` menjadikan setiap `bash(git log*):
"allow"` mati.

Dan mati **tanpa suara**. Itu persis kelas kegagalan #12: aturan yang user
tulis, terlihat berlaku, tidak pernah menyala.

Jadi aturannya dipisah:

- **`deny` setingkat aturan** — tembok mutlak, tidak bisa dibuka apa pun.
- **`deny` setingkat kelas** — *default* deny; sebuah aturan `allow` yang
  eksplisit boleh mempersempitnya.

Ini bentuk yang dipakai firewall dan IAM, dan alasannya sama: default yang ketat
harus bisa punya pengecualian yang disebut satu per satu, kalau tidak orang akan
memakai `ask` sebagai gantinya — dan `ask` berarti user diganggu untuk hal yang
sudah ia putuskan.

Kekhawatiran yang melahirkan aturan asli tetap dijawab, hanya bentuknya jadi
eksplisit: `"network(*)": "deny"` adalah tembok yang tidak bisa dibuka.

## Revisi kedua: daftar putih shell dicabut dari mode Plan

Mode Plan sempat memakai daftar putih perintah baca — `git log`, `wc`, `rg`, dan
selusin lainnya. Atas permintaan user, itu diganti `bash: "allow"`.

Alasannya bukan bahwa daftar putihnya salah, melainkan bahwa **daftar putih
untuk shell adalah daftar yang tidak akan pernah selesai.** `npm run typecheck`,
`find`, `jq` — setiap alat yang tidak terpikir saat menulisnya ikut tertolak,
dan mode Plan jadi tidak bisa menganalisa dengan alat yang benar-benar dipakai
orang. Yang berguna dan yang merusak tidak bisa dipisahkan oleh nama perintah:
`git log` aman, `git checkout` tidak, keduanya `git`.

Ongkosnya nyata dan dicatat alih-alih disamarkan: **mode Plan tidak lagi
menjamin nol perubahan.** Yang ditegakkan Titah sekarang hanya bahwa TOOL berkas
menolak. Shell bisa menulis berkas, dan yang menahannya adalah prompt — yang
menyebut redirection, `sed -i`, dan `git checkout` satu per satu.

Deskripsi mode diubah dari "nothing is changed" jadi "no file edits", dan itu
bukan kosmetik: mode yang menjanjikan jaminan yang tidak ia tegakkan lebih buruk
daripada mode yang menyatakan batasnya.

## Hasil

| | Sebelum | Sesudah |
|---|---|---|
| Dimensi | 1½ (kelas + allowlist bash) | **3** |
| Sumbu | 6 | **8** (`external_directory`, `doom_loop`) |
| Aturan setingkat argumen | hanya bash, hanya allow | **semua sumbu, allow/ask/deny** |
| Bisa diaudit | tidak | **`titah permission explain`** |

Gate: typecheck bersih, **773/773 lulus** (dari 749).
