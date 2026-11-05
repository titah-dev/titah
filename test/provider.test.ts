import assert from "node:assert/strict"
import test from "node:test"
import {
  parseModelId,
  resolveCredential,
  resolveModel,
  ProviderError,
  compactionWindowFor,
  contextWindowFor,
  summariserModelFor,
  summariserWindowFor,
  turnModelFor,
  undeclaredContextWindows,
  ignoredCompactionFocus,
} from "../src/core/provider.ts"
import { Config, Provider } from "../src/core/schema.ts"

const compatible = (overrides: Record<string, unknown> = {}) =>
  Provider.parse({
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "http://x/v1" },
    models: { m: {} },
    ...overrides,
  })

test("jendela peringkas: milik peringkasnya, dengan jendela giliran sebagai jaring", () => {
  // Ronde review ketiga menemukan dua hal di sini. `/compact` tidak punya jaring
  // sama sekali — jendela yang tidak dideklarasikan berarti `Infinity`, jadi
  // seluruh transkrip dikirim sebagai satu potongan tanpa batas — sementara baris
  // `doctor` yang ditambahkan siklus ini justru MENJANJIKAN jaring itu ("bounded
  // by the turn model's window instead"). Satu fungsi untuk kedua jalur menutup
  // keduanya sekaligus.
  const cfg = (extra: Record<string, unknown>) =>
    ({
      model: "ollama/giliran",
      provider: {
        ollama: {
          models: {
            giliran: { contextWindow: 8192 },
            kecil: { contextWindow: 4096 },
            "tanpa-jendela": {},
          },
        },
      },
      ...extra,
    }) as unknown as Config

  // smallModel dengan jendela sendiri: itu yang berlaku.
  assert.equal(summariserWindowFor(cfg({ smallModel: "ollama/kecil" }), "ollama/giliran"), 4096)
  // smallModel TANPA jendela: jatuh ke jendela giliran — bukan tak terbatas.
  assert.equal(
    summariserWindowFor(cfg({ smallModel: "ollama/tanpa-jendela" }), "ollama/giliran"),
    8192,
  )
  // Tanpa smallModel: model giliran sendiri yang meringkas.
  assert.equal(summariserWindowFor(cfg({}), "ollama/giliran"), 8192)
  // Tidak ada yang dideklarasikan sama sekali: undefined, yang berarti "jangan
  // potong" — bukan nol, dan bukan potongan terkecil yang mungkin.
  assert.equal(summariserWindowFor(cfg({}), "ollama/tanpa-jendela"), undefined)
})

test("model giliran: milik agent kalau ia menyatakannya, kalau tidak override-nya", () => {
  // Ronde review keempat: aturan ini hidup di DUA tempat dan sempat menyimpang —
  // jalur giliran biasa memakai `agentDef?.model ?? modelOverride`, sementara
  // `/compact` memakai `input.model` mentah. Akibatnya sebuah `defaultAgent` yang
  // menyatakan modelnya sendiri diringkas oleh model bawaan, sedangkan pemadatan
  // otomatis di sesi yang SAMA memakai model agent itu: dua ringkasan dengan mutu
  // berbeda dalam satu sesi, persis yang dihindari saat `/compact` dipindah ke
  // `smallModel`.
  const cfg = {
    model: "ollama/bawaan",
    agent: { pembaca: { model: "openai/besar" }, polos: {} },
    provider: {},
  } as unknown as Config

  assert.equal(turnModelFor(cfg, "pembaca", undefined), "openai/besar")
  // Override eksplisit tetap kalah dari model yang dinyatakan agent — itu aturan
  // yang sudah berlaku di jalur giliran biasa, dan kini berlaku di kedua tempat.
  assert.equal(turnModelFor(cfg, "pembaca", "ollama/lain"), "openai/besar")
  assert.equal(turnModelFor(cfg, "polos", "ollama/lain"), "ollama/lain")
  assert.equal(turnModelFor(cfg, undefined, "ollama/lain"), "ollama/lain")
  assert.equal(turnModelFor(cfg, undefined, undefined), undefined)
})

