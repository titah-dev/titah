# Extension

Extension menyesuaikan **tampilan**, bukan perilaku.

Titah sudah punya dua jalan untuk mengubah perilaku: `plugin` (kode npm yang
mengait `tool.before`/`tool.after`) dan `hooks` (perintah shell di titik kait
yang sama). Yang belum tertutup adalah hal yang tidak berbentuk perilaku sama
sekali: melihat branch git tanpa keluar dari sesi, membaca daftar worktree,
menengok diff yang baru ditulis agent. Sebelum ini, semuanya berarti terminal
kedua.

## Kenapa `extension`, dan bukan `plugin`

`plugin` sudah dipakai, dan artinya berbeda: ia berjalan di sisi server dan
mengait panggilan tool. Menyebut keduanya `plugin` berarti dua benda dengan dua
batas kepercayaan yang berbeda memakai satu kata di satu berkas config.

`bundle` sengaja **tidak** dipakai, meski ia kata yang paling menggoda. Titah
sudah punya bahan untuk konsep agregat — skill, command, agent, hook, mcp,
extension — dan kalau agregat itu suatu hari dibuat, `bundle` adalah satu-satunya
nama yang orang akan langsung mengerti untuk itu. Memakainya sekarang untuk
panel berarti agregat nanti kehabisan nama. Urutan itu tidak bisa dibalik.

`package` juga bukan pilihan: setiap extension **adalah** npm package, dan
"package not found" jadi kalimat yang menunjuk dua sebab berbeda.

## Sebelum apa pun: extension adalah kode yang berjalan di dalam proses TUI

Tidak ada sandbox. Extension bisa membaca berkas apa pun yang bisa dibaca Titah
dan memanggil jaringan, dan ia berjalan di proses yang memegang `auth.json`.

Karena itu extension **harus disebut satu per satu di config**, sama seperti
`plugin`. Tidak ada penemuan otomatis. Yang berubah dari `plugin` hanyalah
cara memasangnya jadi lebih murah — bukan siapa yang memutuskan.

## Yang tidak pernah bisa disentuh

Extension boleh menimpa tampilan dan masukan. Ia **tidak** bisa menjangkau:

| Tidak terjangkau | Kenapa |
|---|---|
| `permission.ts` | `setAutoApprove(sessionID, true)` mematikan seluruh dialog izin dalam satu panggilan. Extension yang bisa memanggilnya membuat "pilih di picker lalu tekan `I`" setara dengan menyerahkan shell |
| `auth.ts`, `account.ts` | Kredensial provider dan identitas akun |
| Tool dispatch di `agent.ts` | Apa yang disetujui user harus sama dengan apa yang dijalankan |

Batas ini ditegakkan oleh **bentuk entry point publik, bukan oleh dokumen**: yang
tidak diekspor tidak bisa di-`import`, dan yang tidak bisa di-`import` tidak bisa
dipanggil. Extension tidak boleh `import` dari `src/` sama sekali — hanya dari
entry point publik `titah-code/extension`.

Ini pola yang sama dengan yang membuat marketplace VS Code bisa dipercaya:
extension di sana dapat API yang luas dan daftar yang tidak bisa disentuh.
Bukan API yang luas dan janji akan berhati-hati.

## Memasang

```jsonc
{
  "extension": {
    "@titah/extension-git": {
      "side": "left",
      "key": "<leader>g",
      "options": { "branchLimit": 12, "worktrees": true }
    },
    "./extension/notes": {},
    "market:todo": {}
  },

  "panel": {
    "floor": 40,
    "left": { "width": 20 },
    "right": { "width": 20 }
  }
}
```

Tiga bentuk kunci, sama dengan `plugin`:

| Bentuk | Artinya |
|---|---|
| `@titah/extension-git` | npm package, diunduh Titah ke direktorinya sendiri |
| `./extension/notes` | berkas lokal, relatif terhadap direktori sesi |
| `market:<id>` | entri registry, dipetakan ke npm package **dan versi yang pasti** |

