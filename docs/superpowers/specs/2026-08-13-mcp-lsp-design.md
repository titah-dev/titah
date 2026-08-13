# MCP dan LSP: satu transport, dua protokol

Design + hasil, 2026-08-13. Baseline: `main` @ `2142b44`, 730 test hijau.

Menjawab dua permintaan sekaligus:

1. *"Pemeriksa proyek menggunakan 3 konsep — `diagnostics`, LSP otomatis,
   ekstensi IDE. Apakah memungkinkan ketiganya?"*
2. *"Kemudian kerjakan MCP-nya."*

## Jawaban atas pertanyaan pertama

**Dua bisa penuh, yang ketiga hanya separuh** — dan itu dikonfirmasi ke user
sebelum dikerjakan, sesuai permintaannya.

| Konsep | Status | Alasan |
|---|---|---|
| `diagnostics` | sudah ada | menjalankan perintah yang user nyatakan |
| **LSP otomatis** | dikerjakan | butuh klien JSON-RPC stdio |
| **Ekstensi IDE** | **ditunda** | ekstensinya paket VSIX/JetBrains **di luar repo ini**, tidak bisa dibangun maupun diverifikasi dari sesi headless |

Yang bisa dibangun untuk konsep ketiga hanyalah **sisi penerimanya** — endpoint
tempat IDE mendorong diagnostics. Tanpa ekstensinya, endpoint itu tidak punya
klien: kode yang terverifikasi test tapi tidak pernah dipanggil siapa pun.

User memilih **melewatinya**, dan mengerjakan LSP + MCP saja. Keputusan itu
dicatat di sini supaya orang berikutnya tidak mengira konsep ketiga terlupakan.

## Kenapa keduanya dikerjakan bersamaan

Bukan kebetulan, dan bukan sekadar efisiensi: **MCP dan LSP adalah protokol yang
sama dengan pesan berbeda.** Keduanya JSON-RPC 2.0 lewat stdin/stdout sebuah
proses anak.

Yang berbeda hanya pembingkaiannya:

| | Pembingkaian |
|---|---|
| LSP | `Content-Length: N\r\n\r\n{…}` |
| MCP | satu objek JSON per baris |

Karena itu `src/core/rpc.ts` menerima pembingkaian sebagai **parameter**, bukan
punya dua salinan protokol. Dua salinan berarti perbaikan pada penanganan
permintaan yang saling menyusul hanya mendarat di salah satunya, dan yang
tertinggal gagal dengan cara yang sulit dilacak justru ketika sedang sibuk.

`docs/gap-analysis.md` sudah menduga ini sebelum keduanya ada: *"fondasinya
sudah ada di `delegate/` — subprocess dengan protokol dan adapter adalah barang
yang sama dengan pesan berbeda."* Dugaan itu benar, hanya tempatnya berbeda:
yang bisa dipakai ulang bukan `delegate/`, melainkan bentuk umumnya.

---

## MCP

### Batasnya, dinyatakan

**Hanya stdio, hanya `tools`.** Bukan karena `resources` dan `prompts` tidak
berguna, melainkan karena keduanya bukan yang menutup gap-nya: server MCP yang
dipasang orang hampir selalu stdio, dan yang dicari darinya hampir selalu tool.

Menyatakan batas itu lebih baik daripada membangun setengah dari segalanya —
yang setengah jadi terlihat sama dengan yang jadi, sampai dipakai.

### Sumbu izin sendiri

Tool MCP memakai sumbu `mcp`, bukan menumpang `edit`/`bash`/`network`.

Alasannya bukan kehati-hatian berlebihan: **tool MCP adalah kode yang tidak
ditulis Titah dan tidak bisa diklasifikasikan Titah.** Sebuah server boleh
menulis berkas, memanggil API berbayar, atau keduanya. Memaksanya ke salah satu
sumbu yang ada berarti user memberi izin untuk hal yang berbeda dari yang
sebenarnya terjadi — dan itu lebih buruk daripada tidak punya sumbu sama sekali,
karena ia terlihat seperti kendali.

Dialognya menyatakan keadaannya apa adanya: *"This is third-party code. Titah
cannot see what it does."*

### Nama diberi awalan

`<server>_<tool>`. Dua server yang sama-sama menawarkan `search` adalah kejadian
biasa, dan tanpa awalan yang kedua menimpa yang pertama tanpa ada yang tahu.

### Skema sengaja longgar

Skema masukan tool MCP diterjemahkan jadi `z.object({}).passthrough()` — menerima
apa pun, meneruskan apa adanya.