test("model peringkas: smallModel dulu, lalu model giliran, lalu model bawaan", () => {
  // Ronde review kedua menemukan dua ekspresi berbeda untuk satu keputusan:
  // peringkasnya di-resolve dari `smallModel ?? input.model`, jendelanya dihitung
  // dari `agentDef?.model ?? modelOverride`. Keduanya menyimpang persis pada
  // kasus nyata — `subagent.ts` memanggil `prompt()` TANPA model — sehingga
  // sebuah agent dengan `model` sendiri memberi jendela 400.000 sementara yang
  // meringkas adalah model bawaan berjendela 8192. Satu fungsi menutup celahnya.
  const base = { model: "ollama/besar", provider: {}, agent: {} } as unknown as Config

  assert.equal(summariserModelFor(base, "openai/giliran"), "openai/giliran")
  assert.equal(summariserModelFor(base, undefined), "ollama/besar")
  assert.equal(
    summariserModelFor({ ...base, smallModel: "ollama/kecil" } as Config, "openai/giliran"),
    "ollama/kecil",
    "smallModel selalu menang: ia memang yang menulis ringkasan",
  )
})

test("parseModelId memisah pada slash pertama saja", () => {
  assert.deepEqual(parseModelId("ollama/qwen3.5:27b"), {
    providerId: "ollama",
    modelId: "qwen3.5:27b",
  })
  // Id model sering mengandung slash — ini yang membuat split naif salah.
  assert.deepEqual(parseModelId("9router/cx/gpt-5.4"), {
    providerId: "9router",
    modelId: "cx/gpt-5.4",
  })
})

test("parseModelId menolak bentuk yang bukan provider/model", () => {
  for (const bad of ["telanjang", "/awalan", "akhiran/", ""]) {
    assert.throws(() => parseModelId(bad), ProviderError, `seharusnya menolak: "${bad}"`)
  }
})

test("kredensial dari config menang atas env", () => {
  process.env.TITAH_P_API_KEY = "dari-env"
  try {
    const result = resolveCredential("p", compatible({ options: { baseURL: "http://x/v1", apiKey: "dari-config" } }))
    assert.equal(result.key, "dari-config")
    assert.equal(result.source, "config")
  } finally {
    delete process.env.TITAH_P_API_KEY
  }
})

test("tanpa config, kredensial jatuh ke env var konvensional", () => {
  process.env.TITAH_P_API_KEY = "dari-env"
  try {
    const result = resolveCredential("p", compatible())
    assert.equal(result.key, "dari-env")
    assert.equal(result.source, "env")
  } finally {
    delete process.env.TITAH_P_API_KEY
  }
})

test("tanpa kredensial sama sekali, source = none", () => {
  delete process.env.TITAH_P_API_KEY
  const result = resolveCredential("p", compatible())
  assert.equal(result.key, undefined)
  assert.equal(result.source, "none")
})

test("tanpa model default, resolveModel menolak alih-alih menebak", () => {
  const config = Config.parse({})
  assert.throws(() => resolveModel(config), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.match(error.message, /does not guess/)
    return true
  })
})

test("provider yang tidak dikenal menyebutkan yang tersedia", () => {
  const config = Config.parse({ model: "hilang/m", provider: { ada: compatible() } })
  assert.throws(() => resolveModel(config), (error: unknown) => {
    assert.ok(error instanceof ProviderError)
    assert.match(error.message, /ada/)
    return true
  })
})

test("openai-compatible tanpa baseURL adalah error, bukan default diam-diam", () => {
  const config = Config.parse({
    model: "p/m",
    provider: { p: { npm: "@ai-sdk/openai-compatible", models: { m: {} } } },
  })
  assert.throws(() => resolveModel(config), /baseURL/)
})

test("openai-compatible tanpa apiKey tetap boleh — endpoint lokal tidak butuh kunci", () => {
  delete process.env.TITAH_OLLAMA_API_KEY
  const config = Config.parse({
    model: "ollama/m",
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://localhost:11434/v1" },
        models: { m: {} },
      },
    },
  })
  assert.doesNotThrow(() => resolveModel(config))
})

test("anthropic tanpa apiKey menolak dengan instruksi yang bisa dijalankan", () => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.TITAH_ANT_API_KEY
  const config = Config.parse({
    model: "ant/claude-x",
    provider: { ant: { npm: "@ai-sdk/anthropic", models: { "claude-x": {} } } },
  })
  assert.throws(() => resolveModel(config), /titah auth set ant/)
})

test("contextWindowFor membaca angka yang dideklarasikan config", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: {
      ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } },
    },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), 32768)
})

