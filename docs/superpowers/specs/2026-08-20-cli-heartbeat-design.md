# Heartbeat: CLI akhirnya mengisi dashboard-nya sendiri

Design, 2026-08-20. Baseline: `docs/align-with-code` @ `f558029`, 1242 test hijau.

Menjawab: *"kenapa dashboard tidak membaca project, analytic, session, dan agent
saat titah dijalankan padahal saya sudah login?"* — lalu diminta mengerjakan
bagian pertamanya.

## Keadaan awal

titah-web punya `apps/tracking` yang lengkap: model, endpoint, halaman dashboard,
72 test hijau. CLI-nya tidak pernah memanggil satu pun dari itu.

Buktinya satu baris di `account.ts`:

```ts
function endpoint(server: string, route: string): string {
  return `${server}/cli/${route}`
}
```

Empat pemanggilnya — `device/`, `token/`, `userinfo/`, `revoke/` — semuanya milik
alur login RFC 8628. Tidak ada `/api/`. Di `dist/` yang benar-benar jalan pun
tidak ada string `heartbeat`, `api/projects`, maupun `sessions/sync`.

Di database produksi: 5 baris `cliauth_token` (login jalan, 3 masih aktif),
`Project` 0, `ProjectActivity` 0, `Session` 0. Bukan query yang gagal menampilkan
— memang tidak ada barisnya.

Jadi yang dibangun di sini adalah pengirimnya. Bukan fitur baru di server.

## Yang TIDAK dikerjakan di sini

- **Session sync.** Upload transkrip punya sumbu izinnya sendiri (`sync_enabled`
  per project, dikendalikan dari web) dan risiko yang berbeda kelas. Menyusul.
- **Dua halaman placeholder.** `/dashboard/sessions/` dan `/dashboard/agents/`
  merender teks statis dan tidak menyentuh database sama sekali. Heartbeat tidak
  mengubah keduanya, dan itu harus dikatakan supaya tidak ada yang mengira
  halaman itu akan ikut terisi.

## Bentuk data

Payload mengikuti kontrak `heartbeat` yang sudah ada, apa adanya:

```json
{
  "path_hash": "sha256 dari path absolut ternormalisasi",
  "name": "titah",
  "language": "typescript",
  "git_remote_url": "git@github.com:titah-dev/titah.git",
  "git_branch": "main",
  "cli_version": "0.2.0",
  "stats": { "total_sessions": 74, "total_tokens": 30283249, "total_cost_usd": 12.34 }
}
```

### Angkanya tidak dihitung ulang

`collectStats(config, { directory })` sudah menghasilkan `sessions`, `input`,
`output`, dan `cost` untuk satu folder — itu yang dibaca `titah stats`.
Heartbeat memakai fungsi yang sama.

Ini bukan sekadar hemat kode. Repo ini berkali-kali kena satu kelas bug yang
sama: **yang diukur bukan yang dikirim.** Kalau heartbeat menghitung sendiri,
angka di dashboard dan angka di `titah stats` akan menyimpang, dan tidak ada
yang tahu mana yang benar sampai seseorang membandingkannya.

`total_tokens` = `input + output`. `total_cost_usd` = `cost`, yang menurut
definisi `collectStats` hanya menjumlahkan model yang **punya** `price`. Model
tanpa harga tidak dihitung nol — ia tidak dihitung. Sama seperti di `titah stats`.

### Identitasnya juga tidak didefinisikan ulang

`path_hash` = `sha256(projectKey(directory))`, dan `projectKey()` adalah fungsi
yang sudah dipakai titah untuk mengelompokkan sesi per folder. Server sudah
meminta "SHA256 of the absolute normalised project path", jadi keduanya cocok
tanpa penyesuaian.

Kalau heartbeat menormalkan path dengan caranya sendiri, `~/proj` dan `~/proj/`
bisa jadi dua baris di dashboard sementara lokal keduanya satu sesi yang sama.

### Yang benar-benar baru: `describeProject()`

