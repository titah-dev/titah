# Super agent

Super agent adalah **CLI agent lain** — Claude Code, opencode, hermes,
antigravity, kiro — yang Titah panggil sebagai subprocess dengan kredensial
Anda sendiri. Mereka punya model, tool, dan kebijakan izinnya masing-masing.

Titah tidak membundel satu pun. Sejak daftar ini jadi tempat Anda mendaftarkan
super agent apa pun, menyuntik dua nama secara otomatis berarti dua di antaranya
istimewa tanpa alasan — dan `specialist` yang dibutuhkan `/tim` tidak bisa
ditebak Titah untuk mereka.

## Mendaftarkan

```jsonc
{
  "externalAgent": {
    "claude": {
      "command": "claude",
      "specialist": "deep architectural reasoning, cross-module refactors, hard debugging",
      "args": ["-p", "{prompt}", "--output-format", "stream-json", "--verbose",
               "--session-id", "{session}"],
      "resumeArgs": ["-p", "{prompt}", "--output-format", "stream-json", "--verbose",
                     "--resume", "{session}"],
      "sessionMode": "generate",
      "format": "stream-json"
    },
    "opencode": {
      "command": "opencode",
      "specialist": "broad codebase exploration, plugin and tooling work",
      "args": ["run", "{prompt}", "--format", "json"],
      "resumeArgs": ["run", "{prompt}", "--format", "json", "--session", "{session}"],
      "sessionMode": "discover",
      "format": "json"
    }
  }
}
```

**`titah doctor` mencetak blok ini siap salin** untuk setiap CLI yang benar-benar
terpasang di mesin Anda. Argumen di dalamnya diverifikasi langsung terhadap
binernya, bukan disalin dari dokumentasi:

- Claude Code **menolak** `--output-format stream-json` tanpa `--verbose`
- Claude memakai `--session-id <uuid>` untuk membuat dan `--resume <uuid>` untuk
  melanjutkan — memberi `--session-id` yang sama dua kali bukan cara resume
- opencode tidak menerima id sesi buatan kita; id-nya dibaca dari keluaran
  panggilan pertama (`sessionMode: "discover"`)

## `specialist` — opsional di skema, wajib untuk `/tim`

Ditulis untuk dibaca **model**, bukan manusia: kalimat yang menyebut kekuatan
dan batasnya, bukan label satu kata.

Ia opsional karena `externalAgent` melayani tiga hal, dan hanya satu yang
membutuhkannya:

| Jalur | Butuh `specialist`? |
|---|---|
| `@claude <prompt>` yang Anda ketik | tidak |
| `agent.<id>.delegate` | tidak |
| pembagian tugas `/tim` | **ya** |

Super agent tanpa spesialis **dilewati** `/tim`, dan `/tim` menyebutkan siapa
yang ia lewati. Kegagalannya terlihat, bukan diam-diam.

## Tiga cara memanggilnya

### 1. `@claude <prompt>` — langsung, Anda yang mengetik

Seluruh giliran diserahkan ke CLI itu. Sesi eksternalnya diingat, jadi
percakapan berikutnya melanjutkan yang sama.

### 2. `/tim <tugas>` — fan-out ke beberapa super agent

Titah jadi koordinator, membagi pekerjaan berdasarkan `specialist` masing-masing
lalu menjalankannya bersamaan. **Hanya super agent** — agent internal Titah
tidak ikut, karena mereka sudah terdaftar di setiap giliran dan cukup diminta.

### 3. `escalate` — agent internal meminta bantuan

```jsonc
{
  "agent": {
    "senior-developer": {
      "mode": "all",
      "escalate": {
        "to": "claude",
        "when": "perubahan lintas modul, atau butuh memahami arsitektur dulu"
      }
    }
  }
}
```

`senior-developer` tetap berjalan di loop Titah — dengan tool dan izin Titah —
dan hanya menyerahkan sebagian pekerjaan saat kriterianya terpenuhi.

`when` **tidak diurai Titah**. Ia ditempelkan apa adanya ke prompt agent itu,
karena satu-satunya yang bisa menilai "butuh pemahaman arsitektur" adalah yang
sedang mengerjakannya. Setiap usaha menerjemahkannya jadi aturan akan salah
persis pada kasus yang paling ingin Anda tangkap.

### `escalate` vs `delegate`

| | `delegate` | `escalate` |
|---|---|---|
| Yang menjalankan giliran | CLI eksternal, selalu | loop Titah |
| Tool & izin Titah | tidak berlaku | berlaku |
| Kapan CLI dipakai | setiap saat | saat `when` terpenuhi, model yang menilai |

Keduanya **tidak boleh** disetel bersamaan — `delegate` sudah menyerahkan setiap
giliran, jadi tidak ada sisa untuk dieskalasi. Config yang menyetel keduanya
ditolak saat dimuat.

## Batas yang berlaku, dan yang tidak

