import assert from "node:assert/strict"
import test from "node:test"
import {
  buildKeymap,
  chordMatches,
  DEFAULT_KEYBINDS,
  matches,
  parseBinding,
  parseChord,
  resolve,
  LEADER_ACTIONS,
  leaderKeyFor,
  leaderName,
} from "../src/tui/keybinds.ts"

test("parseChord memahami modifier bertumpuk", () => {
  assert.deepEqual(parseChord("ctrl+alt+u"), {
    key: "u",
    ctrl: true,
    alt: true,
    shift: false,
    leader: false,
  })
  assert.deepEqual(parseChord("escape"), {
    key: "escape",
    ctrl: false,
    alt: false,
    shift: false,
    leader: false,
  })
})

test("parseChord menandai chord yang butuh leader", () => {
  const chord = parseChord("<leader>q")
  assert.equal(chord?.leader, true)
  assert.equal(chord?.key, "q")
})

test('parseChord memperlakukan "none" sebagai aksi yang dimatikan', () => {
  assert.equal(parseChord("none"), undefined)
  assert.equal(parseChord(""), undefined)
  assert.deepEqual(parseBinding("none"), [])
})

test("satu aksi bisa punya beberapa alternatif dipisah koma", () => {
  const chords = parseBinding("ctrl+c,ctrl+d,<leader>q")
  assert.equal(chords.length, 3)
  assert.equal(chords[2]?.leader, true)
})

test("modifier yang tidak ada di terminal (super/cmd) diabaikan, bukan bikin gagal", () => {
  const chord = parseChord("super+a")
  assert.equal(chord?.key, "a")
  assert.equal(chord?.ctrl, false)
})

test("chord tanpa leader tidak cocok saat leader aktif, dan sebaliknya", () => {
  const biasa = parseChord("q")
  const berleader = parseChord("<leader>q")
  const press = { key: "q" }

  assert.equal(chordMatches(biasa as never, press, false), true)
  assert.equal(chordMatches(biasa as never, press, true), false)
  assert.equal(chordMatches(berleader as never, press, true), true)
  assert.equal(chordMatches(berleader as never, press, false), false)
})

test("modifier harus cocok persis — ctrl+c bukan c biasa", () => {
  const keymap = buildKeymap()
  assert.equal(matches(keymap, "input_clear", { key: "c", ctrl: true }, false), true)
  assert.equal(matches(keymap, "input_clear", { key: "c" }, false), false)
})

test("default mengikuti opencode pada tombol yang paling terasa", () => {
  assert.equal(DEFAULT_KEYBINDS.leader, "ctrl+x")
  assert.equal(DEFAULT_KEYBINDS.session_interrupt, "escape")
  assert.equal(DEFAULT_KEYBINDS.session_new, "<leader>n")
  assert.equal(DEFAULT_KEYBINDS.messages_half_page_up, "ctrl+alt+u")
  assert.equal(DEFAULT_KEYBINDS.input_submit, "return")
})

test("escape memicu session_interrupt, bukan aksi lain", () => {
  const keymap = buildKeymap()
  const action = resolve(keymap, { key: "escape" }, false, [
    "session_interrupt",
    "input_submit",
    "app_exit",
  ])
  assert.equal(action, "session_interrupt")
})

test("override config menggantikan default, termasuk mematikannya", () => {
  const keymap = buildKeymap({ session_interrupt: "ctrl+g", tool_details: "none" })

  assert.equal(matches(keymap, "session_interrupt", { key: "g", ctrl: true }, false), true)
  assert.equal(matches(keymap, "session_interrupt", { key: "escape" }, false), false)
  assert.deepEqual(keymap["tool_details"], [], "'none' harus benar-benar mematikan aksi")
})

test("resolve mengembalikan kandidat pertama yang cocok", () => {
  const keymap = buildKeymap({ app_exit: "ctrl+c,ctrl+d" })
  // Satu tombol terikat ke dua aksi; urutan kandidat yang menentukan.
  assert.equal(
    resolve(keymap, { key: "c", ctrl: true }, false, ["input_clear", "app_exit"]),
    "input_clear",
  )
  assert.equal(
    resolve(keymap, { key: "c", ctrl: true }, false, ["app_exit", "input_clear"]),
    "app_exit",
  )
})

test("tombol yang tidak terikat apa pun mengembalikan undefined", () => {
  const keymap = buildKeymap()
  assert.equal(resolve(keymap, { key: "z", alt: true }, false, Object.keys(keymap)), undefined)
})