Nama, bahasa, dan git. Nama diambil dari `name` di `package.json`,
`pyproject.toml`, `go.mod`, `Cargo.toml`, atau `composer.json`; kalau tidak ada,
nama foldernya. Bahasa dari file yang sama. Git dari `git config --get`.

Semuanya gagal-diam ke string kosong. Folder tanpa git bukan kesalahan, dan
heartbeat yang batal karena `git` tidak terpasang adalah heartbeat yang tidak
pernah terkirim di setengah mesin.

## Kapan dikirim

Menempel di `bus` pada `session.idle` — event yang **sudah** terbit tiap giliran
selesai (`agent.ts:1417` dan empat tempat lain). Tidak ada perubahan di
`agent.ts`.

Satu pelanggan bus menutup dua topologi sekaligus: `titah run` menjalankan core
di dalam proses, `titah serve` (dan TUI yang men-spawn-nya) di proses server.
Keduanya menerbitkan event yang sama.

### Sesi anak dilewati

`session.idle` juga terbit untuk sesi sub-agent. Satu `/tim` bisa menerbitkan
belasan. Yang dihitung hanya sesi tanpa `parent_id` — giliran yang benar-benar
kamu jalankan.

### Debounce disimpan di SQLite, bukan di memori

5 menit per project. Yang penting bukan angkanya, melainkan **di mana ia
disimpan**.

❌ **Di memori proses.** `titah run` adalah satu proses per giliran, jadi debounce
di memori tidak akan pernah menyala di sana — skrip yang memanggil `titah run`
seratus kali mengirim seratus request. Debounce yang hanya bekerja di TUI adalah
debounce yang gagal justru di kasus yang paling membutuhkannya.

❌ **File JSON di data dir.** Bisa, tapi dua proses yang selesai bersamaan saling
menimpa, dan sudah ada tempat yang menangani itu.

✅ **Tabel di SQLite yang sudah ada**, lewat migrasi `user_version` yang sudah
ada. Satu baris per project. Ikut terhapus bersama database, tidak perlu
retensi sendiri.

### Fire-and-forget

Timeout 5 detik. Giliran tidak pernah menunggunya dan tidak pernah gagal
karenanya. Heartbeat adalah metadata; kalau ia sanggup menggagalkan pekerjaan,
ia berubah dari fitur jadi risiko.

## Config

```jsonc
{
  "tracking": {
    "enabled": true,
    "exclude": [],
    "git": true
  }
}
```

### Kenapa blok sendiri, bukan di dalam `account`

❌ **`account.tracking`.** Permukaan config lebih sedikit, tapi mencampur "siapa
saya" dengan "apa yang direkam". `account` sendiri `optional()` di schema, jadi
"tanpa akun tapi jelas tanpa tracking" jadi canggung ditulis. Dan `titah logout`
tidak boleh diam-diam mengubah arti pengaturan yang bukan tentang login.

✅ **Blok `tracking` sendiri.** Ini idiom yang sudah dipakai schema titah: tiap
concern punya sumbu sendiri supaya menyetujui satu hal tidak diam-diam
menyetujui hal lain. `network` bukan rasa dari `bash`; tracking bukan rasa dari
`account`.

Namanya `tracking`, bukan `heartbeat`, supaya session sync bisa masuk ke blok
yang sama nanti tanpa mengganti nama apa pun.

### Empat cara mematikan

| Cara | Cakupan |
|---|---|
| Tidak login | Tidak pernah kirim — tidak ada token, tidak ada tujuan |
| `tracking.enabled: false` di config global | Semua project |
| `tracking.enabled: false` di `./titah.json` | Project itu saja |
| `tracking.exclude: ["~/clients/*"]` | Path bernama |

Yang ketiga **gratis**. Titah sudah me-merge config global dengan `./titah.json`
per project, jadi opt-out per project tidak butuh mesin baru sama sekali — dan
ia ikut pindah bersama repo kalau di-clone ke tempat lain.

Yang keempat ada untuk kasus yang tidak tertutup ketiga: folder sensitif yang
kamu tidak mau taruhi file `titah.json` sama sekali.

