# Plugin

Plugin menyesuaikan **perilaku**, bukan menambah tool.

MCP sudah menutup jalur tool pihak ketiga. Yang belum tertutup adalah hal-hal
yang tidak berbentuk tool sama sekali: menjalankan pemformat sesudah tiap
`write`, menolak `edit` pada berkas tertentu, mencatat setiap panggilan tool ke
sistem audit sendiri. Sebelum ini, semuanya berarti fork.

## Sebelum apa pun: plugin adalah kode yang berjalan di dalam proses Titah

Tidak ada sandbox, dan tidak dijanjikan akan ada. Plugin bisa membaca berkas apa
pun yang bisa dibaca Titah, memanggil jaringan, dan melihat setiap masukan tool
sebelum Anda menyetujuinya.

Karena itu plugin **harus disebut satu per satu di config**. Tidak ada penemuan
otomatis dari `node_modules` — "terpasang" tidak pernah berarti "dipercaya".
Menyalakan sebuah plugin adalah keputusan kepercayaan yang setara dengan
`npm install`.

## Memasang

```jsonc
{
  "plugin": {
    "@acme/titah-audit": { "options": { "file": "audit.log" } },
    "./plugin/lock-migrations.mjs": {},
    "market:prettier": {}          // belum bisa — lihat "Marketplace"
  }
}
```

Tiga bentuk kunci:

| Bentuk | Artinya |
|---|---|
| `@acme/titah-audit` | paket npm, diresolusi dari `node_modules` **proyek Anda** |
| `./plugin/x.mjs` | berkas lokal, relatif terhadap direktori sesi |
| `market:<id>` | marketplace — tempatnya sudah ada, isinya belum |

`titah plugin list` memuatnya sungguhan lalu melaporkan apa yang disediakan
masing-masing, dan apa yang gagal. Membaca config saja tidak cukup: plugin yang
tertulis tapi tidak bisa di-`import` terlihat sama dengan yang bekerja.

## Menulis satu

Sebuah plugin mengekspor **factory** sebagai default export.

```js
export default function ({ cwd, config, options }) {
  return {
    name: "lock-migrations",

    // Berjalan SEBELUM dialog izin.
    "tool.before": ({ tool, input }) => {
      if (tool === "edit" && String(input.path).startsWith("db/migrations/")) {
        return { deny: "migrasi yang sudah jalan tidak boleh disunting" }
      }
    },

    // Berjalan setelah tool selesai, sebelum pemeriksa bawaan.
    "tool.after": ({ tool, output }) => {
      if (tool === "bash") return `${output}\n[dicatat]`
    },
  }
}
```

Factory boleh `async`. `options` adalah apa yang Anda tulis di config, apa
adanya — bentuknya milik plugin.

## Dua kait, dan urutannya menentukan

### `tool.before` — sebelum izin

Ia berjalan **sebelum dialog izin**, bukan sesudah. Kalau sesudah, plugin yang
mengubah masukan akan membuat Anda menyetujui satu hal lalu sesuatu yang lain
yang dijalankan — dan itu membatalkan seluruh arti dialog izin.

Kembalikan:

- `{ deny: "alasan" }` — panggilan dihentikan, izin tidak pernah ditanyakan
- `{ input: <baru> }` — masukan diganti, dan **yang muncul di dialog adalah yang
  baru**
- apa pun selain itu (termasuk tidak mengembalikan apa-apa) — lanjut

Beberapa plugin berjalan **berurutan**, dan yang kedua melihat masukan yang
sudah diubah yang pertama. Paralel akan membuat hasilnya bergantung pada siapa
yang selesai lebih dulu.

**Plugin yang melempar di sini berarti MENOLAK.** `tool.before` adalah penjaga;
penjaga yang rusak lalu diabaikan sama saja dengan tidak ada penjaga — dan
kegagalannya persis terjadi pada panggilan yang mungkin justru ingin ia
hentikan.

### `tool.after` — setelah tool, sebelum pemeriksa bawaan

Kembalikan string untuk mengganti keluaran, atau tidak mengembalikan apa pun
untuk membiarkannya.

Ia berjalan **sebelum** formatter LSP dan diagnostics bawaan. Dengan urutan itu,
plugin yang menulis ulang berkas sudah selesai ketika diagnostics dijalankan,
jadi yang dilaporkan adalah keadaan berkas yang sebenarnya.

**Plugin yang melempar di sini DIABAIKAN** — kebalikan dari `tool.before`. Kait
ini hanya membentuk keluaran yang sudah terjadi; membuang hasil tool yang
berhasil karena pencatat log-nya rusak menghilangkan pekerjaan sungguhan demi
hal yang tidak esensial.

## Kegagalan tidak menjatuhkan sesi

Plugin yang gagal dimuat kehilangan kaitnya, sesinya tetap jalan, dan Anda
diberi tahu sekali lewat notice — aturan yang sama dengan server MCP yang mati.
Sesi yang menolak dimulai karena satu plugin pencatat-audit rusak menghukum Anda
atas hal yang tidak Anda minta saat itu.

`"enabled": false` membuat modulnya **tidak di-`import` sama sekali**, bukan
sekadar tidak dipakai — kode di level atas modul berjalan saat import.

## Yang perlu diketahui

Modul disimpan Node berdasarkan URL-nya. **Menyunting berkas plugin di tengah
sesi tidak berpengaruh sampai Titah dijalankan ulang.** Membuang cache akan
membuat setiap versi tetap tinggal di registry modul selama proses hidup, dan
untuk bentuk yang paling umum — paket npm yang berubah hanya saat dipasang
ulang — cache justru yang benar.

## Marketplace

Belum ada. Bentuknya sudah ada, dan itu disengaja.

`market:<id>` sudah dikenali `parsePluginSpec` hari ini dan **gagal dengan
kalimat yang menyebut keadaannya**, bukan diam-diam diperlakukan sebagai nama
paket npm yang berujung "module not found" — pesan yang menunjuk sebab yang
salah.

Menambahkan bentuknya belakangan berarti menebak bagaimana ia akan ditulis, dan
setiap tebakan yang salah menjadi perubahan yang memutus config orang. Yang
tersisa untuk mengaktifkannya hanyalah mengisi `resolveMarket`.

Satu keputusan sudah diambil sekarang karena ia menentukan bentuk config:
sebuah entri marketplace dipetakan ke paket npm **dan versi yang pasti**
(`MarketEntry`), supaya `market:prettier` di dua mesin berarti kode yang sama.
Registry yang mengembalikan "paket terbaru" tidak bisa memberi jaminan itu.