// ---------- menu leader ----------

test("setiap aksi di menu leader benar-benar punya tombolnya", () => {
  /*
   * Menu yang menjanjikan tombol yang tidak ada lebih buruk daripada tidak ada
   * menu: user menekannya, tidak terjadi apa-apa, dan ia berhenti mempercayai
   * seluruh daftarnya.
   */
  const keymap = buildKeymap()
  for (const entry of LEADER_ACTIONS) {
    assert.ok(
      leaderKeyFor(keymap, entry.action),
      `${entry.action} ada di menu tapi tidak punya chord ber-leader`,
    )
    assert.ok(entry.describe.length > 0, `${entry.action} tanpa keterangan`)
  }
})

test("tombol di menu adalah tombol yang SUNGGUH cocok saat ditekan", () => {
  // Label dan pencocokan dihitung dari sumber yang berbeda; kalau keduanya
  // menyimpang, menu memberi petunjuk yang salah tanpa satu pun test merah.
  const keymap = buildKeymap()
  for (const entry of LEADER_ACTIONS) {
    const key = leaderKeyFor(keymap, entry.action) as string
    const press = key.includes("+")
      ? { key: key.split("+").at(-1) as string, ctrl: key.startsWith("ctrl") }
      : { key }
    assert.equal(
      resolve(keymap, press, true, [entry.action]),
      entry.action,
      `menu bilang "${key}" untuk ${entry.action}, tapi tombol itu tidak cocok`,
    )
  }
})

test("nama leader dibaca dari keymap, bukan ditulis tetap", () => {
  // User boleh menggantinya lewat `keybinds.leader`, dan menu yang menyebut
  // "ctrl+x" pada mesin yang memakai "ctrl+b" mengajari tombol yang salah.
  assert.equal(leaderName(buildKeymap()), "ctrl+x")
  assert.equal(leaderName(buildKeymap({ leader: "ctrl+b" })), "ctrl+b")
})

test("aksi yang dilepas dari leader hilang dari menu, bukan jadi tombol hantu", () => {
  const keymap = buildKeymap({ tool_details: "none" })
  assert.equal(leaderKeyFor(keymap, "tool_details"), undefined)
})

test("aksi yang dipindah ke tombol polos juga hilang dari menu leader", () => {
  // Ia masih bisa dipakai — hanya tidak lewat leader, jadi tidak boleh muncul
  // di daftar yang seluruhnya tentang "apa setelah leader".
  const keymap = buildKeymap({ tool_details: "ctrl+t" })
  assert.equal(leaderKeyFor(keymap, "tool_details"), undefined)
})

test("ctrl+c BUKAN lagi app_exit — keluar lewatnya butuh dua tekanan", () => {
  /*
   * Perilaku dua-tekanan tidak bisa diungkapkan sebagai binding, jadi
   * mencantumkan ctrl+c di `app_exit` hanya membuat config berbohong tentang
   * apa yang terjadi. Tombolnya milik `input_clear`; yang memutuskan kapan
   * keluar adalah penangannya.
   */
  const keymap = buildKeymap()
  assert.equal(resolve(keymap, { key: "c", ctrl: true }, false, ["app_exit"]), undefined)
  assert.equal(resolve(keymap, { key: "c", ctrl: true }, false, ["input_clear"]), "input_clear")

  // ctrl+d tetap keluar dalam satu tekanan.
  assert.equal(resolve(keymap, { key: "d", ctrl: true }, false, ["app_exit"]), "app_exit")
})

test("keluar punya SATU tombol, bukan empat jalan", () => {
  /*
   * Empat cara keluar — ctrl+c dua kali, ctrl+d, <leader>q, /exit — berarti
   * tiga di antaranya harus diingat tanpa pernah dipakai, dan setiap satunya
   * adalah tombol yang bisa tertekan tanpa sengaja.
   *
   * `<leader>q` yang paling mudah dilepas: ia satu-satunya yang menuntut dua
   * tombol DAN tidak melindungi apa pun, karena leader-nya sendiri sudah
   * dipakai untuk delapan aksi lain.
   */
  const keymap = buildKeymap()
  assert.equal(resolve(keymap, { key: "q" }, true, ["app_exit"]), undefined)
  assert.equal(
    LEADER_ACTIONS.some((entry) => entry.action === "app_exit"),
    false,
    "menu leader tidak boleh menawarkan tombol yang sudah dilepas",
  )
})