```
titah extension list             apa yang terpasang, dimuat SUNGGUHAN
titah extension install <pkg>    unduh, lalu tulis ke config
titah extension update [<pkg>]   pindahkan lockfile ke versi terbaru yang KOMPATIBEL
titah extension remove <pkg>     cabut, lalu buang dari config
```

`list` memuatnya sungguhan lalu melaporkan apa yang disediakan masing-masing, dan
apa yang gagal. Membaca config saja tidak cukup: extension yang tertulis tapi
tidak bisa di-`import` terlihat sama dengan yang bekerja.

`install` mengunduh **lalu** menulis ke config, dalam urutan itu. Ditulis lebih
dulu, unduhan yang gagal meninggalkan config yang menyebut extension yang tidak
ada — dan sesi berikutnya membuka dengan notice kegagalan untuk sesuatu yang user
tidak tahu pernah tercatat.

**Path lokal tidak diunduh sama sekali.** `titah extension install ./x` hanya
membaca manifestnya — supaya path yang salah tulis gagal saat itu, bukan sebagai
notice saat sesi berikutnya dibuka — lalu mencatatnya di config **proyek**, bukan
config global: path relatif hanya berarti sesuatu dari direktori tempat ia
ditulis. Menyerahkannya ke `npm install` akan menyalinnya ke `node_modules` milik
Titah, tempat loader tidak akan pernah mencarinya, dan hasilnya pemasangan yang
mengaku berhasil dengan panel yang tidak pernah muncul.

## Menulis satu

Sebuah extension mengekspor **factory** sebagai default export, sama seperti
`plugin`. Satu pola untuk dua sistem berarti orang yang sudah menulis `plugin`
tidak perlu mempelajari pola kedua.

`package.json`-nya:

```json
{
  "name": "@titah/extension-git",
  "type": "module",
  "engines": { "titah": "^0.3.0" },
  "titah": { "panel": "./dist/panel.js" }
}
```

`"type": "module"` bukan opsional dalam praktik: tanpa itu Node mengurai
berkasmu sebagai CommonJS, gagal, lalu mengurai ulang sebagai ESM dan mencetak
peringatan — jadi extension-nya jalan sambil memberi tahu setiap user bahwa ada
yang salah.

`titah.panel` dan `engines.titah` keduanya WAJIB.

Perhatikan angkanya. `engines.titah` harus menyebut versi pertama yang benar-benar
punya loader extension — bukan versi Titah tertua yang kebetulan ada. Menulis
`^0.2.0` membuat pemeriksaan LOLOS di Titah 0.2.0, yang tidak punya loader sama
sekali: extension terpasang, lalu tidak ada apa pun yang memuatnya, dan tidak ada
satu pun pesan yang menyebutkan kenapa.

Dan karena caret di bawah 1.0.0 mengunci minor (aturan npm), `^0.3.0` menolak
Titah 0.4.0. Itu bukan kekeliruan — selama API belum stabil, extension memang
harus dibaca ulang penulisnya setiap kali minor Titah naik. `titah.panel` adalah berkas yang di-`import`, dan
`engines.titah` diperiksa saat load — extension tanpa itu **ditolak**, bukan
diterima. Selama API masih 0.x ia berubah, dan paket yang tidak menyatakan versi
yang ia targetkan tidak bisa dibedakan dari paket yang ditulis dua rilis lalu.

Kodenya:

```js
export default function ({ cwd, options }) {
  return {
    title: "Git",
    side: "left",
    key: "<leader>g",

    // Dipanggil pada empat pemicu di bawah. Kembalikan View, bukan komponen.
    async render({ signal, width, rows }) {
      const branches = await listBranches(cwd, signal)
      return {
        kind: "rows",
        rows: branches.map((b) => ({ text: b.name, dim: !b.current })),
      }
    },

    // Opsional. Hanya dipanggil saat panel ini yang fokus.
    onKey({ key }) {
      if (key === "r") return { refresh: true }
    },
  }
}
```

