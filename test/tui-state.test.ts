import assert from "node:assert/strict"
import test from "node:test"
import { initialState, reduce, totalUsage } from "../src/tui/state.ts"
import type { Message, Session } from "../src/core/message.ts"
import type { PermissionRequest } from "../src/core/permission.ts"

const session: Session = {
  id: "ses_1",
  title: "judul",
  directory: "/proyek",
  created: 1,
  updated: 2,
}

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  sessionID: session.id,
  role: "assistant",
  created: 1,
  parts: [],
  ...overrides,
})

const permission = (id: string): PermissionRequest => ({
  id,
  sessionID: session.id,
  kind: "write",
  title: `write ${id}.txt`,
  detail: "isi",
  pattern: "write",
  created: 1,
})

test("delta teks berturut-turut menumpuk dalam satu part", () => {
  let state = reduce(initialState, {
    type: "message.updated",
    sessionID: session.id,
    message: message("m1"),
  })
  for (const text of ["Ha", "lo ", "dunia"]) {
    state = reduce(state, { type: "text.delta", sessionID: session.id, messageID: "m1", text })
  }

  assert.equal(state.messages.length, 1)
  assert.deepEqual(state.messages[0]?.parts, [{ type: "text", text: "Halo dunia" }])
})

test("delta untuk pesan yang tidak dikenal diabaikan, bukan bikin pesan hantu", () => {
  const state = reduce(initialState, {
    type: "text.delta",
    sessionID: session.id,
    messageID: "tidak-ada",
    text: "x",
  })
  assert.deepEqual(state.messages, [])
})

test("snapshot memperbarui pesan yang sama, tidak menduplikasinya", () => {
  let state = reduce(initialState, {
    type: "message.updated",
    sessionID: session.id,
    message: message("m1", { parts: [{ type: "text", text: "awal" }] }),
  })
  state = reduce(state, {
    type: "message.updated",
    sessionID: session.id,
    message: message("m1", { parts: [{ type: "text", text: "akhir" }], usage: { input: 5, output: 3 } }),
  })

  assert.equal(state.messages.length, 1)
  assert.deepEqual(state.messages[0]?.parts, [{ type: "text", text: "akhir" }])
})

test("pesan user memindahkan status ke bekerja, session.idle mengembalikannya", () => {
  let state = reduce(initialState, {
    type: "message.updated",
    sessionID: session.id,
    message: message("u1", { role: "user" }),
  })
  assert.equal(state.status, "working")

  state = reduce(state, { type: "session.idle", sessionID: session.id })
  assert.equal(state.status, "idle")
})

test("permintaan izin kedua masuk antrean, bukan menimpa yang pertama", () => {
  let state = reduce(initialState, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p1"),
  })
  state = reduce(state, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p2"),
  })

  assert.equal(state.permission?.id, "p1")
  assert.deepEqual(state.permissionQueue.map((r) => r.id), ["p2"])
})

test("izin yang terjawab digantikan oleh antrean berikutnya", () => {
  let state = reduce(initialState, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p1"),
  })
  state = reduce(state, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p2"),
  })
  state = reduce(state, {
    type: "permission.resolved",
    sessionID: session.id,
    permissionID: "p1",
    granted: true,
  })

  assert.equal(state.permission?.id, "p2")
  assert.deepEqual(state.permissionQueue, [])
})

test("izin terakhir yang terjawab membersihkan dialog", () => {
  let state = reduce(initialState, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p1"),
  })
  state = reduce(state, {
    type: "permission.resolved",
    sessionID: session.id,
    permissionID: "p1",
    granted: false,
  })
  assert.equal(state.permission, undefined)
})

test("session.idle membersihkan dialog izin yang masih menggantung", () => {
  // Kalau tidak, dialog yatim akan mengunci input user setelah giliran selesai.
  let state = reduce(initialState, {
    type: "permission.request",
    sessionID: session.id,
    request: permission("p1"),
  })
  state = reduce(state, { type: "session.idle", sessionID: session.id })

  assert.equal(state.permission, undefined)
  assert.deepEqual(state.permissionQueue, [])
})

test("session.error disimpan untuk ditampilkan", () => {
  const state = reduce(initialState, {
    type: "session.error",
    sessionID: session.id,
    message: "provider mati",
  })
  assert.equal(state.error, "provider mati")
})

test("session.updated menyegarkan judul di header", () => {
  const state = reduce(initialState, { type: "session.updated", sessionID: session.id, session })
  assert.equal(state.session?.title, "judul")
})

test("totalUsage menjumlahkan seluruh giliran, dan tahan terhadap usage kosong", () => {
  const messages = [
    message("a", { usage: { input: 10, output: 2 } }),
    message("b"),
    message("c", { usage: { input: 5 } }),
  ]
  const totals = totalUsage(messages)
  assert.equal(totals.input, 15)
  assert.equal(totals.output, 2)
  assert.equal(totals.external.used, false)
})

test("token agent eksternal TIDAK dijumlahkan ke token Titah", () => {
  // Q24: mencampur keduanya membuat angka biaya Titah bohong — mereka dibayar
  // dari kantong yang berbeda.
  const messages = [
    message("a", { usage: { input: 10, output: 2 } }),
    message("b", { externalUsage: { input: 900, output: 40, cost: 0.12 } }),
    message("c", { externalUsage: { input: 100, output: 5 } }),
  ]
  const totals = totalUsage(messages)

  assert.equal(totals.input, 10, "token eksternal tidak boleh bocor ke hitungan Titah")
  assert.equal(totals.output, 2)
  assert.deepEqual(totals.external, { input: 1000, output: 45, cost: 0.12, used: true })
})