Menerjemahkan JSON Schema sembarang ke Zod dengan setia adalah proyek
tersendiri, dan terjemahan yang **tidak setia justru menolak panggilan yang
sah** — kegagalan yang muncul sebagai "tool-nya rusak" padahal yang rusak
penerjemahnya. Validasi sesungguhnya tetap terjadi di tempat yang memang
memilikinya: server MCP itu sendiri. Skema aslinya ikut dikirim ke model sebagai
teks, jadi model tetap tahu bentuk yang diharapkan.

### Server rusak tidak menjatuhkan giliran

Server MCP dipasang user dan bisa rusak karena hal yang sama sekali tidak
berhubungan dengan Titah: biner hilang, kunci kedaluwarsa, versi protokol
berbeda. Satu server rusak kehilangan tool-nya dan **alasannya disebutkan
sekali** lewat notice. `stderr` server disimpan dan ikut dilaporkan — ketika
sebuah server gagal menyala, satu-satunya penjelasan yang pernah ada biasanya
di sana.

---

## LSP

### Yang dipakai, dan yang tidak

Hanya `initialize`, `didOpen`/`didChange`, dan `publishDiagnostics`. Tidak ada
completion, hover, rename, atau go-to-definition.

Semuanya berguna untuk manusia yang mengetik, dan **tidak satu pun berguna untuk
model yang menyunting lewat `edit`.** Membangun LSP client penuh berarti
membangun editor; yang dibutuhkan di sini adalah pemeriksa.

### "Otomatis" letaknya di mana

Di `buildTools` (`agent.ts`), bukan di dalam masing-masing tool. Setelah `edit`,
`patch`, `write`, atau `move` berhasil, diagnostics untuk berkas itu ditempelkan
ke hasil tool.

Di satu tempat, karena aturannya sama untuk semuanya — menyalinnya ke tiap tool
berarti tool keempat yang menulis berkas akan melupakannya.

Yang dilihat model jadi: hasil suntingannya, lalu error yang baru saja ia buat.
Tanpa perlu ingat memanggil apa pun. Itu menutup pola yang sudah terlihat
berkali-kali: perubahan tampak benar, suite hijau, rusaknya ketahuan belakangan.

### `undefined` ≠ array kosong

Ini pembedaan yang paling mudah dihapus tanpa sengaja, dan paling mahal kalau
dihapus:

- **`undefined`** — tidak tahu. Tidak ada server untuk bahasa ini, atau ia belum
  sempat menjawab.
- **`[]`** — sudah diperiksa, dan bersih.

Menyamakan keduanya membuat "belum diperiksa" terbaca sebagai "tidak ada
masalah". Itu kebohongan paling mahal yang mungkin terjadi di sini, karena ia
muncul persis saat model paling percaya diri.

### Menunggu kondisi, bukan durasi

Language server menganalisis secara asinkron, dan kecepatannya bergantung ukuran
proyek. `setTimeout(300)` akan lulus di repo kecil dan **diam-diam melewatkan
temuan di repo besar** — justru tempat temuannya paling berharga. Jadi yang
ditunggu adalah datangnya notifikasi, dengan batas waktu sebagai jaring.

Pelajaran ini datang dari flake `tui-input` yang sudah dua kali ditutup.

### `didOpen` sekali, `didChange` sesudahnya

Server menolak `didOpen` kedua untuk URI yang sama, dan **penolakan itu diam**:
diagnostics berhenti diperbarui tanpa ada yang tahu. Dipaku test yang menyunting
berkas yang sama dua kali.

---

## Yang diuji, dan bagaimana

Test menjalankan **server sungguhan** — skrip node kecil yang bicara
protokolnya — bukan mock dari klien yang sedang diuji. Mock hanya membuktikan
klien berbicara dengan dirinya sendiri; yang perlu dibuktikan adalah ia
berbicara dengan proses lain lewat stdio, karena di situlah pembingkaian,
pemotongan potongan, dan kematian proses benar-benar terjadi.

Termasuk yang paling menyusahkan: satu pesan dikirim **per byte**, untuk
membuktikan perakitannya benar.

## Hasil

| | Sebelum | Sesudah |
|---|---|---|
| Tool bawaan | 21 | 21 + **berapa pun yang ditawarkan server MCP** |
| Sumbu izin | 5 | **6** (`mcp`) |
| Diagnostics | hanya kalau model ingat memanggil | **otomatis setelah tiap suntingan** |
| Transport JSON-RPC | tidak ada | satu, dipakai dua protokol |

Gate: typecheck bersih, **749/749 lulus** (dari 730).
