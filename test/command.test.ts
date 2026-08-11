import assert from "node:assert/strict"
import test from "node:test"
import { IMMEDIATE_COMMANDS } from "../src/core/command.ts"

test("/compact TIDAK langsung jalan dari palet — ia menerima argumen", () => {
  // `/compact {pesan}` sudah bekerja sejak lama (compactPrompt menerima focus),
  // tapi menjalankannya seketika dari palet tidak pernah memberi user
  // kesempatan mengetik fokusnya. Aturannya sudah tertulis di komentar di atas
  // IMMEDIATE_COMMANDS; `compact` satu-satunya yang melanggarnya.
  assert.equal(IMMEDIATE_COMMANDS.has("compact"), false)
})

test("command tanpa argumen tetap langsung jalan", () => {
  assert.equal(IMMEDIATE_COMMANDS.has("agents"), true)
  assert.equal(IMMEDIATE_COMMANDS.has("new"), true)
})
