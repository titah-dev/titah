import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { isExplicit, loadConfig, redact, ConfigError } from "../src/core/config.ts"
import { Config } from "../src/core/schema.ts"

function sandbox(): { configHome: string; project: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-test-"))
  const configHome = path.join(root, "config")
  const project = path.join(root, "project")
  fs.mkdirSync(path.join(configHome, "titah"), { recursive: true })
  fs.mkdirSync(project, { recursive: true })

  const prevConfig = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  const prevData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(root, "data")

  return {
    configHome,
    project,
    cleanup() {
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prevConfig
      if (prevData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevData
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function writeGlobal(configHome: string, value: unknown): void {
  fs.writeFileSync(
    path.join(configHome, "titah", "titah.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  )
}

test("membaca JSONC: komentar dan trailing comma diterima", () => {
  const box = sandbox()
  try {
    writeGlobal(
      box.configHome,
      `{
        // model default
        "model": "local/tiny",
        "logLevel": "DEBUG", /* blok */
      }`,
    )
    const { config } = loadConfig(box.project)
    assert.equal(config.model, "local/tiny")
    assert.equal(config.logLevel, "DEBUG")
  } finally {
    box.cleanup()
  }
})

test("config proyek di-merge di atas config global, array diganti utuh", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {
      model: "global/model",
      logLevel: "WARN",
      instructions: ["a.md", "b.md"],
      provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://g/v1" } } },
    })
    fs.writeFileSync(
      path.join(box.project, "titah.json"),
      JSON.stringify({ model: "project/model", instructions: ["only.md"] }),
    )

    const { config, sources } = loadConfig(box.project)
    assert.equal(config.model, "project/model")
    assert.equal(config.logLevel, "WARN", "kunci yang tidak ditimpa harus bertahan")
    assert.deepEqual(config.instructions, ["only.md"], "array diganti, bukan digabung")
    assert.equal(config.provider["p"]?.options?.baseURL, "http://g/v1")
    assert.equal(sources.length, 2)
  } finally {
    box.cleanup()
  }
})

test("${env:VAR} diganti kalau variabelnya ada", () => {
  const box = sandbox()
  process.env.TITAH_TEST_KEY = "rahasia-123"
  try {
    writeGlobal(box.configHome, {
      provider: {
        p: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://x/v1", apiKey: "${env:TITAH_TEST_KEY}" },
        },
      },
    })
    const { config, missingEnv } = loadConfig(box.project)
    assert.equal(config.provider["p"]?.options?.apiKey, "rahasia-123")
    assert.deepEqual(missingEnv, [])
  } finally {
    delete process.env.TITAH_TEST_KEY
    box.cleanup()
  }
})

test("${env:VAR} yang tidak ada membuang kuncinya dan dicatat, bukan melempar error", () => {
  const box = sandbox()
  delete process.env.TITAH_TEST_ABSENT
  try {
    writeGlobal(box.configHome, {
      model: "p/m",
      provider: {
        p: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://x/v1", apiKey: "${env:TITAH_TEST_ABSENT}" },
        },
      },
    })
    const { config, missingEnv } = loadConfig(box.project)

    // Config tetap termuat — lima provider di config, satu yang dipakai.
    assert.equal(config.model, "p/m")
    assert.equal(config.provider["p"]?.options?.apiKey, undefined)
    assert.equal(missingEnv.length, 1)
    assert.equal(missingEnv[0]?.variable, "TITAH_TEST_ABSENT")
    assert.match(missingEnv[0]?.at ?? "", /provider\.p\.options\.apiKey/)
  } finally {
    box.cleanup()
  }
})

test("JSON rusak melempar ConfigError dengan nama file", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, "{ \"model\": }")
    assert.throws(() => loadConfig(box.project), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /titah\.json/)
      return true
    })
  } finally {
    box.cleanup()
  }
})

test("nilai enum yang tidak sah melempar ConfigError, bukan diam-diam diterima", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { logLevel: "VERBOSE" })
    assert.throws(() => loadConfig(box.project), ConfigError)
  } finally {
    box.cleanup()
  }
})

test("registry agent eksternal MURNI milik user — tidak ada yang disuntik", () => {
  /*
   * Dulu `claude` dan `opencode` disuntik ke setiap config. Itu masuk akal
   * ketika keduanya satu-satunya yang ada, dan berhenti masuk akal begitu
   * daftar ini jadi tempat user mendaftarkan super agent apa pun — menyuntik
   * dua nama berarti dua di antaranya istimewa tanpa alasan.
   */
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {
      externalAgent: { claude: { command: "claude-custom", timeout: 1000 } },
    })
    const { config } = loadConfig(box.project)

    assert.equal(config.externalAgent["claude"]?.command, "claude-custom")
    assert.equal(config.externalAgent["claude"]?.timeout, 1000)
    assert.equal(config.externalAgent["opencode"], undefined, "yang tidak ditulis tidak ada")
    assert.deepEqual(Object.keys(config.externalAgent), ["claude"])
  } finally {
    box.cleanup()
  }
})

