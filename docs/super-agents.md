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