test("contextWindowFor memakai config.model saat argumennya kosong", () => {
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": { contextWindow: 32768 } } } },
  })
  assert.equal(contextWindowFor(config), 32768)
})

test("contextWindowFor memenangkan argumen `full` di atas config.model, bukan sebaliknya", () => {
  // Tugas berikutnya memanggil contextWindowFor(config, agentDef?.model ?? modelOverride)
  // di jalur panas — kalau precedence-nya terbalik, override model sub-agent
  // akan diam-diam memakai jendela konteks model DEFAULT, salah tanpa terlihat.
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: {
      ollama: {
        models: {
          "qwen3:14b": { contextWindow: 32768 },
          "llama3:8b": { contextWindow: 8192 },
        },
      },
    },
  })
  assert.equal(contextWindowFor(config, "ollama/llama3:8b"), 8192)
})

test("model tanpa contextWindow mengembalikan undefined, BUKAN angka tebakan", () => {
  // Angka yang salah lebih berbahaya daripada tidak ada angka: memadatkan
  // terlalu telat tidak bisa dibedakan dari tidak memadatkan sama sekali,
  // kecuali user sudah telanjur percaya masalahnya tertangani.
  const config = Config.parse({
    model: "ollama/qwen3:14b",
    provider: { ollama: { models: { "qwen3:14b": {} } } },
  })
  assert.equal(contextWindowFor(config, "ollama/qwen3:14b"), undefined)
})

test("id model yang tidak berbentuk provider/model tidak melempar, cuma undefined", () => {
  // contextWindowFor dipanggil di jalur panas tiap langkah. Melempar di sini
  // akan mematikan giliran gara-gara metadata yang hilang.
  //
  // Ketiga bentuk cacat diuji, bukan cuma yang tanpa garis miring. Penjaganya
  // satu baris dengan tiga syarat (`slash <= 0 || slash === panjang - 1`), dan
  // melonggarkannya jadi `slash < 0` tetap lolos pada config biasa — dua
  // pertiga penjaganya lalu tidak terjaga apa pun.
  //
  // Karena itu config di sini SENGAJA punya kunci kosong. Kunci kosong adalah
  // salah ketik yang sungguh terjadi (`"": { ... }` di titah.json), dan
  // pertanyaannya persis: apakah id yang cacat gagal dengan aman, atau
  // diam-diam menemukan jendela konteks milik entri yang salah? Jendela yang
  // salah adalah kegagalan paling senyap di seluruh fitur ini — pemadatan yang
  // terlambat tidak bisa dibedakan dari tidak ada pemadatan.
  const config = Config.parse({
    provider: {
      mock: { models: { m: { contextWindow: 4096 }, "": { contextWindow: 222 } } },
      "": { models: { m: { contextWindow: 111 } } },
    },
  })

  // Positif dulu: bentuk yang BENAR memang menemukan angkanya, DAN entri
  // berkunci kosong itu sungguh ada untuk ditemukan — tanpa ini, `undefined`
  // di bawah bisa berarti "tidak ada apa-apa di sana", bukan "ditolak".
  assert.equal(contextWindowFor(config, "mock/m"), 4096)
  assert.equal(config.provider[""]?.models["m"]?.contextWindow, 111)
  assert.equal(config.provider["mock"]?.models[""]?.contextWindow, 222)

  assert.equal(contextWindowFor(config, "tanpa-slash"), undefined)
  assert.equal(contextWindowFor(config, "/m"), undefined, "provider kosong ditolak, bukan dicocokkan")
  assert.equal(contextWindowFor(config, "mock/"), undefined, "model kosong ditolak, bukan dicocokkan")
})

test("undeclaredContextWindows menyebut model yang dikonfigurasi tanpa batas", () => {
  const config = Config.parse({
    provider: {
      ollama: {
        models: { "qwen3:14b": { contextWindow: 32768 }, "llama3:8b": {} },
      },
    },
  })
  assert.deepEqual(undeclaredContextWindows(config), ["ollama/llama3:8b"])
})