Factory boleh `async`. `options` adalah apa yang ditulis user di config, apa
adanya — bentuknya milik extension.

`width` dan `rows` di `RenderRequest` sudah **bersih dari bingkai**: kalau
extension harus menguranginya sendiri, setiap extension menebak berapa yang
diambil bingkai — dan tebakan yang salah muncul sebagai teks yang membungkus,
dengan Titah yang disalahkan.

### Klik

```js
onClick({ row }) {
  const branch = drawn[row]
  if (branch === undefined) return
  selected = branch
  return { refresh: true }
}
```

`row` adalah indeks baris yang **digambar**, bukan indeks di dalam data
extension. Keduanya sama selama `render` mengembalikan satu baris per entri, dan
berbeda begitu extension menyisipkan baris pemisah atau baris petunjuk —
pemetaan itu milik extension, karena hanya ia yang tahu baris mana berarti apa.
Cara paling aman: bangun petanya dari baris yang **sama** dengan yang dikembalikan
`render`, bukan menghitungnya ulang dari state.

Klik **tidak menuntut fokus**. Klik sudah menyebutkan sasarannya sendiri, dan
memaksa fokus lebih dulu berarti klik pertama tidak melakukan apa pun — yang
terbaca sebagai panel yang tidak bisa diklik. Klik juga **memindahkan** fokus ke
panel itu, supaya tombol yang panelnya iklankan langsung bekerja sesudahnya.

Klik pada bingkai atau judul panel tidak mengenai baris apa pun, dan tidak
diteruskan ke riwayat di belakangnya.

`onKey` hanya dipanggil saat panel ini yang sedang **fokus** — `<leader>f`
menyerahkan papan tombol, `Esc` mengambilnya kembali tanpa menutup panelnya.

Pemisahan buka/fokus itu bukan hiasan: panel samping dibuka untuk dilihat sambil
bekerja, tidak seperti panel sub-agent yang memakan tombol selama terbuka. Kalau
membuka panel langsung berarti memakan tombol, membuka panel git berarti tidak
bisa mengetik prompt lagi — dan itu bukan tukar yang mau diambil siapa pun.

Selama fokus, tombol POLOS pergi ke panel dan tidak diteruskan ke editor.
Modifier tetap lolos, jadi ctrl+c, ctrl+d, dan gulir riwayat bekerja tanpa harus
melepas fokus lebih dulu — kalau tidak, memfokuskan panel mengunci user keluar
dari cara menghentikan giliran.

`signal` dibatalkan saat timeout dua detik habis atau panel ditutup. Teruskan ke
subprocess dan `fetch`: extension yang mengabaikannya tetap bekerja untuk hasil
yang tidak akan dipakai, dan pekerjaan itu bersaing dengan giliran agent di
proses yang sama.

### Kenapa `render` mengembalikan data, bukan JSX

Extension memang berjalan di proses TUI, jadi mengembalikan komponen Ink secara
teknis mungkin. Ia tidak dipilih karena dua hal yang tidak hilang:

Pertama, extension yang mengembalikan JSX butuh `react` dan `ink` sebagai peer
dependency dengan versi yang cocok. Menaikkan Ink 7→8 memecahkan setiap extension
sekaligus — versi Ink jadi bagian dari kontrak publik Titah, dan kamu tidak bisa
lagi menaikkannya tanpa major release.

Kedua, komponen React yang `throw` saat render menjatuhkan seluruh render tree,
bukan panelnya. View yang salah hanya data yang salah.

JSX bisa ditambahkan nanti kalau primitif view terbukti tidak cukup. Yang tidak
bisa dilakukan nanti adalah melepas Ink dari kontrak publik setelah orang
bergantung padanya.

### Primitif view

```
{ kind: "rows",     rows: [{ text, dim?, color?, selected? }] }
{ kind: "pairs",    pairs: [{ key, value }] }
{ kind: "markdown", text }
{ kind: "text",     text }
```

