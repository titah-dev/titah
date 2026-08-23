/**
 * Keybinding default opencode (Q16), ditarik dari `https://opencode.ai/tui.json`
 * dan halaman dokumentasinya.
 *
 * opencode mendefinisikan 184 aksi; yang ada di sini adalah subset yang benar-
 * benar diimplementasikan Titah di M3, dengan tombol yang PERSIS sama sehingga
 * muscle memory langsung terpakai.
 *
 * Satu penyimpangan yang disengaja: `tool_details` dibiarkan `none` oleh
 * opencode. Titah mengikatnya ke `<leader>d`, karena blok tool yang bisa
 * dilipat tanpa tombol untuk melipatnya adalah fitur yang tidak bisa ditemukan.
 */
export const DEFAULT_KEYBINDS = {
  leader: "ctrl+x",

  /*
   * Satu tombol saja, dan itu disengaja.
   *
   * TANPA ctrl+c: tombol itu milik `input_clear`, dan keluar lewatnya menuntut
   * dua tekanan — perilaku yang tidak bisa diungkapkan sebagai binding, jadi
   * mencantumkannya di sini hanya membuat config berbohong tentang apa yang
   * terjadi.
   *
   * TANPA <leader>q: empat cara keluar (ctrl+c dua kali, ctrl+d, <leader>q,
   * /exit) berarti tiga di antaranya harus diingat tanpa pernah dipakai, dan
   * setiap satunya adalah tombol yang bisa tertekan tanpa sengaja. Yang
   * tersisa: ctrl+d untuk jari, /exit untuk yang mengetik, ctrl+c dua kali
   * untuk yang refleks.
   */
  app_exit: "ctrl+d",
  app_help: "<leader>?",

  session_new: "<leader>n",
  session_list: "<leader>l",
  session_interrupt: "escape",
  session_undo: "<leader>u",

  agent_cycle: "tab",
  agent_cycle_reverse: "shift+tab",

  /*
   * Panjang kesimpulan: default → low → medium → high → default.
   *
   * `ctrl+r` karena ia satu tekanan, tidak bertabrakan dengan apa pun di
   * editor (a/b/e/f/j/u sudah terpakai untuk gerak kursor), dan huruf `r`
   * masih bisa dihubungkan ke "reason" oleh orang yang menyetelnya di config.
   *
   * Tab BUKAN pilihan meski ia tetangga paling logis: `tab` dan `shift+tab`
   * sudah memutar agent, dan dua putaran di tombol yang sama berarti user harus
   * ingat mana yang sedang ia putar sebelum menekan.
   *
   * `<leader>r` ikut supaya aksinya muncul di menu leader dan command palette —
   * tombol yang tidak bisa ditemukan sama saja dengan tidak ada.
   */
  effort_cycle: "ctrl+r,<leader>r",

  command_list: "ctrl+p",

  // Panah POLOS menelusuri histori prompt, seperti opencode dan shell mana pun.
  // Menggulir riwayat pindah ke panah bermodifier — dan tetap ada di pageup/
  // pagedown, satu-satunya tombol gulir yang pasti terbaca di semua terminal.
  messages_line_up: "shift+up,ctrl+up",
  messages_line_down: "shift+down,ctrl+down",

  messages_page_up: "pageup,ctrl+alt+b",
  messages_page_down: "pagedown,ctrl+alt+f",
  messages_half_page_up: "ctrl+alt+u",
  messages_half_page_down: "ctrl+alt+d",
  messages_first: "ctrl+g,home",
  // Melompat ke bawah punya tiga jalan masuk: End untuk yang datang dari editor
  // lain, ctrl+alt+g untuk yang hafal opencode, dan <leader>b untuk yang mencari
  // lewat menu leader. Tombol yang tidak bisa ditemukan sama saja dengan tidak ada.
  messages_last: "ctrl+alt+g,end,<leader>b",

  tool_details: "<leader>d",

  /*
   * Panel sub-agent. `<leader>` lalu panah bawah, sama seperti opencode —
   * muscle memory yang sudah ada lebih berharga daripada tombol yang lebih rapi.
   */
  subagents_panel: "<leader>down",

  /*
   * Panel samping, mengikuti arah panahnya: kiri untuk yang kiri, kanan untuk
   * yang kanan. Sepasang dengan `<leader>down` di atas, jadi ketiga panel
   * Titah dijangkau lewat satu pola yang sama — leader lalu arah.
   *
   * Panel yang disumbang extension TIDAK ikut di sini. Ia mengusulkan tombolnya
   * sendiri dan tabrakannya diselesaikan saat install; menaruhnya di daftar ini
   * berarti daftar bawaan berubah tergantung apa yang terpasang.
   */
  panel_left: "<leader>left",
  panel_right: "<leader>right",

  /*
   * Pemicu refresh keempat (Q26). Tiga yang lain gratis — prompt dikirim,
   * giliran selesai, panel dibuka — dan ketiganya tidak menolong saat kamu
   * `git checkout` di terminal lain lalu hanya ingin melihat hasilnya.
   */
  panel_refresh: "<leader>e",

  /*
   * Picker extension. `x` karena huruf itu satu-satunya yang tersisa dan masih
   * bisa dihubungkan ke "extension" oleh orang yang membaca menunya.
   */
  extension_picker: "<leader>x",

  /*
   * Mematikan pelacakan mouse supaya seleksi teks bawaan terminal hidup lagi.
   *
   * Keduanya TIDAK BISA menyala bersamaan: begitu terminal melaporkan klik ke
   * aplikasi, ia berhenti memakai klik itu untuk menyorot teks. Jadi menyalin
   * teks menuntut pelacakan dimatikan, bukan sekadar diatur berbeda.
   */
  mouse_toggle: "<leader>m",

  input_submit: "return",
  input_newline: "ctrl+j",
  input_clear: "ctrl+c",
  input_backspace: "backspace",
  input_delete_to_line_start: "ctrl+u",
  input_move_left: "left,ctrl+b",
  input_move_right: "right,ctrl+f",
  input_line_home: "ctrl+a",
  input_line_end: "ctrl+e",

  // Pada draft multi-baris, kedua tombol ini memindahkan kursor antar baris
  // lebih dulu; histori baru terpanggil di baris paling atas/bawah.
  // Tanpa alias ctrl+p/ctrl+n: ctrl+p sudah milik command palette, dan pasangan
  // yang timpang lebih membingungkan daripada tidak ada alias sama sekali.
  input_history_prev: "up",
  input_history_next: "down",

  permission_allow_once: "y",
  permission_allow_always: "a",
  permission_reject: "n",
} as const