`exclude` memakai `matchesPattern()` yang sama dengan `permission.allowlist` —
**satu dialek glob di seluruh config, bukan dua**. Di matcher itu `*` sudah
melintasi `/`, jadi `~/clients/*` mencakup `~/clients/acme/api`. `~`
diekspansi lebih dulu.

### `tracking.git`

Satu-satunya sumbu di luar yang diminta. URL remote sering menyebut nama klien,
dan itu membocorkan lebih banyak daripada "ada folder bernama api". `false`
menghilangkan `git_remote_url` dan `git_branch` dari payload; sisanya tetap
terkirim.

### Bawaannya nyala, dan kenapa itu pengecualian

Changelog 0.2.0 menulis "every new axis is off or absent by default". Ini
melanggarnya, dengan sengaja: **login itu sendiri yang jadi tindakan opt-in.**
Menuntut dua langkah berarti dashboard tetap kosong bagi orang yang sudah
melakukan satu-satunya langkah yang terlihat seperti persetujuan.

Yang dijaga: tanpa login, tidak ada yang terkirim, dan tidak ada cara
menyalakannya tanpa login. `tracking.enabled: true` di mesin yang tidak login
tidak melakukan apa-apa.

## Kalau gagal

Diam. Tidak ada notice, tidak ada retry, tidak ada satu karakter pun ke stdout
maupun stderr — berhasil atau gagal.

Alasannya bukan kerapian. `titah run --output-format json` menjanjikan bahwa
tidak ada apa pun untuk manusia yang menyentuh stdout; satu baris "heartbeat
sent" merusak `JSON.parse` milik pemanggil, dan pemanggilnya tidak punya cara
menebak bahwa yang salah adalah barisnya, bukan datanya. Ke stderr pun tetap
mengganggu skrip yang menggabungkan keduanya.

Yang ada sebagai gantinya: **`~/.config/titah/tracking.log`**, satu baris per
percobaan, append-only.

> Konvensi repo sebenarnya menaruh log di `logDir()` (`~/.local/share/titah/log`)
> — `~/.config` untuk hal yang kamu tulis sendiri, log adalah state. Lokasi ini
> diminta eksplisit oleh user. Satu konstanta di `tracking.ts`, gampang dipindah.

`titah doctor` melaporkan keadaannya: nyala/mati, alasan kalau mati, dan kapan
terakhir terkirim. Itu perintah yang dijalankan sendiri oleh user, bukan pesan
yang muncul di tengah pekerjaan.

## Tes

`test/tracking.test.ts`, tanpa jaringan sungguhan — server HTTP lokal di port 0,
`XDG_*` diarahkan ke temp dir, pola yang sama dengan `account.test.ts`.

- payload persis kontrak server, dari fixture DB
- `total_tokens` dan `total_cost_usd` sama dengan yang dilaporkan `titah stats`
  untuk folder yang sama — satu penggaris, bukan dua
- tidak login → tidak pernah kirim, meski `enabled: true`
- `enabled: false` global → tidak kirim
- `./titah.json` menimpa global
- `exclude` cocok, termasuk ekspansi `~`
- `git: false` menghilangkan dua field, sisanya tetap
- idle kedua dalam 5 menit tidak kirim; sesudah jendela, kirim
- debounce bertahan lintas proses (baris SQLite, bukan memori)
- sesi anak tidak memicu
- server mati / timeout tidak menggagalkan turn
- tidak ada byte apa pun ke stdout maupun stderr, berhasil maupun gagal
- gagal tetap tercatat satu baris di log

## File yang tersentuh

| File | Perubahan |
|---|---|
| `src/core/tracking.ts` | baru — payload, gerbang, debounce, kirim, log |
| `src/core/schema.ts` | blok `tracking` |
| `src/core/storage/db.ts` | satu entri migrasi, tabel `tracking` |
| `src/cli.ts` | dua baris wiring (`cmdRun`, `cmdServe`) + bagian doctor |
| `test/tracking.test.ts` | baru |
| `config.schema.json` | regenerate |
| `README.md` | bagian Tracking |
| titah-web `content/docs/project-tracking.md` | dari "belum ada" jadi ada |