test("config tanpa externalAgent menghasilkan registry kosong, bukan dua bawaan", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {})
    assert.deepEqual(loadConfig(box.project).config.externalAgent, {})
  } finally {
    box.cleanup()
  }
})

test("redact menyembunyikan apiKey dan header yang mengandung rahasia", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {
      provider: {
        p: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://x/v1",
            apiKey: "sk-jangan-bocor",
            headers: { "X-Api-Token": "rahasia", "X-Trace": "boleh-terlihat" },
          },
        },
      },
    })
    const { config } = loadConfig(box.project)
    const safe = redact(config)

    assert.equal(safe.provider["p"]?.options?.apiKey, "***")
    assert.equal(safe.provider["p"]?.options?.headers?.["X-Api-Token"], "***")
    assert.equal(safe.provider["p"]?.options?.headers?.["X-Trace"], "boleh-terlihat")
    assert.equal(config.provider["p"]?.options?.apiKey, "sk-jangan-bocor", "asli tidak berubah")
  } finally {
    box.cleanup()
  }
})

test("tiga mode bawaan disuntikkan: plan, build, build-auto", () => {
  const box = sandbox()
  try {
    const { config } = loadConfig(box.project)

    assert.deepEqual(
      Object.keys(config.agent).sort(),
      ["build", "build-auto", "plan"],
    )
    assert.equal(config.agent["plan"]?.permission?.write, "deny")
    // `bash` di mode Plan sengaja ALLOW: yang ditegakkan mode itu adalah tool
    // berkas menolak, bukan shell. Lihat test/plan-mode.test.ts.
    assert.equal(config.agent["plan"]?.permission?.bash, "allow")
    assert.equal(config.agent["build"]?.permission?.write, "ask")
    assert.equal(config.agent["build-auto"]?.permission?.write, "allow")
  } finally {
    box.cleanup()
  }
})

test("mode default adalah build — bukan 'tanpa agent' yang tak bernama", () => {
  const box = sandbox()
  try {
    assert.equal(loadConfig(box.project).config.defaultAgent, "build")
  } finally {
    box.cleanup()
  }
})

test("defaultAgent pilihan user tidak ditimpa", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { defaultAgent: "plan" })
    assert.equal(loadConfig(box.project).config.defaultAgent, "plan")
  } finally {
    box.cleanup()
  }
})

test("agent bawaan bisa ditimpa user dengan id yang sama", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {
      agent: { plan: { description: "punyaku", tools: {} } },
    })
    const { config } = loadConfig(box.project)

    assert.equal(config.agent["plan"]?.description, "punyaku")
    assert.deepEqual(config.agent["plan"]?.tools, {}, "definisi user menang utuh")
    assert.ok(config.agent["build-auto"], "bawaan lain tetap ada")
  } finally {
    box.cleanup()
  }
})

test("agent milik user sendiri hidup berdampingan dengan bawaan", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { agent: { qc: { description: "punyaku" } } })
    const { config } = loadConfig(box.project)

    assert.deepEqual(
      Object.keys(config.agent).sort(),
      ["build", "build-auto", "plan", "qc"],
    )
  } finally {
    box.cleanup()
  }
})

test("skills.discover menyala untuk claude dan opencode secara default", () => {
  const config = loadConfig(sandbox().project).config
  assert.deepEqual(config.skills.discover, ["claude", "opencode"])
  assert.deepEqual(config.skills.always, [])
})

test("path skill boleh string biasa atau objek berlabel", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, {
      skills: { paths: ["./skills", { path: "~/lib/skills", as: "punyaku" }] },
    })
    const { config } = loadConfig(box.project)
    assert.equal(config.skills.paths[0], "./skills")
    assert.deepEqual(config.skills.paths[1], { path: "~/lib/skills", as: "punyaku" })
  } finally {
    box.cleanup()
  }
})

test("auto-deteksi bisa dimatikan seluruhnya", () => {
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { skills: { discover: [] } })
    assert.deepEqual(loadConfig(box.project).config.skills.discover, [])
  } finally {
    box.cleanup()
  }
})

test("sumber auto-deteksi yang tidak dikenal ditolak, bukan diabaikan", () => {
  // Salah ketik "openccode" yang diam-diam diabaikan berarti skill hilang tanpa
  // satu pun petunjuk kenapa.
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { skills: { discover: ["openccode"] } })
    assert.throws(() => loadConfig(box.project))
  } finally {
    box.cleanup()
  }
})