export type Action = keyof typeof DEFAULT_KEYBINDS

/**
 * Aksi yang bisa dicapai lewat tombol leader, beserta keterangannya.
 *
 * Satu daftar, dua pemakai: menu yang muncul setelah leader ditekan, dan
 * command palette. Dua daftar untuk satu himpunan berarti yang kedua akan
 * ketinggalan begitu aksi ditambah — dan menu yang menjanjikan tombol yang
 * tidak ada lebih buruk daripada tidak ada menu.
 *
 * URUTANNYA disengaja: yang paling sering dipakai lebih dulu, bukan alfabetis.
 * Menu ini dibaca sambil menahan satu tombol, dan mata berhenti di baris
 * pertama yang masuk akal.
 */
export const LEADER_ACTIONS: { action: Action; describe: string }[] = [
  { action: "tool_details", describe: "Expand or collapse all tool output" },
  { action: "effort_cycle", describe: "Reasoning effort: default → low → medium → high" },
  { action: "subagents_panel", describe: "Sub-agent panel" },
  { action: "panel_left", describe: "Left panel" },
  { action: "panel_right", describe: "Right panel" },
  { action: "panel_refresh", describe: "Refresh side panels" },
  { action: "extension_picker", describe: "Extensions — search and install" },
  { action: "session_list", describe: "Switch to another session" },
  { action: "session_new", describe: "Start a new session" },
  { action: "session_undo", describe: "Undo the last turn's changes" },
  { action: "messages_last", describe: "Jump to the newest message" },
  { action: "mouse_toggle", describe: "Release the mouse so the terminal can select text" },
  { action: "app_help", describe: "Quick help" },
]

