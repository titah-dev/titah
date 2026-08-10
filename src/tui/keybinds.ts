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

  app_exit: "ctrl+c,ctrl+d,<leader>q",
  app_help: "<leader>?",

  session_new: "<leader>n",
  session_list: "<leader>l",
  session_interrupt: "escape",
  session_undo: "<leader>u",

  agent_cycle: "tab",
  agent_cycle_reverse: "shift+tab",

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