Daftarnya sengaja kecil. Panel git referensi adalah cara mengukur apa yang
sungguh kurang — menebak primitif sebelum ada satu pun panel yang memakainya
berarti mengirim API yang lebih besar dari yang bisa dijaga.

## Tombol bawaan

| Tombol | |
|---|---|
| `<leader>←` | buka/tutup panel kiri |
| `<leader>→` | buka/tutup panel kanan |
| `<leader>e` | segarkan kedua panel |
| `<leader>f` | serahkan papan tombol ke panel samping; `Esc` mengambilnya kembali |

Saat panel sedang fokus, tiga tombol **dipesan Titah** dan tidak pernah
diteruskan ke extension:

| | |
|---|---|
| `+` | lebarkan dua kolom |
| `-` | sempitkan dua kolom |
| `=` | kembali ke lebar dari config |

Diperiksa sebelum `onKey` karena kebalikannya membuat artinya bergantung pada
extension mana yang sedang fokus — `+` yang melebarkan panel git tapi melakukan
hal lain di panel orang lain adalah tombol yang tidak bisa dihafal.

Pelebaran **tidak bisa menembus lantai**: `+` berhenti saat riwayat mencapai
`panel.floor`. Tanpa batas itu, satu tekanan lagi membuat panel yang sedang kamu
lebarkan menutup sendiri — lantai bekerja seperti seharusnya, tapi dari tempat
user itu terbaca sebagai panel yang hilang karena dilebarkan.

Lebar hasil resize hidup di memori sesi, tidak ditulis ke config. `+`/`-`
ditekan berkali-kali dalam hitungan detik, dan menulis berkas user pada setiap
tekanan adalah tulisan yang tidak pernah ia minta. `=` mengembalikannya ke angka
config, jadi sumber kebenarannya tetap di sana.
| `<leader>x` | picker extension — cari dan pasang |

Ketiga panel Titah dijangkau lewat satu pola yang sama: leader lalu arah —
`<leader>↓` untuk panel sub-agent yang sudah ada sebelumnya, `←`/`→` untuk yang
samping. Tombol milik extension TIDAK ada di daftar ini; ia diusulkan
extension-nya sendiri dan muncul di menu leader di bawah aksi bawaan.

## Panel: sisi, lebar, dan lantai

Extension memilih `side` (`"left"` atau `"right"`); user boleh menimpanya di
config. Lebar dan lantai ada di blok `panel`, bukan di dalam kode Titah.

Dua extension yang menginginkan sisi yang sama: yang **pertama di config**
menang, dan yang kedua dilaporkan lewat notice. Urutan config adalah satu-satunya
urutan yang user bisa lihat dan ubah — memilih berdasarkan abjad atau waktu
pasang berarti pemenangnya tidak bisa dijelaskan kepada orang yang membaca
config-nya sendiri.

Default: 20 kolom kiri, 20 kolom kanan, lantai history 40 kolom. Di terminal 80
kolom itu berarti keduanya boleh terbuka dan history dapat tepat 40.

**Di bawah lantai, panel tertutup sendiri.** Bukan error, bukan pesan yang
meminta user melebarkan terminalnya. Fitur yang membuat fungsi utama tidak
terbaca lalu menyebutnya konfigurasi user adalah fitur yang merugikan orang yang
menyalakannya.

Lantai dan lebar keduanya nilai config karena angka yang benar belum diketahui.
Angka yang di-hardcode berdasarkan tebakan hari ini adalah angka yang berubah
lewat release, bukan lewat config.

## Keybinding: usulan, bukan klaim

Extension menuliskan tombol yang menurut pembuatnya pantas — ia yang tahu
panelnya. Tapi sembilan huruf leader sudah terpakai oleh Titah sendiri
(`b d l m n q r u` dan `down`), dan dua extension bisa memilih tombol yang sama.

Karena itu tombol adalah **usulan yang diperiksa saat install**. Kalau bentrok,
picker meminta user memilih ulang, dan hasilnya ditulis ke config. Tabrakan jadi
satu keputusan yang terlihat sekali, bukan misteri runtime yang pemenangnya
ditentukan urutan key di objek JSON.