test("mode default-nya primary, bukan all", () => {
  // Keputusan keamanan: `build-auto` yang sudah ada punya permission serba-izinkan.
  // Default "all" akan menyerahkan bawahan yang TIDAK PERNAH bertanya sebelum
  // menulis kepada model, tanpa user menuliskan sebaris pun.
  const config = Config.parse({ agent: { build: {} } })
  assert.equal(config.agent["build"]?.mode, "primary")
})

test("mode subagent dan all keduanya sah", () => {
  const config = Config.parse({
    agent: { explore: { mode: "subagent" }, build: { mode: "all" } },
  })
  assert.equal(config.agent["explore"]?.mode, "subagent")
  assert.equal(config.agent["build"]?.mode, "all")
})

test("mode yang tidak dikenal ditolak, bukan diabaikan", () => {
  assert.throws(() => Config.parse({ agent: { x: { mode: "worker" } } }))
})

test("delegate menunjuk agent eksternal", () => {
  const config = Config.parse({
    agent: { reviewer: { mode: "subagent", delegate: "claude" } },
  })
  assert.equal(config.agent["reviewer"]?.delegate, "claude")
})

test("delegate dan model bersamaan DITOLAK", () => {
  // Satu agent, satu mesin. Menyetel keduanya berarti tidak ada jawaban atas
  // "mana yang dipakai", dan diam-diam memilih salah satunya menyembunyikan
  // kesalahan konfigurasi yang nyata.
  assert.throws(
    () => Config.parse({ agent: { x: { delegate: "claude", model: "9router/ant" } } }),
    /delegate/i,
  )
})

test("compaction punya default yang bisa dipakai tanpa konfigurasi apa pun", () => {
  const config = Config.parse({})
  assert.deepEqual(config.compaction, {
    auto: true,
    reserved: 8192,
    tailTurns: 2,
    prune: true,
  })
})

test("compaction.auto false bisa dinyatakan tanpa menyebut field lain", () => {
  const config = Config.parse({ compaction: { auto: false } })
  assert.equal(config.compaction.auto, false)
  assert.equal(config.compaction.tailTurns, 2)
})

test("default level FIELD compaction juga benar, bukan hanya level blok", () => {
  // Config.parse({}) lolos lewat Compaction.default({...}) di :250, yang
  // menyalin keempat nilai ini secara literal — tidak pernah menyentuh
  // .default() milik masing-masing field. Memberi SATU field (auto) memaksa
  // Zod memvalidasi objeknya sungguhan, sehingga reserved/tailTurns/prune di
  // sini datang dari .default() field-nya sendiri di schema.ts, bukan dari
  // salinan di :250 — kalau keduanya menyimpang, baru di sini ketahuan.
  const config = Config.parse({ compaction: { auto: false } })
  assert.equal(config.compaction.reserved, 8192)
  assert.equal(config.compaction.tailTurns, 2)
  assert.equal(config.compaction.prune, true)
})

test("steps opsional pada agent, dan wajib positif", () => {
  const config = Config.parse({ agent: { scout: { steps: 5 } } })
  assert.equal(config.agent["scout"]?.steps, 5)
  assert.throws(() => Config.parse({ agent: { scout: { steps: 0 } } }))
  assert.throws(() => Config.parse({ agent: { scout: { steps: -1 } } }))
})

test("agent tanpa steps tidak memaksa nilai apa pun", () => {
  const config = Config.parse({ agent: { scout: {} } })
  assert.equal(config.agent["scout"]?.steps, undefined)
})

test("isExplicit membedakan angka yang user tulis dari nilai bawaan Zod", () => {
  // Setelah `Config.parse`, nilai bawaan dan nilai yang diketik user terlihat
  // persis sama. Itu cukup untuk menjalankan program, tapi tidak cukup untuk
  // berbicara kepada user: `titah doctor` memakai ini supaya berhenti menegur
  // orang tentang `compaction.reserved` yang tidak pernah ia tulis.
  const box = sandbox()
  try {
    writeGlobal(box.configHome, { model: "a/b" })
    const bawaan = loadConfig(box.project)
    // Positif dulu: kunci yang MEMANG ditulis terbaca eksplisit, jadi
    // `false` di bawah bukan karena fungsinya selalu mengembalikan false.
    assert.equal(isExplicit(bawaan, ["model"]), true)
    assert.equal(bawaan.config.compaction.reserved, 8192, "nilainya tetap terisi bawaan")
    assert.equal(isExplicit(bawaan, ["compaction", "reserved"]), false)
    assert.equal(isExplicit(bawaan, ["compaction"]), false)

    writeGlobal(box.configHome, { model: "a/b", compaction: { reserved: 8192 } })
    const ditulis = loadConfig(box.project)
    // Nilainya IDENTIK dengan bawaan — hanya asalnya yang berbeda, dan itulah
    // yang harus bisa dibedakan.
    assert.equal(ditulis.config.compaction.reserved, 8192)
    assert.equal(isExplicit(ditulis, ["compaction", "reserved"]), true)
  } finally {
    box.cleanup()
  }
})