/**
 * Tombol yang harus ditekan SETELAH leader untuk sebuah aksi, mis. `"d"`.
 *
 * `undefined` kalau aksi itu tidak punya chord ber-leader sama sekali — yang
 * berarti ia tidak boleh muncul di menu leader, betapapun bergunanya.
 *
 * `action` bertipe `string` dan bukan `Action` karena extension menyumbang aksi
 * yang namanya tidak diketahui saat kompilasi. Jaminan bahwa aksi BAWAAN benar-
 * benar ada tidak hilang: ia dijaga oleh tipe `LEADER_ACTIONS`, bukan oleh
 * tanda tangan di sini.
 */
export function leaderKeyFor(keymap: Keymap, action: string): string | undefined {
  const chord = (keymap[action] ?? []).find((entry) => entry.leader)
  if (!chord) return undefined
  const mods = [chord.ctrl ? "ctrl" : "", chord.alt ? "alt" : ""].filter(Boolean)
  return [...mods, chord.key].join("+")
}

/**
 * Nama tombol leader itu sendiri, mis. `"ctrl+x"`.
 *
 * Dibaca dari keymap, bukan ditulis tetap: user boleh menggantinya lewat
 * `keybinds.leader`, dan menu yang menyebut "ctrl+x" pada mesin yang memakai
 * "ctrl+b" mengajari tombol yang salah.
 */
export function leaderName(keymap: Keymap): string {
  const chord = (keymap["leader"] ?? [])[0]
  if (!chord) return "ctrl+x"
  const mods = [chord.ctrl ? "ctrl" : "", chord.alt ? "alt" : ""].filter(Boolean)
  return [...mods, chord.key].join("+")
}

export interface Chord {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Chord ini hanya cocok setelah tombol leader ditekan. */
  leader: boolean
}

const MODIFIERS = new Set(["ctrl", "alt", "meta", "shift", "super", "cmd"])

/** `"ctrl+alt+u"` → satu Chord. `"<leader>q"` → Chord dengan leader = true. */
export function parseChord(spec: string): Chord | undefined {
  let rest = spec.trim().toLowerCase()
  if (rest === "" || rest === "none") return undefined

  let leader = false
  if (rest.startsWith("<leader>")) {
    leader = true
    rest = rest.slice("<leader>".length)
  }

  const parts = rest.split("+").filter(Boolean)
  const chord: Chord = { key: "", ctrl: false, alt: false, shift: false, leader }

  for (const part of parts) {
    if (!MODIFIERS.has(part)) {
      chord.key = part
      continue
    }
    if (part === "ctrl") chord.ctrl = true
    else if (part === "alt" || part === "meta") chord.alt = true
    else if (part === "shift") chord.shift = true
    // super/cmd tidak bisa dideteksi di terminal — diabaikan, bukan error.
  }

  return chord.key === "" ? undefined : chord
}

/** Satu aksi bisa punya beberapa alternatif, dipisah koma. */
export function parseBinding(spec: string): Chord[] {
  return spec
    .split(",")
    .map((part) => parseChord(part))
    .filter((chord): chord is Chord => chord !== undefined)
}

export type Keymap = Record<string, Chord[]>

export function buildKeymap(overrides: Record<string, string> = {}): Keymap {
  const map: Keymap = {}
  for (const [action, spec] of Object.entries({ ...DEFAULT_KEYBINDS, ...overrides })) {
    map[action] = parseBinding(spec)
  }
  return map
}