## Refresh: empat pemicu, tanpa timer

Panel disegarkan saat:

1. prompt dikirim
2. `session.idle` — giliran selesai
3. panel dibuka
4. tombol refresh manual ditekan

Nomor 2 yang paling penting, dan ia sering terlewat. Panel diff paling usang
justru **setelah** agent menyunting berkas, bukan sebelum. Menyegarkan hanya
saat prompt dikirim berarti kamu melihat keadaan sebelum pekerjaan yang baru saja
kamu minta.

Tidak ada polling dan tidak ada fs-watch. Polling dengan interval yang
dideklarasikan extension berarti satu extension dengan angka yang salah membuat
TUI berkedip dan CPU panas — dan yang disalahkan orang adalah Titah. fs-watch di
`.git` dan `node_modules` adalah sumber klasik event storm dan kehabisan file
descriptor; satu `git commit` mengubah isi `.git` puluhan kali.

Konsekuensinya jujur: `git checkout` di terminal lain tidak langsung terlihat.
Ia terlihat pada pemicu berikutnya — dan tiga dari empat pemicu itu adalah hal
yang kamu lakukan setiap kali kamu benar-benar melihat panelnya.

## Kegagalan tidak menjatuhkan TUI

Extension yang gagal dimuat kehilangan panelnya, sesinya tetap jalan, dan user
diberi tahu sekali lewat notice — aturan yang sama dengan `plugin` dan dengan
server MCP yang mati.

`render` yang `throw` membuat panel itu menampilkan pesan error **di tempatnya**.
`render` yang tidak selesai dibatalkan oleh timeout, dan `signal` yang diberikan
ke `render` adalah cara extension ikut berhenti alih-alih terus bekerja untuk
hasil yang tidak akan dipakai.

`"enabled": false` membuat modulnya **tidak di-`import` sama sekali**, bukan
sekadar tidak dipakai — kode di level atas modul berjalan saat import.

## Kontrak API

`engines.titah` diperiksa **saat load**. Versi yang tidak cocok berarti extension
tidak dimuat, dengan notice yang menyebut versi yang dibutuhkan dan versi yang
ada.

Tanpa pemeriksaan itu, extension yang ditulis untuk API lama gagal dengan
`TypeError: x is not a function` di tengah render — pesan yang menunjuk sebab
yang salah, di tempat yang salah.

**Selama 0.x, API extension belum stabil.** Ini bukan penafian yang dipasang
untuk berjaga-jaga; ia keterangan tentang keadaan. Bentuk view dan primitifnya
akan berubah sampai ada cukup panel untuk mengetahui apa yang benar.

## Tempat pemasangan, dan kenapa bukan `node_modules` proyekmu

```
~/.local/share/titah/extension/     kode yang diunduh
~/.config/titah/extension-lock.json versi persis + integrity hash
~/.cache/titah/registry.json        salinan index registry
```

`plugin` hari ini diresolusi dari `node_modules` **proyek** user
(`createRequire(path.join(cwd, "package.json"))`). Artinya memasang satu plugin
berarti menambahkan dependency ke `package.json` proyek — mencampur tooling
dengan dependency aplikasi, dan membuat rekan kerja bertanya kenapa aplikasi
mereka bergantung pada panel git.

Extension tidak melakukan itu. Ia preferensi **orang**, bukan dependency
**proyek**: panelmu ikut pindah saat kamu berganti repo, dan proyek siapa pun
tidak pernah tahu ia ada. Ini memang tidak konsisten dengan `plugin`, dan
ketidakkonsistenan itu dipilih sadar — pola `plugin` yang harus berubah, bukan
pola extension yang harus mengikutinya.

Lockfile duduk di `~/.config/titah/` dan bukan di `dataDir` karena ia berkas yang
memang ingin dibaca manusia dan di-commit ke dotfiles — persis keterangan yang
sudah tertulis di `paths.ts` untuk direktori itu.

