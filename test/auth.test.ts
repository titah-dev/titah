import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { authFile } from "../src/core/paths.ts"
import { checkPermissions, readAuth, removeCredential, setCredential } from "../src/core/auth.ts"
import { which } from "../src/core/which.ts"

function withDataHome<T>(fn: () => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-auth-"))
  const prev = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test("auth.json ditulis dengan mode 0600", { skip: process.platform === "win32" }, () => {
  withDataHome(() => {
    setCredential("p", "sk-rahasia")
    const mode = fs.statSync(authFile()).mode & 0o777
    assert.equal(mode.toString(8), "600")
  })
})

test("tidak ada file sementara yang tertinggal setelah menulis", () => {
  withDataHome(() => {
    setCredential("p", "sk-rahasia")
    const leftovers = fs.readdirSync(path.dirname(authFile())).filter((f) => f.includes(".tmp"))
    assert.deepEqual(leftovers, [])
  })
})

test("set lalu baca mengembalikan kunci yang sama; provider lain tidak terganggu", () => {
  withDataHome(() => {
    setCredential("a", "kunci-a")
    setCredential("b", "kunci-b")
    const store = readAuth()
    assert.equal(store["a"]?.key, "kunci-a")
    assert.equal(store["b"]?.key, "kunci-b")
  })
})

test("remove mengembalikan false untuk provider yang tidak ada", () => {
  withDataHome(() => {
    setCredential("a", "kunci-a")
    assert.equal(removeCredential("a"), true)
    assert.equal(removeCredential("a"), false)
    assert.equal(readAuth()["a"], undefined)
  })
})

test("checkPermissions melaporkan file yang terlalu longgar", { skip: process.platform === "win32" }, () => {
  withDataHome(() => {
    setCredential("p", "sk-rahasia")
    assert.equal(checkPermissions(), undefined, "0600 bersih")

    fs.chmodSync(authFile(), 0o644)
    const report = checkPermissions()
    assert.equal(report?.mode, "644")
  })
})

test("readAuth mengembalikan objek kosong kalau file belum ada", () => {
  withDataHome(() => {
    assert.deepEqual(readAuth(), {})
    assert.equal(checkPermissions(), undefined)
  })
})

test("which menemukan executable nyata dan tidak mengarang", () => {
  assert.ok(which("node"), "node harus ditemukan di PATH")
  assert.equal(which("titah-executable-yang-pasti-tidak-ada"), undefined)
})