/** Bentuk netral dari event tombol, supaya logika ini bisa diuji tanpa Ink. */
export interface KeyPress {
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

export function chordMatches(chord: Chord, press: KeyPress, leaderActive: boolean): boolean {
  if (chord.leader !== leaderActive) return false
  if (chord.key !== press.key.toLowerCase()) return false
  if (chord.ctrl !== (press.ctrl === true)) return false
  if (chord.alt !== (press.alt === true)) return false
  // Shift diabaikan untuk tombol yang bisa diketik: terminal mengirim huruf
  // besar, bukan shift+huruf, jadi mencocokkan shift akan selalu meleset.
  if (chord.key.length > 1 && chord.shift !== (press.shift === true)) return false
  return true
}

export function matches(keymap: Keymap, action: string, press: KeyPress, leaderActive: boolean): boolean {
  return (keymap[action] ?? []).some((chord) => chordMatches(chord, press, leaderActive))
}

/**
 * Bentuk kanonik satu chord, untuk dibandingkan.
 *
 * `"<leader>d"` dan `"<leader>D"` adalah tombol yang SAMA — terminal mengirim
 * huruf besar sebagai huruf besar, dan `chordMatches` sudah menurunkannya. Dua
 * chord yang cocok dengan tekanan yang sama harus punya id yang sama, atau
 * pemeriksa tabrakan akan meloloskan tombol yang sungguh bertabrakan.
 */
export function chordId(chord: Chord): string {
  return [chord.leader ? "leader" : "", chord.ctrl ? "ctrl" : "", chord.alt ? "alt" : "", chord.key]
    .filter(Boolean)
    .join("+")
}

/**
 * Aksi yang sudah memakai salah satu chord dalam `spec`, kalau ada.
 *
 * Dipakai saat memasang extension: tombol yang diusulkan pembuat extension
 * diperiksa di sini, dan tabrakannya diselesaikan SEKALI di picker. Tanpa ini
 * pemenangnya ditentukan urutan key di objek config — perilaku yang tidak bisa
 * dijelaskan ke siapa pun.
 *
 * Yang diperiksa adalah setiap alternatif, bukan hanya yang pertama: sebuah
 * aksi boleh punya beberapa tombol (`"ctrl+r,<leader>r"`), dan bertabrakan
 * dengan alternatif kedua sama merugikannya.
 */
export function chordOwner(keymap: Keymap, spec: string): string | undefined {
  const wanted = new Set(parseBinding(spec).map(chordId))
  if (wanted.size === 0) return undefined
  for (const [action, chords] of Object.entries(keymap)) {
    // `leader` bukan aksi: ia prefiks untuk aksi lain, dan mencocokkannya di
    // sini membuat setiap chord ber-leader terlihat bertabrakan dengannya.
    if (action === "leader") continue
    if (chords.some((chord) => wanted.has(chordId(chord)))) return action
  }
  return undefined
}

/**
 * Satu baris menu leader. Aksinya `string` dan bukan `Action` karena extension
 * ikut menyumbang baris, dan namanya tidak diketahui saat kompilasi.
 */
export interface LeaderEntry {
  action: string
  describe: string
}

/**
 * Menu leader lengkap: bawaan lalu sumbangan extension.
 *
 * Urutannya disengaja dan bukan alfabetis — aksi bawaan yang sering dipakai
 * tetap di atas, dan panel yang dipasang orang tidak menggeser tombol yang
 * sudah dihafal jarinya.
 */
export function leaderMenu(extra: LeaderEntry[] = []): LeaderEntry[] {
  return [...LEADER_ACTIONS, ...extra]
}

/** Aksi pertama yang cocok, supaya penanganan tombol tidak jadi rantai if panjang. */
export function resolve(
  keymap: Keymap,
  press: KeyPress,
  leaderActive: boolean,
  candidates: string[],
): string | undefined {
  return candidates.find((action) => matches(keymap, action, press, leaderActive))
}

/**
 * Nama tombol pertama sebuah aksi, untuk ditampilkan sebagai petunjuk.
 *
 * Chord ber-leader dilewati kalau ada alternatif tunggal: "end" jauh lebih
 * berguna dicetak di layar daripada "ctrl+x b".
 */
export function describeKey(keymap: Keymap, action: string, fallback = ""): string {
  const chords = keymap[action] ?? []
  const plain = chords.find((chord) => !chord.leader && !chord.ctrl && !chord.alt)
  const chosen = plain ?? chords[0]
  if (!chosen) return fallback

  const parts: string[] = []
  if (chosen.leader) parts.push("ctrl+x")
  const mods = [chosen.ctrl ? "ctrl" : "", chosen.alt ? "alt" : ""].filter(Boolean)
  parts.push([...mods, chosen.key].join("+"))
  return parts.join(" ")
}
