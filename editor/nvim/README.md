# Titah untuk Neovim

Dua jalur, dan keduanya sengaja berbeda sifatnya.

`:Titah` membuka TUI-nya apa adanya di terminal split. Itu bukan kompromi —
TUI itu sudah punya izin, gulir, panel sub-agent, dan semua yang dibangun
berbulan-bulan. Menggambar ulang semuanya sebagai antarmuka Neovim berarti
membangun hal yang sama untuk kedua kalinya, lebih buruk.

`:TitahAsk` untuk yang **tidak** bisa dilakukan TUI: mengirim potongan yang
sedang dilihat — berkas ini, baris ini, seleksi ini — tanpa mengetik ulang path
dan nomor barisnya. Itu satu-satunya hal yang benar-benar hanya bisa diberikan
editor.

## Pasang

`lazy.nvim`:

```lua
{ dir = "/path/ke/titah/editor/nvim", config = function() require("titah").setup() end }
```

`packer` / `vim-plug` cukup menambahkan `editor/nvim` ke `runtimepath`.

Butuh `titah` di `PATH` dan `curl` (Neovim tidak punya klien HTTP bawaan).

## Perintah

| Perintah | Yang terjadi |
|---|---|
| `:Titah` | TUI di terminal split; pemanggilan kedua kembali ke split yang sama |
| `:Titah run "..."` | Argumen apa pun diteruskan ke `titah` |
| `:TitahAsk <tanya>` | Kirim seluruh berkas + pertanyaan, jawabannya mengalir ke buffer markdown |
| `:'<,'>TitahAsk <tanya>` | Sama, tapi hanya baris yang diseleksi |
| `:TitahStop` | Matikan server yang dinyalakan plugin ini |

## Konfigurasi

```lua
require("titah").setup({
  cmd = "titah",        -- ganti kalau tidak ada di PATH
  server = nil,         -- nil = nyalakan `titah serve` sendiri saat pertama dibutuhkan
  split = "vertical",   -- "vertical" | "horizontal" | "tab"
  size = 0.4,           -- pecahan lebar/tinggi layar
})
```

`server` yang diisi berarti plugin ini tidak pernah menyalakan proses sendiri —
pakai itu kalau sudah ada `titah serve` yang berjalan dan ingin berbagi sesi.

## Yang perlu diketahui

Port `titah serve` **acak** secara bawaan, jadi plugin ini membacanya dari
keluaran perintahnya alih-alih menebak. Kalau `titah serve` gagal, `:TitahAsk`
melapor dan berhenti — ia tidak diam-diam mencoba port lain.

`titah serve` **tidak punya autentikasi**. Plugin ini selalu mengikatnya ke
`127.0.0.1`, dan sebaiknya tetap begitu.

## Uji

```bash
cd editor/nvim
nvim --headless --clean --cmd "set rtp+=$PWD" -l test/titah_spec.lua
```

Uji yang sama ikut berjalan di `npm test` lewat `test/nvim.test.ts`, dan
dilewati kalau Neovim tidak terpasang.
