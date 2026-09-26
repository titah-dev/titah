import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after, beforeEach } from "node:test"

/**
 * HOME diisolasi SEBELUM impor apa pun dari src/: modul ini menulis ke
 * configDir(), dan tanpa isolasi test-nya menaruh skill di mesin siapa pun
 * yang menjalankannya.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-learn-")))
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.TITAH_DB = path.join(root, "learn.db")
process.env.HOME = path.join(root, "home")

const { Config } = await import("../src/core/schema.ts")
const { learnedSkillsDir, learnLogFile } = await import("../src/core/paths.ts")

beforeEach(() => {
  fs.rmSync(path.join(root, "config"), { recursive: true, force: true })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

// ---------- config ----------

test("belajar skill MATI secara bawaan, dengan ambang 8 tool dan plafon 30", () => {
  assert.deepEqual(Config.parse({}).skills.learn, { enabled: false, minTools: 8, max: 30 })
})

test("skill yang dipelajari tinggal di folder config, bukan di repo", () => {
  assert.equal(learnedSkillsDir(), path.join(root, "config", "titah", "skills", "learned"))
  assert.equal(learnLogFile(), path.join(root, "config", "titah", "learn.log"))
})