Yang dikunci adalah **versi persis dan integrity hash**, bukan versi saja. Versi
saja tidak melindungi dari republish pada versi yang sama, dan hash adalah
satu-satunya yang membuat "kode yang sama di dua mesin" jadi jaminan, bukan
harapan.

Hash-nya **dibaca dari `package-lock.json` milik npm**, tidak dihitung sendiri.
npm sudah memverifikasinya terhadap registry saat mengunduh; menghitung ulang
dari berkas yang sudah diekstrak hanya membuktikan bahwa berkas itu adalah
dirinya sendiri. Dan pengunduhannya sendiri diserahkan ke `npm install`, bukan
ke ekstraksi tarball sendiri — Node tidak punya tar, `tar` tidak ada di Windows
yang `paths.ts` sudah menyatakan akan didukung, dan npm sudah menangani
dependency transitif.

Kalau lockfile menyebut sebuah versi, versi itu yang dipasang — bukan yang
terbaru. Itu seluruh gunanya, dan itu berarti `install` **tidak pernah** menaikkan
versi. Yang menaikkannya adalah `titah extension update`, sebagai perintah
tersendiri: `install` yang diam-diam bergerak membuat "kode yang sama di dua
mesin" jadi harapan lagi, dan `update` adalah tempat user MENYATAKAN bahwa ia
ingin bergerak.

### `update` memilih versi terbaru yang KOMPATIBEL, bukan yang paling baru

Bedanya menentukan. Extension yang menuntut `^0.5.0` akan jadi `latest` di npm
sementara Titah masih 0.4.0 — memasangnya berarti mengganti extension yang
bekerja dengan yang tidak bisa dimuat, dan pesan kegagalannya baru muncul di sesi
BERIKUTNYA, jauh dari perintah yang menyebabkannya.

`engines` ada di dalam packument npm, jadi ini diketahui **sebelum** mengunduh
apa pun. Versi yang lebih baru tapi diblokir tetap **dikatakan**:

```
· @titah/extension-git 0.2.0 is already the newest compatible version
    0.3.0 exists but needs Titah ^0.5.0 — run: titah upgrade
```

Tanpa baris kedua, `update` yang tidak mengubah apa pun terlihat seperti tidak
ada versi baru — padahal ada, dan yang menahannya adalah versi Titah, satu hal
yang user bisa perbaiki.

Prerelease dan versi yang di-deprecate dilewati. Prerelease tidak pernah yang
dimaksud orang saat mengetik `update`.

## Picker

`<leader>x` membuka picker: popup di tengah layar dengan pencarian, dan **Enter**
memasang baris yang tersorot. Itu satu-satunya aksi yang ada di picker hari ini —
memperbarui dan mencabut lewat `titah extension update` dan `titah extension
remove`.

Tiga keadaan dibedakan tampilannya, karena `I` berarti hal berbeda pada
masing-masing:

| Penanda | Keadaan | Enter berarti |
|---|---|---|
| `✓` | terpasang | tidak ada yang perlu dilakukan |
| `↓` | ada di config, belum terunduh | unduh |
| `+` | ada di registry, belum dipilih | **tulis ke config**, lalu unduh |

Perhatikan bahwa `✓` **tidak** berarti "versi terbaru" — hanya "ada di disk".
Picker tidak memanggil registry npm untuk setiap baris; itu satu request per
extension setiap kali picker dibuka, untuk informasi yang jarang berubah.
`titah extension update` yang menjawab pertanyaan itu.

Penandanya visual, bukan hanya di keterangan. Tombol yang artinya berubah
tergantung baris yang tersorot, tanpa tampilan yang membedakan barisnya, adalah
tombol yang orang tekan lalu menyesal — terutama `+`, yang menyunting berkas
config user.

Tombol yang bertabrakan dilaporkan di baris itu juga, beserta aksi yang sudah
memilikinya (`key <leader>d is taken by tool_details`). Di situlah tabrakan
berakhir: satu keputusan yang terlihat sekali, bukan misteri runtime yang
pemenangnya ditentukan urutan key di objek JSON.

