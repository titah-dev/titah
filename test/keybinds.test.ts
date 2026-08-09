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
  const keymap = buildKeymap()
  // ctrl+c terikat ke input_clear DAN app_exit; urutan kandidat yang menentukan.
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