**Izin Titah tidak pernah sampai ke super agent.** CLI itu punya kebijakannya
sendiri dan menyunting berkas atas keputusannya sendiri. Konsekuensinya:

- Agent yang **tidak boleh menulis** (`edit` dan `write` = `deny`, seperti
  `plan`) **tidak boleh** mendispatch super agent sama sekali. Ditolak, bukan
  dibatasi setengah-setengah — berpura-pura membatasi sesuatu yang tidak bisa
  dibatasi lebih buruk daripada menolak.
- Super agent selalu dihitung sebagai **penulis**, jadi ia antre di kunci tulis
  bersama penulis lain di direktori yang sama.

**Sub-agent hanya boleh mengeskalasi ke satu tujuan.** Giliran utama boleh
memanggil super agent mana pun yang terdaftar; sub-agent hanya ke
`escalate.to`-nya sendiri. Batas kedalaman tetap utuh: super agent adalah CLI di
luar Titah dan tidak punya `task` untuk memanggil balik, jadi rantainya berhenti
di sana secara struktural.

---

# Delegasi ke agent internal

Terpisah dari super agent di atas: ini tentang agent Titah sendiri yang
didaftarkan di `agent`, dipanggil lewat tool `task`.

## Kenapa dulu hampir tidak pernah terjadi

Diukur pada `9router/ant` dengan tugas yang jelas cocok — satu delegasi dari
lima percobaan. Empat sebab, dan tiga di antaranya ada di prompt:

1. **Inventaris tool tidak memuat `task`.** `BASE_PROMPT` memberi daftar tegas
   berjudul "Available tools:" yang tidak menyebut delegasi sama sekali. Model
   membaca inventaris resmi yang mengatakan itu bukan kemampuannya, lalu jauh di
   bawah menemukan roster yang menyebutnya.
2. **Prompt `build` berbunyi "Carry out the user's request DIRECTLY."** Satu
   kata yang meniadakan seluruh blok roster beberapa baris di bawahnya.
3. **Ajakan roster bersyarat**: *"when it matches their description better than
   doing it yourself"*. Untuk tugas kecil itu memang salah — membaca tiga berkas
   sendiri lebih murah. Modelnya menalar benar; kalimatnya yang tidak memicu.
4. **Tidak ada sakelar.** Semuanya bergantung pada bujukan, dan dua model
   berbeda memutuskan berbeda untuk prompt yang sama.

Ketiga yang pertama sudah diperbaiki. Yang keempat jadi `delegation`.

## `delegation`

```jsonc
{ "delegation": "ask" }
```

| Nilai | Perilaku |
|---|---|
| `"ask"` | **bawaan** — sesudah rencana ditulis, Titah menilai apakah pekerjaannya layak dipecah; kalau ya, model menanyakannya |
| `"auto"` | model memutuskan sendiri, tanpa bertanya |
| `"always"` | pekerjaan yang cocok selalu diserahkan |
| `"never"` | tidak pernah — roster tidak dikirim sama sekali, jadi tidak ada token terbuang |

Diukur sesudah perbaikan, tugas dan model yang sama: `ask` 1 dari 3, `always`
2 dari 2.

## Bagaimana `ask` bekerja

Pembagian tugasnya disengaja: **Titah menilai apakah pertanyaannya layak
diajukan, model menilai apakah pemisahannya benar-benar menolong.**

Titah memasang catatan pada hasil `plan` — bukan di system prompt — ketika
semua ini benar:

- `delegation` adalah `"ask"`
- ada sub-agent yang bisa dibawahi
- rencananya punya **≥ 3 butir** (dihitung dari baris bernomor atau berpoin,
  bukan dari jumlah baris)
- sesi ini belum pernah ditanyai

Catatan itu tiba tepat ketika rencana baru selesai ditulis dan model sedang
memutuskan langkah berikutnya — satu-satunya saat pertanyaannya masih bisa
mengubah apa pun. Di system prompt ia hanya akan jadi satu paragraf lagi yang
dibaca setiap giliran lalu tenggelam.

Model lalu memutuskan sendiri:

**Langkah saling bergantung → tidak bertanya, langsung kerjakan.** Terlihat pada
percobaan nyata:

> *"Langkah 1 & 2 saling bergantung (hasil telusuri → diagnostics → ringkasan),
> jadi saya kerjakan sendiri. Mulai."*

**Langkah saling bebas → bertanya, dengan dua pilihan:**

```
[1] Delegate: hand matching steps to the sub-agents
[2] Inline: do all of it yourself
```

Pertanyaannya wajib menyebut langkah mana yang akan diserahkan dan kepada siapa,
supaya pilihan dibuat dengan pemisahannya di depan mata.

Sekali per sesi. Rencana diperbarui berkali-kali dalam satu giliran panjang —
itu memang gunanya — dan pertanyaan yang ikut muncul di setiap pembaruan
berhenti dibaca justru ketika ia mulai berarti.