Pemasangan menulis ke config user. Penulisan itu memakai `modify()` dari
`jsonc-parser`, bukan `JSON.stringify` — config Titah adalah JSONC, dan komentar
yang hilang saat Titah "membantu" adalah kerusakan yang tidak bisa dibatalkan.

## Registry

Index terkurasi di `titah-dev/titah-extensions`. Menambahkan extension berarti
mengirim PR ke repo itu, bukan ke repo Titah — PR "tambahkan extension saya"
tidak perlu menjalankan CI Titah, menyentuh siklus release-nya, atau memberi
kontributor eksternal permukaan review di repo inti.

Index diambil lewat `raw.githubusercontent.com`, di-cache dengan TTL. **Bukan**
lewat GitHub API: batasnya 60 request per jam per IP tanpa auth, dan di kantor
dengan satu IP publik picker mati sebelum siang, dengan gejala yang tidak
menunjuk sebabnya.

Offline, picker menampilkan salinan cache dan **mengatakan bahwa ia usang**.
Daftar yang mungkin ketinggalan lebih berguna daripada daftar kosong, selama
user tahu yang mana yang sedang ia lihat.

Satu entri registry memetakan ke npm package **dan versi yang pasti** — aturan
yang sama dengan `MarketEntry` untuk `plugin`, dan alasannya sama: registry yang
mengembalikan "paket terbaru" tidak bisa memberi jaminan bahwa `market:git` di
dua mesin berarti kode yang sama.

## Yang belum ada, dan itu disengaja

**Sisi server.** Extension hari ini hanya sisi TUI. Ia bisa menimpa tampilan dan
masukan — dan itu saja, karena agent loop, permission, prompt building, dan
kompaksi konteks semuanya hidup di sisi server. Kalau extension suatu hari perlu
menjangkau ke sana, bentuk config-nya sudah menunggu: `titah.panel` di
`package.json` extension adalah **satu** field di antara beberapa yang mungkin,
bukan satu-satunya bentuk yang ada. Menambahkan `titah.hooks` nanti jadi field
baru, bukan perubahan bentuk yang memutus config orang.

**`attach`, `serve`, `web`.** Karena extension berjalan di proses TUI, ketiga mode
itu tidak punya panel. Ini bukan kelalaian: extension di sisi TUI yang
menjalankan `git` akan menjalankannya di direktori tempat user mengetik, bukan
direktori tempat agent bekerja — dan pada `titah attach <url>` keduanya bisa
mesin berbeda. Panel yang menampilkan branch dari repo yang salah, dengan penuh
keyakinan dan tanpa error, lebih buruk daripada panel yang tidak ada.

**JSX.** Lihat "Kenapa `render` mengembalikan data".

**Auto-update Titah.** Tidak ada, dan tidak akan ada. `titah upgrade` memeriksa
npm lalu MENCETAK perintah pemasangannya; footer menampilkan satu baris kalau ada
versi baru. Yang akan di-update adalah proses yang memegang `auth.json`,
menjalankan bash, dan menyunting berkas — memasangnya sendiri tanpa bertanya
berarti eksekusi kode arbitrer setiap kali ada `npm publish`. Ada juga ironinya:
lockfile di atas ada supaya extension tidak berubah diam-diam di bawahmu, dan
tidak ada lockfile untuk host-nya.

Perintahnya dicetak dan tidak dijalankan karena Titah tidak tahu bagaimana ia
dipasang — npm global, npx, bun, volta — dan menebak salah berarti memasang
salinan kedua di tempat yang tidak dipakai siapa pun.

**Sandbox.** Tidak dijanjikan, sama seperti `plugin`. `worker_threads` per
extension akan mengisolasi crash tapi **tidak** mengisolasi kepercayaan — worker
tetap bisa membaca `auth.json` dan memanggil jaringan. Membayar batas proses
untuk setengah manfaat yang orang asumsikan didapat adalah pertukaran yang lebih
buruk daripada tidak membayarnya dan mengatakan apa adanya.