test("ambang pemadatan memakai compactAt model, lalu compaction.target, dan tidak pernah melebihi jendela", () => {
  const cfg = Config.parse({
    compaction: { target: 131072 },
    provider: {
      p: {
        models: {
          besar: { contextWindow: 1_000_000 },
          fokus: { contextWindow: 1_000_000, compactAt: 200000 },
          kecil: { contextWindow: 32768 },
        },
      },
    },
  })
  assert.equal(compactionWindowFor(cfg, "p/besar"), 131072)
  // compactAt per model menang atas target global.
  assert.equal(compactionWindowFor(cfg, "p/fokus"), 200000)
  // Target lebih besar dari jendela dijepit: kapasitas asli tetap batas keras.
  assert.equal(compactionWindowFor(cfg, "p/kecil"), 32768)

  const tanpaWindow = Config.parse({
    compaction: { target: 131072 },
    provider: { p: { models: { x: {} } } },
  })
  // Jendela tidak dideklarasikan berarti pemadatan mati, apa pun targetnya.
  assert.equal(compactionWindowFor(tanpaWindow, "p/x"), undefined)

  const tanpaTarget = Config.parse({
    provider: { p: { models: { besar: { contextWindow: 1_000_000 } } } },
  })
  assert.equal(compactionWindowFor(tanpaTarget, "p/besar"), 1_000_000)
})

test("compactAt atau compaction.target tanpa contextWindow dilaporkan sebagai diabaikan", () => {
  /*
   * `compactionWindowFor` mengembalikan undefined tanpa jendela: aturan "tidak
   * dideklarasikan berarti mati" menang atas target. User yang menulis
   * compactAt 100000 mengira pemadatannya hidup — tanpa laporan ini, ia tidak
   * punya cara mengetahui angkanya tidak dipakai.
   */
  const cfg = Config.parse({
    compaction: { target: 131072 },
    provider: {
      p: {
        models: {
          sendiri: { compactAt: 100000 },
          global: {},
          sehat: { contextWindow: 200000, compactAt: 100000 },
        },
      },
    },
  })
  assert.deepEqual(ignoredCompactionFocus(cfg), [
    { model: "p/sendiri", setting: "compactAt", value: 100000 },
    { model: "p/global", setting: "compaction.target", value: 131072 },
  ])
  // Tanpa target, model tanpa jendela dan tanpa compactAt tidak menyetel apa pun.
  const polos = Config.parse({ provider: { p: { models: { x: {} } } } })
  assert.deepEqual(ignoredCompactionFocus(polos), [])
})

/**
 * Badan permintaan yang SUNGGUH dikirim model hasil `resolveModel`.
 *
 * `fetch` global diganti sebelum resolve karena provider.ts meneruskan `fetch`
 * global ke `withCacheControl` saat itu juga. Respons sengaja gagal: yang
 * diperiksa hanya badan yang berangkat.
 */
async function sentBody(providerOverrides: Record<string, unknown>): Promise<string> {
  const config = Config.parse({
    model: "gw/m",
    provider: {
      gw: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://gateway.test/v1", apiKey: "k" },
        models: { m: {} },
        ...providerOverrides,
      },
    },
  })
  const original = globalThis.fetch
  let body = ""
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    body = typeof init?.body === "string" ? init.body : ""
    return new Response("{}", { status: 500 })
  }) as typeof fetch
  try {
    const model = resolveModel(config) as unknown as {
      doGenerate: (options: unknown) => Promise<unknown>
    }
    await model
      .doGenerate({
        prompt: [
          { role: "system", content: "S" },
          { role: "user", content: [{ type: "text", text: "<references>\nR" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "halo" }] },
        ],
        maxRetries: 0,
      })
      .catch(() => {})
  } finally {
    globalThis.fetch = original
  }
  assert.ok(body !== "", "permintaan harus benar-benar dikirim")
  return body
}

test("cacheReferences dari config sampai ke withCacheControl, dan bawaannya mati", async () => {
  /*
   * Tanda kedua belum diverifikasi di gateway mana pun; sebagian gateway
   * menolak lebih dari satu cache_control. Jadi opt-in. Yang dipatok di sini
   * adalah sambungan provider.ts — test cache-control.ts hanya membuktikan
   * fungsinya sendiri, bukan bahwa nilai config sampai ke sana.
   */
  const marks = (body: string): number => body.split('"cache_control"').length - 1

  const bawaan = await sentBody({ cacheControl: true })
  assert.equal(marks(bawaan), 1, "hanya system")

  const nyala = await sentBody({ cacheControl: true, cacheReferences: true })
  assert.equal(marks(nyala), 2, "system dan referensi")

  const mati = await sentBody({ cacheControl: false, cacheReferences: true })
  assert.equal(marks(mati), 0, "tanpa cacheControl tidak ada tanda sama sekali")
})
