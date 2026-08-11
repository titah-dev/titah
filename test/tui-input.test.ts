import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { createElement } from "react"
import { render } from "ink"
import { App, sanitizePaste, toKeyPress } from "../dist/tui/app.js"
import { buildKeymap, resolve } from "../dist/tui/keybinds.js"
import { createMouseSource } from "../dist/tui/mouse.js"
import { markLines } from "../dist/tui/logo.js"
import { Config } from "../dist/core/schema.js"
import type { Client } from "../dist/tui/client.js"
import type { Session } from "../dist/core/message.js"
import type { Event } from "../dist/core/event.js"

/**
 * Menguji penanganan tombol dengan merender App sungguhan ke stream palsu.
 *
 * pty terlalu berisik untuk ini: `script` melewatkan input lewat termios yang
 * mengubah CR menjadi NL, sehingga kegagalan harness tidak bisa dibedakan dari
 * kegagalan produk.
 */

const session: Session = {
  id: "ses_tui",
  title: "",
  directory: "/proyek",
  created: 1,
  updated: 1,
}

/**
 * Ink 7 membaca stdin lewat event `readable` + `stream.read()`, BUKAN `data`.
 * EventEmitter polos tidak akan pernah menyampaikan tombol apa pun.
 */
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  /** Satu keystroke = satu chunk. Teks + Enter dalam satu chunk dibaca Ink sebagai tempelan. */
  press(sequence: string): void {
    this.write(sequence)
  }
}

/** Ink butuh ukuran layar; tanpa columns/rows ia tidak merender apa pun. */
class FakeStdout extends PassThrough {
  isTTY = true
  columns = 100
  rows = 30
}

interface Recorded {
  /** Jawaban /session/:id/status yang dipalsukan. */
  running: boolean
  /** Jawaban /session/:id/abort — false berarti tidak ada yang berjalan. */
  aborted_result: boolean
  /** Sesi yang dibuang karena kosong. */
  discarded: string[]
  sent: { text: string; agent?: string; sessionID: string }[]
  created: number
  messagesFor: string[]
  aborted: string[]
  undone: string[]
  permissions: { id: string; decision: string }[]
}

function fakeClient(recorded: Recorded, emit: (push: (event: Event) => void) => void): Client {
  return {
    baseURL: "http://fake",
    async health() {
      return { status: "ok", version: "test", pid: 0 }
    },
    async createSession() {
      recorded.created += 1
      return { ...session, id: `ses_baru_${recorded.created}`, title: "" }
    },
    async listSessions() {
      return [
        session,
        { ...session, id: "ses_lama", title: "sesi lama", updated: 2 },
      ]
    },
    async messages(sessionID: string) {
      recorded.messagesFor.push(sessionID)
      if (sessionID !== "ses_lama") return []
      return [
        {
          id: "m-lama",
          sessionID,
          role: "assistant" as const,
          created: 1,
          parts: [{ type: "text" as const, text: "isi sesi lama" }],
        },
      ]
    },
    async send(sessionID: string, text: string, _model?: string, agent?: string) {
      recorded.sent.push({ text, sessionID, ...(agent ? { agent } : {}) })
      return { id: "m", sessionID: session.id, role: "assistant" as const, created: 1, parts: [] }
    },
    async status() {
      return { running: recorded.running }
    },
    async discard(sessionID: string) {
      recorded.discarded.push(sessionID)
      return { discarded: true }
    },
    async abort(sessionID: string) {
      recorded.aborted.push(sessionID)
      return { aborted: recorded.aborted_result }
    },
    async undo(sessionID: string) {
      recorded.undone.push(sessionID)
      return { messageID: "m", snapshot: "abc", files: ["a.ts"] }
    },
    async respondPermission(_s: string, id: string, decision: string) {
      recorded.permissions.push({ id, decision })
      return { ok: true }
    },
    async *events() {
      const queue: Event[] = []
      let notify: (() => void) | undefined
      emit((event) => {
        queue.push(event)
        notify?.()
      })
      while (true) {
        while (queue.length > 0) yield queue.shift() as Event
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    },
  } as unknown as Client
}

async function tick(times = 4): Promise<void> {
  // setImmediate saja tidak cukup: event dari generator palsu melewati beberapa
  // microtask sebelum React memproses dispatch-nya.
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 15))
}

interface Harness {
  stdin: FakeStdin
  /** Klik/roda mouse, disuntik langsung tanpa terminal sungguhan. */
  mouse: ReturnType<typeof createMouseSource>
  /** Urutan on/off yang diminta ke terminal. */
  captureLog: boolean[]
  recorded: Recorded
  push: (event: Event) => void
  frame: () => string
  /** Buang output yang sudah terkumpul. Ink menulis bertambah, jadi tanpa ini
   *  `doesNotMatch` selalu gagal: bingkai lama masih ada di buffer. */
  clear: () => void
  cleanup: () => void
}

/** Direktori skill sungguhan di disk sementara, untuk memicu popup "Insert skill". */
function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-tui-skill-"))
  for (const [relative, content] of Object.entries(spec)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

function mount(
  options: {
    agents?: string[]
    defaultAgent?: string
    /** discover: [] tetap wajib — kalau tidak, test ini membaca ~/.claude sungguhan. */
    skillPaths?: { path: string; as: string }[]
  } = {},
): Harness {
  const stdin = new FakeStdin()
  const mouse = createMouseSource()
  const captureLog: boolean[] = []
  const mouseWithCapture = { ...mouse, setCapture: (on: boolean) => captureLog.push(on) }
  const stdout = new FakeStdout()
  let output = ""
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  const recorded: Recorded = {
    running: false,
    aborted_result: true,
    sent: [],
    aborted: [],
    discarded: [],
    undone: [],
    permissions: [],
    created: 0,
    messagesFor: [],
  }
  let push: (event: Event) => void = () => {}
  const client = fakeClient(recorded, (fn) => {
    push = fn
  })

  const instance = render(
    createElement(App, {
      client,
      session,
      cwd: "/proyek",
      model: "uji/model",
      config: Config.parse({
        agent: { plan: { description: "Plan only" }, build: { description: "Build" } },
        externalAgent: { claude: { command: process.execPath } },
        provider: {
          local: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://x/v1" },
            models: { "m1": {}, "m2": {} },
          },
        },
        // discover: [] di semua test, bukan hanya yang menyentuh skill — supaya
        // menambah skill ke satu test tidak diam-diam membuat SEMUA test lain
        // mulai membaca ~/.claude atau ~/.config/opencode sungguhan.
        skills: { discover: [], paths: options.skillPaths ?? [] },
      }),
      ...(options.agents ? { agents: options.agents } : {}),
      ...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
      mouse: mouseWithCapture,
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  return {
    stdin,
    mouse,
    captureLog,
    recorded,
    push: (event) => push(event),
    frame: () => output.replace(/\[[0-9;?]*[a-zA-Z]/g, ""),
    clear() {
      output = ""
    },
    cleanup: () => instance.unmount(),
  }
}

test("mengetik lalu Enter mengirim prompt dan mengosongkan editor", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("halo")
    await tick()
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(
      h.recorded.sent.map((item) => item.text),
      ["halo"],
      "Enter harus memanggil client.send",
    )
    // `.at(-6)` sebelumnya menyasar baris petunjuk footer yang statis ("@claude
    // to delegate..."), BUKAN baris penyunting -- indeks itu bergeser begitu
    // baris petunjuk kedua ditambahkan, dan sejak itu assert ini tidak pernah
    // benar-benar memeriksa isi penyunting. `findLast` menyasar baris "› " yang
    // TERAKHIR ditulis (baris tunggal itu unik untuk kotak penyunting di test
    // ini), jadi ia tahan terhadap footer yang berubah dan tetap membaca
    // keadaan penyunting yang paling baru walau bingkai lama tetap menumpuk di
    // buffer (test ini sengaja tidak memanggil `h.clear()`, karena "halo" harus
    // sempat terlihat SEBELUM Enter).
    //
    // `?? ""` DIHINDARI dengan sengaja: kalau tidak ada baris "› " sama sekali
    // (mis. seseorang menambahkan `h.clear()` sebelum baris ini, idiom yang
    // dominan di file ini), fallback ke string kosong akan membuat
    // `doesNotMatch` di bawah lolos tanpa bukti apa pun -- persis lubang yang
    // audit ini menutup. Gagal keras di sini, bukan lolos diam-diam.
    const lines = h.frame().split("\n")
    const editorLine = lines.findLast((line) => line.includes("› "))
    assert.ok(
      editorLine !== undefined,
      "harus ada baris penyunting \"› \" di bingkai ini -- kalau tidak ada, test ini tidak membuktikan apa pun",
    )
    assert.doesNotMatch(editorLine, /halo/, "editor harus kosong lagi")
  } finally {
    h.cleanup()
  }
})

test("Ctrl+J menyisipkan baris baru, bukan mengirim", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("baris1")
    await tick(1)
    h.stdin.press("\n") // ctrl+j
    await tick(1)
    h.stdin.press("baris2")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "ctrl+j tidak boleh mengirim")
    assert.match(h.frame(), /baris1/)
    assert.match(h.frame(), /baris2/)
  } finally {
    h.cleanup()
  }
})

test("prompt kosong tidak dikirim", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("   ")
    h.stdin.press("\r")
    await tick()
    assert.deepEqual(h.recorded.sent, [])
  } finally {
    h.cleanup()
  }
})

test("Esc membatalkan giliran yang sedang berjalan", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: { id: "u1", sessionID: session.id, role: "user", created: 1, parts: [] },
    })
    await tick()

    h.stdin.press("")
    await tick()

    assert.deepEqual(h.recorded.aborted, [session.id])
  } finally {
    h.cleanup()
  }
})

test("Esc saat menganggur tidak memanggil abort", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("")
    await tick()
    assert.deepEqual(h.recorded.aborted, [])
  } finally {
    h.cleanup()
  }
})

test("dialog izin menerima y / a / n dan meneruskannya ke server", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "permission.request",
      sessionID: session.id,
      request: {
        id: "perm_1",
        sessionID: session.id,
        kind: "write",
        title: "write a.txt",
        detail: "isi",
        pattern: "write",
        created: 1,
      },
    })
    await tick()

    assert.match(h.frame(), /Permission requested \(write\)/)
    h.stdin.press("a")
    await tick()

    assert.deepEqual(h.recorded.permissions, [{ id: "perm_1", decision: "always" }])
  } finally {
    h.cleanup()
  }
})

test("tombol saat dialog izin terbuka tidak bocor ke editor", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "permission.request",
      sessionID: session.id,
      request: {
        id: "perm_2",
        sessionID: session.id,
        kind: "bash",
        title: "bash: ls",
        detail: "ls",
        pattern: "ls *",
        created: 1,
      },
    })
    await tick()

    h.stdin.press("zzz")
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "Enter tidak boleh mengirim saat dialog terbuka")
    // `.at(-5)` sebelumnya menyasar garis batas ATAS kotak penyunting, satu baris
    // di atas isinya -- salah satu baris yang TIDAK PERNAH memuat "zzz" apa pun
    // yang terjadi. `findLast` menyasar baris "› " yang sungguh berisi draft.
    // Test ini juga sengaja tidak memanggil `h.clear()` -- bingkai menumpuk
    // sejak mount, jadi tidak pernah kosong dengan sendirinya.
    //
    // `?? ""` DIHINDARI: fallback ke string kosong kalau tidak ketemu baris
    // "› " sama sekali akan membuat `doesNotMatch` di bawah lolos tanpa bukti,
    // persis kalau nanti seseorang menambahkan `h.clear()` di sini mengikuti
    // idiom dominan file ini. Gagal keras, bukan lolos diam-diam.
    const lines = h.frame().split("\n")
    const editorLine = lines.findLast((line) => line.includes("› "))
    assert.ok(
      editorLine !== undefined,
      "harus ada baris penyunting \"› \" di bingkai ini -- kalau tidak ada, test ini tidak membuktikan apa pun",
    )
    assert.doesNotMatch(editorLine, /zzz/)
  } finally {
    h.cleanup()
  }
})

test("leader ctrl+x lalu u menjalankan undo", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("") // ctrl+x
    await tick()
    h.stdin.press("u")
    await tick()

    assert.deepEqual(h.recorded.undone, [session.id])
  } finally {
    h.cleanup()
  }
})

test("huruf setelah leader tidak masuk ke editor", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("")
    await tick()
    h.stdin.press("d") // tool_details
    await tick()
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "'d' tidak boleh menjadi isi prompt")
  } finally {
    h.cleanup()
  }
})

test("teks asisten yang di-stream muncul di layar", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: { id: "a1", sessionID: session.id, role: "assistant", created: 1, parts: [] },
    })
    h.push({ type: "text.delta", sessionID: session.id, messageID: "a1", text: "Halo " })
    h.push({ type: "text.delta", sessionID: session.id, messageID: "a1", text: "dunia" })
    await tick()

    assert.match(h.frame(), /Halo dunia/)
  } finally {
    h.cleanup()
  }
})

test("tempelan membuang karakter kontrol tapi mempertahankan newline", () => {
  assert.equal(sanitizePaste("halo"), "halo")
  assert.equal(sanitizePaste("a\rb"), "a\nb", "CR menjadi newline")
  assert.equal(sanitizePaste("a\r\nb"), "a\nb", "CRLF tidak jadi dua baris")
  assert.equal(sanitizePaste("a\u0000b\u001bc"), "abc", "NUL dan ESC dibuang")
  assert.equal(sanitizePaste("baris1\nbaris2"), "baris1\nbaris2")
})

test("teks tempelan yang berakhir dengan CR tidak menyelundupkan kontrol ke prompt", async () => {
  // Ink mengirim tempelan sebagai satu event; tanpa sanitasi, CR ikut terkirim
  // ke model sebagai bagian dari prompt.
  const h = mount()
  try {
    await tick()
    h.stdin.press("prompt tertempel\r")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "tempelan bukan Enter — tidak boleh terkirim")
    assert.match(h.frame(), /prompt tertempel/)
    assert.doesNotMatch(h.frame(), /\u0000|\u001b\[?$/)
    // Regex di atas TIDAK PERNAH bisa menangkap CR mentah yang lolos --
    // sanitizePaste dibuang dari alur input dan bug ini tetap tidak terdeteksi.
    // Baris penyunting diperiksa langsung: sanitasi yang benar menjadikan CR di
    // akhir tempelan sebagai newline, jadi baris "› " tidak boleh memuat \r.
    const editorLine = h.frame().split("\n").findLast((line) => line.includes("› ")) ?? ""
    assert.doesNotMatch(editorLine, /\r/, "CR mentah harus sudah menjadi newline, bukan lolos apa adanya")
  } finally {
    h.cleanup()
  }
})

test("Tab berputar di antara agent, dimulai dari tanpa agent", async () => {
  const h = mount({ agents: ["explore", "qc"] })
  try {
    await tick()

    // Tanpa menekan Tab: tidak ada agent yang dikirim.
    h.stdin.press("a")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent[0]?.agent, undefined)

    h.stdin.press("\t")
    await tick()
    h.stdin.press("b")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent[1]?.agent, "explore")

    h.stdin.press("\t")
    await tick()
    h.stdin.press("c")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent[2]?.agent, "qc")

    // Putaran kembali ke tanpa agent.
    h.stdin.press("\t")
    await tick()
    h.stdin.press("d")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent[3]?.agent, undefined, "Tab harus berputar kembali")
  } finally {
    h.cleanup()
  }
})

test("defaultAgent dipakai sejak awal tanpa menekan Tab", async () => {
  const h = mount({ agents: ["explore", "qc"], defaultAgent: "qc" })
  try {
    await tick()
    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent[0]?.agent, "qc")
  } finally {
    h.cleanup()
  }
})

test("Tab tidak melakukan apa-apa kalau tidak ada agent di config", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("\t")
    await tick()
    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()

    assert.equal(h.recorded.sent.length, 1)
    assert.equal(h.recorded.sent[0]?.agent, undefined)
    assert.equal(h.recorded.sent[0]?.text, "halo", "Tab tidak boleh masuk ke prompt")
  } finally {
    h.cleanup()
  }
})

test("nama agent aktif tampil di footer", async () => {
  const h = mount({ agents: ["explore"], defaultAgent: "explore" })
  try {
    await tick()
    assert.match(h.frame(), /explore · uji\/model/)
  } finally {
    h.cleanup()
  }
})

test("mengetik @ memunculkan popup, esc menutupnya", async () => {
  const h = mount()
  try {
    await tick()
    // Tanda "zzz" ditulis SEBELUM "@" (bukan sesudahnya, yang akan disaring
    // sebagai query popup dan bisa membuatnya menutup diri sendiri lewat cabang
    // "tanpa satu pun pilihan"). Draft bertahan lewat buka/tutup popup, jadi
    // tanda ini tetap ada di bingkai manapun yang benar-benar dirender setelah
    // esc -- tanpa itu, esc yang sepenuhnya rusak (tidak pernah menutup, tidak
    // pernah me-render ulang) lolos identik dari `doesNotMatch` di bawah,
    // karena bingkai KOSONG pun lolos begitu saja.
    for (const ch of "zzz ") h.stdin.press(ch)
    await tick(1)
    h.stdin.press("@")
    await tick()
    assert.match(h.frame(), /Agents & files/)

    h.clear()
    h.stdin.press("\u001b")
    await tick()
    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /Agents & files/)
  } finally {
    h.cleanup()
  }
})

test("mengetik / memunculkan daftar command", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("/")
    await tick()

    const frame = h.frame()
    assert.match(frame, /Commands/)
    assert.match(frame, /\/model/)
    assert.match(frame, /\/consensus/)
  } finally {
    h.cleanup()
  }
})

test("Enter di dalam popup memilih, bukan mengirim prompt", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("@")
    await tick()
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "Enter memilih, bukan mengirim")
    assert.match(h.frame(), /@claude/, "pilihan masuk ke editor")
  } finally {
    h.cleanup()
  }
})

test("/model membuka pemilih model dan pilihannya dipakai giliran berikutnya", async () => {
  const h = mount()
  try {
    await tick()
    for (const ch of "/model") h.stdin.press(ch)
    await tick()

    h.clear()
    // SATU Enter sudah cukup: memilih "/model" dari daftar langsung membuka
    // pemilih model. Harus menekan Enter dua kali adalah alasan orang mengira
    // fitur ini rusak.
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(h.recorded.sent, [], "/model tidak dikirim ke server")
    assert.match(h.frame(), /Switch model/)

    h.stdin.press("\r") // pilih model pertama
    await tick()

    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent.length, 1, "prompt biasa tetap terkirim setelahnya")
  } finally {
    h.cleanup()
  }
})

test("memilih skill dari popup MENGGANTI draft, bukan menambahkannya setelah teks yang sudah ada", async () => {
  // Regresi konkret: popup "Insert skill" (fromMenu) tidak menyaring lewat
  // ketikan tambahan — tombol biasa jatuh ke editor di baliknya (baris 556-557).
  // Jadi draft BISA berisi teks sebelum sebuah skill dipilih, dan memilihnya
  // harus MENGGANTI teks itu, bukan menambahkannya — kalau tidak, command
  // skill mendarat di tengah kalimat dan tidak pernah ditafsirkan sebagai
  // command (`/` hanya berlaku di awal baris).
  const skillDir = tree({ "a/SKILL.md": "---\nname: a\n---\nisi" })
  const h = mount({ skillPaths: [{ path: skillDir, as: "ns" }] })
  try {
    await tick()
    for (const ch of "/skill") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r") // buka popup "Insert skill"; draft dikosongkan di sini
    await tick()
    assert.match(h.frame(), /Insert skill/)

    for (const ch of "oops ") h.stdin.press(ch) // "teks yang sudah ada" — masuk diam-diam ke draft
    await tick()

    h.stdin.press("\r") // pilih satu-satunya skill di daftar
    await tick()

    h.stdin.press("\r") // kirim, supaya isi draft yang sebenarnya bisa diperiksa
    await tick()

    assert.deepEqual(
      h.recorded.sent.map((item) => item.text),
      ["/ns:a"],
      "draft harus PERSIS command skill, tanpa sisa \"oops\" di depannya",
    )
  } finally {
    h.cleanup()
  }
})

test("popup tidak muncul untuk alamat email", async () => {
  const h = mount()
  try {
    await tick()
    for (const ch of "akil") h.stdin.press(ch)
    await tick()
    h.clear()
    h.stdin.press("@")
    await tick()
    assert.doesNotMatch(h.frame(), /Agents & files/)
  } finally {
    h.cleanup()
  }
})

test("spinner muncul di dekat prompt saat bekerja", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: { id: "u1", sessionID: session.id, role: "user", created: 1, parts: [] },
    })
    await tick()
    assert.match(h.frame(), /esc to cancel/)
  } finally {
    h.cleanup()
  }
})

test("Ctrl+P membuka palette command tanpa mengetik apa pun", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("\u0010") // ctrl+p
    await tick()

    const frame = h.frame()
    assert.match(frame, /Commands/)
    assert.match(frame, /\/model/)
    assert.match(frame, /\/agent/)
    assert.equal(h.recorded.sent.length, 0)
  } finally {
    h.cleanup()
  }
})

test("palette → /model → pilih model mengubah model giliran berikutnya", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("\u0010")
    await tick()

    // Item pertama palette adalah /model.
    h.stdin.press("\r")
    await tick()
    assert.match(h.frame(), /Switch model/, "langsung masuk submenu, bukan menyisipkan teks")

    h.stdin.press("\r") // pilih model pertama
    await tick()

    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()

    assert.equal(h.recorded.sent.length, 1)
    assert.equal(h.recorded.sent[0]?.text, "halo", "prompt bersih, tanpa sisa /model")
  } finally {
    h.cleanup()
  }
})

/** Riwayat panjang supaya ada yang bisa digulir. */
function pushLongHistory(h: ReturnType<typeof mount>) {
  h.push({
    type: "message.updated",
    sessionID: session.id,
    message: {
      id: "a1",
      sessionID: session.id,
      role: "assistant",
      created: 1,
      parts: [{ type: "text", text: Array.from({ length: 60 }, (_, i) => `baris ${i}`).join("\n") }],
    },
  })
}

test("pageup menggulir riwayat, tidak masuk ke prompt", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    h.clear()
    h.stdin.press("\u001b[5~")
    await tick()

    assert.match(h.frame(), /lines below/, "penunjuk gulir muncul setelah menggulir ke atas")
    assert.deepEqual(h.recorded.sent, [])
  } finally {
    h.cleanup()
  }
})

test("panah atas memanggil kembali prompt terakhir, bukan menggulir", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    for (const ch of "prompt lama") h.stdin.press(ch)
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent.at(-1)?.text, "prompt lama")

    h.clear()
    h.stdin.press("\u001b[A")
    await tick()
    assert.match(h.frame(), /prompt lama/, "teksnya kembali ke kotak ketik")
    assert.doesNotMatch(h.frame(), /lines below/, "panah atas tidak lagi menggulir")
  } finally {
    h.cleanup()
  }
})

test("error giliran sebelumnya hilang begitu perintah berikutnya dikirim", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    h.push({ type: "session.error", sessionID: session.id, message: "provider mati" })
    await tick()
    assert.match(h.frame(), /provider mati/)

    for (const ch of "coba lagi") h.stdin.press(ch)
    await tick(1)
    h.clear()
    h.stdin.press("\r")
    await tick()

    assert.doesNotMatch(h.frame(), /provider mati/, "error lama tidak menempel di prompt baru")
  } finally {
    h.cleanup()
  }
})

test("/session menampilkan sesi tersimpan, memilihnya memuat riwayatnya", async () => {
  const h = mount()
  try {
    await tick()
    for (const ch of "/session") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r") // pilih /session dari daftar command
    await tick()

    assert.match(h.frame(), /Resume session/)
    assert.match(h.frame(), /sesi lama/)

    h.clear()
    h.stdin.press("\u001b[B") // turun ke sesi lama
    await tick()
    h.stdin.press("\r")
    await tick(6)

    assert.ok(h.recorded.messagesFor.includes("ses_lama"), "riwayat sesi terpilih dimuat")
    assert.match(h.frame(), /isi sesi lama/)
    assert.deepEqual(h.recorded.sent, [], "berpindah sesi bukan mengirim prompt")
  } finally {
    h.cleanup()
  }
})

test("/new membuat sesi baru, dan prompt berikutnya masuk ke sesi itu", async () => {
  const h = mount()
  try {
    await tick()
    for (const ch of "/new") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r")
    await tick(6)

    assert.equal(h.recorded.created, 1, "satu sesi baru dibuat")

    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()

    // Asersi perilaku, bukan mengintip layar: buffer Ink menumpuk bingkai lama,
    // jadi "teks lama tidak terlihat" tidak bisa dibuktikan dari output mentah.
    assert.equal(h.recorded.sent[0]?.sessionID, "ses_baru_1", "prompt masuk ke sesi baru")
  } finally {
    h.cleanup()
  }
})

test("berpindah sesi mengosongkan draft yang belum terkirim", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("belum selesai")
    await tick(1)

    // Ctrl+P, karena "/" di tengah baris memang bukan command — dan itu benar.
    h.stdin.press("\u0010")
    await tick()

    // Turun ke entri /new di palette.
    const items = ["model", "agent", "session", "new"]
    for (let i = 0; i < items.indexOf("new"); i += 1) h.stdin.press("\u001b[B")
    await tick()
    h.stdin.press("\r")
    await tick(6)

    assert.equal(h.recorded.created, 1, "/new terpilih dari palette")

    h.stdin.press("halo")
    await tick(1)
    h.stdin.press("\r")
    await tick()

    assert.deepEqual(
      h.recorded.sent.map((item) => item.text),
      ["halo"],
      "sisa ketikan sesi lama tidak ikut terkirim",
    )
  } finally {
    h.cleanup()
  }
})

/** Pesan dengan satu tool yang SEDANG berjalan. */
function pushRunningTool(h: Harness) {
  h.push({
    type: "message.updated",
    sessionID: session.id,
    message: {
      id: "a-tool",
      sessionID: session.id,
      role: "assistant",
      created: 1,
      parts: [
        {
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "npm run build" },
            title: "bash build",
            started: 1,
          },
        },
      ],
    },
  })
}

test("ctrl+x d memperlihatkan rincian tool yang MASIH berjalan", async () => {
  const h = mount()
  try {
    await tick()
    pushRunningTool(h)
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: { id: "u1", sessionID: session.id, role: "user", created: 1, parts: [] },
    })
    await tick()
    assert.match(h.frame(), /working/, "giliran memang sedang berjalan")

    h.clear()
    h.stdin.press("\u0018")
    await tick(1)
    h.stdin.press("d")
    await tick()

    assert.match(h.frame(), /npm run build/, "argumennya terlihat tanpa menunggu selesai")
  } finally {
    h.cleanup()
  }
})

test("mengklik baris tool membuka rinciannya, dan tidak membatalkan giliran", async () => {
  const h = mount()
  try {
    await tick()
    pushRunningTool(h)
    await tick()

    // Baris riwayat pertama ada tepat di bawah panel atas. Layar uji 100×30
    // memenuhi syarat lambang, jadi tinggi panel = tinggi lambang + 2 bingkai.
    //
    // DIHITUNG, bukan ditulis tetap: mengganti seni lambang menggeser seluruh
    // riwayat satu baris, dan angka tetap di sini akan gagal tanpa memberi tahu
    // apa penyebabnya.
    const barisPertama = markLines().length + 2 + 1
    h.clear()
    h.mouse.emit({ kind: "press", x: 6, y: barisPertama })
    await tick()

    assert.match(h.frame(), /npm run build/, "klik membuka blok yang diklik")
    assert.deepEqual(h.recorded.aborted, [], "klik TIDAK boleh terbaca sebagai Escape")

    // Tanda yang HARUS tetap terlihat -- kalau toggle kedua mengembalikan
    // referensi `Set` yang SAMA (lupa `.delete`), React membatalkan render
    // karena referensinya identik, dan bingkai KOSONG lolos begitu saja dari
    // `doesNotMatch` di bawah tanpa membuktikan blok benar-benar tertutup.
    for (const ch of "zzz") h.stdin.press(ch)
    await tick(1)

    h.clear()
    h.mouse.emit({ kind: "press", x: 6, y: barisPertama })
    await tick()
    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /npm run build/, "klik kedua menutupnya lagi")
  } finally {
    h.cleanup()
  }
})

test("roda mouse menggulir riwayat", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    h.clear()
    h.mouse.emit({ kind: "wheel-up", x: 10, y: 10 })
    await tick()

    assert.match(h.frame(), /lines below/)
  } finally {
    h.cleanup()
  }
})

test("membuka kembali sesi yang giliran terakhirnya SELESAI tidak nyangkut bekerja", async () => {
  // Bug: riwayat diputar ulang lewat message.updated, yang menyimpulkan "sedang
  // bekerja" dari tiap pesan user. Untuk riwayat tersimpan kesimpulan itu salah —
  // `session.idle` yang mengakhiri giliran sudah lewat dan tidak ikut tersimpan.
  const h = mount()
  try {
    await tick()
    for (const ch of "/session") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r") // pilih /session dari daftar command
    await tick()
    h.stdin.press("\u001b[B") // turun ke sesi lama
    await tick()
    h.stdin.press("\r")
    await tick(6)

    assert.match(h.frame(), /isi sesi lama/, "sesi lama benar-benar dimuat")
    assert.doesNotMatch(h.frame(), /esc to cancel/, "tidak boleh terlihat sedang bekerja")

    // Dan yang paling penting: sesi itu masih bisa dipakai.
    h.recorded.sent.length = 0
    for (const ch of "lanjut") h.stdin.press(ch)
    await tick(1)
    h.stdin.press("\r")
    await tick()

    assert.equal(h.recorded.sent.at(-1)?.text, "lanjut", "prompt masih diterima")
  } finally {
    h.cleanup()
  }
})

test("sesi yang server-nya bilang MASIH berjalan tetap terlihat bekerja", async () => {
  const h = mount()
  h.recorded.running = true
  try {
    await tick()
    for (const ch of "/session") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r") // pilih /session dari daftar command
    await tick()
    h.stdin.press("\u001b[B") // turun ke sesi lama
    await tick()
    h.stdin.press("\r")
    await tick(6)

    assert.match(h.frame(), /esc to cancel/, "spinner benar menyala kalau memang berjalan")
  } finally {
    h.cleanup()
  }
})

test("Esc membebaskan layar yang nyangkut bekerja padahal server menganggur", async () => {
  const h = mount()
  h.recorded.running = true
  h.recorded.aborted_result = false
  try {
    await tick()
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: { id: "u1", sessionID: session.id, role: "user", created: 1, parts: [] },
    })
    await tick()
    assert.match(h.frame(), /esc to cancel/)

    h.clear()
    h.stdin.press("\u001b")
    await tick()

    // Buktinya bukan hilangnya spinner — buffer Ink menumpuk, jadi bingkai lama
    // selalu masih ada di sana. Buktinya adalah sesi itu bisa dipakai lagi.
    assert.match(h.frame(), /status reset/, "user diberi tahu apa yang terjadi")

    h.recorded.sent.length = 0
    for (const ch of "halo") h.stdin.press(ch)
    await tick(1)
    h.stdin.press("\r")
    await tick()
    assert.equal(h.recorded.sent.at(-1)?.text, "halo", "prompt bisa dikirim lagi")
  } finally {
    h.cleanup()
  }
})

test("ctrl+x m mematikan pelacakan mouse supaya teks bisa diblok dan disalin", async () => {
  // Keduanya tidak bisa menyala bersamaan: begitu terminal melaporkan klik ke
  // aplikasi, ia berhenti memakai klik itu untuk menyorot teks.
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    h.clear()
    h.stdin.press("\u0018")
    await tick(1)
    h.stdin.press("m")
    await tick()

    assert.deepEqual(h.captureLog, [false], "terminal diberi tahu untuk berhenti melacak")
    assert.match(h.frame(), /mouse off/)

    // Klik tidak lagi membuka blok tool selama pelacakan mati — tapi itu memang
    // konsekuensinya, dan footer menyebutkannya terus-menerus.
    h.stdin.press("\u0018")
    await tick(1)
    h.stdin.press("m")
    await tick()
    assert.deepEqual(h.captureLog, [false, true], "bisa dinyalakan lagi")
  } finally {
    h.cleanup()
  }
})

test("mengirim prompt melompat ke bawah, walau riwayat sedang digulir ke atas", async () => {
  // Tanpa ini, jawaban datang di luar layar dan dari tempat user berada tidak
  // ada tanda apa pun bahwa ia sudah tiba.
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    h.stdin.press("\u001b[5~")
    await tick()
    assert.match(h.frame(), /lines below/, "benar-benar sedang tergulir ke atas")

    for (const ch of "halo") h.stdin.press(ch)
    await tick(1)
    h.clear()
    h.stdin.press("\r")
    await tick()

    assert.doesNotMatch(h.frame(), /lines below/, "kembali menempel di bawah")
  } finally {
    h.cleanup()
  }
})

test("penunjuk gulir menyebut tombol untuk melompat ke bawah", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()

    h.clear()
    h.stdin.press("\u001b[5~")
    await tick()

    // Penunjuk yang cuma bilang "ada di bawah" tanpa memberi tahu cara ke sana
    // membuat orang menekan panah bawah berkali-kali.
    assert.match(h.frame(), /lines below · end to jump/)
  } finally {
    h.cleanup()
  }
})

test("ctrl+x b juga melompat ke bawah", async () => {
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()
    h.stdin.press("\u001b[5~")
    await tick()
    assert.match(h.frame(), /lines below/)

    // Tanda yang HARUS tetap terlihat -- site ini lolos vakum saat ini HANYA
    // karena `setLeaderActive(false)` di app.tsx memaksa render footer yang
    // tidak terkait, bukan karena chord `<leader>b` ini sendiri terbukti
    // menulis ulang apa pun. Kalau refactor nanti memindahkan
    // `setLeaderActive(false)` ke dalam cabang switch atau ke tiap kasusnya
    // satu-satu, site ini bisa diam-diam jadi vakum lagi tanpa satu pun
    // assertion berubah. Tanda ini melepaskannya dari efek-samping yang
    // tidak terkait itu.
    for (const ch of "zzz") h.stdin.press(ch)
    await tick(1)

    // Dibersihkan SETELAH leader: menekan ctrl+x sendiri sudah menulis satu
    // bingkai (footer berubah), dan bingkai itu masih memuat penunjuk gulir.
    h.stdin.press("\u0018")
    await tick(3)
    h.clear()
    h.stdin.press("b")
    await tick()

    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /lines below/)
  } finally {
    h.cleanup()
  }
})

test("tombol End langsung juga melompat ke bawah, tanpa leader", async () => {
  // `messages_last` punya TIGA jalan masuk (lihat keybinds.ts), dan test di atas
  // hanya membuktikan jalan lewat leader (`<leader>b`) -- cabang `scrollAction`
  // yang menangani "end"/"ctrl+alt+g" langsung (tanpa leader) tidak tersentuh
  // satu test pun sebelum ini. Kalau cabang itu tidak pernah setScroll(0), tidak
  // ada efek samping lain yang memaksa render (leader-chord punya
  // `setLeaderActive(false)` yang tidak pernah nol di sini), jadi bingkai KOSONG
  // pun lolos begitu saja dari `doesNotMatch` di bawah tanpa membuktikan apa pun.
  const h = mount()
  try {
    await tick()
    pushLongHistory(h)
    await tick()
    h.stdin.press("[5~") // pageup — gulir ke atas
    await tick()
    assert.match(h.frame(), /lines below/)

    for (const ch of "zzz") h.stdin.press(ch)
    await tick(1)

    h.clear()
    h.stdin.press("[F") // End (Ink: parse-keypress memetakan "[F" ke key.end)
    await tick(8)

    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /lines below/)
  } finally {
    h.cleanup()
  }
})

test("prompt user tampil sebagai blok berlabel di riwayat", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "message.updated",
      sessionID: session.id,
      message: {
        id: "u9",
        sessionID: session.id,
        role: "user",
        created: 1,
        parts: [{ type: "text", text: "/compact" }],
      },
    })
    await tick()

    const frame = h.frame()
    assert.match(frame, /┌─ command/, "perintah diberi label berbeda dari pertanyaan")
    assert.match(frame, /│ \/compact/)
  } finally {
    h.cleanup()
  }
})

// ---------- regresi dari audit terminal sungguhan ----------

test("home dan end diterjemahkan — ada binding yang bergantung padanya", () => {
  // Ink menyediakan key.home dan key.end, tapi toKeyPress tidak memetakannya,
  // jadi `messages_first: "ctrl+g,home"` dan chord `end` di `messages_last`
  // diam-diam mati. Yang paling merugikan: penunjuk gulir berbunyi
  // "end to jump" — menyuruh user menekan tombol yang tidak terhubung ke apa pun.
  const none = {
    escape: false, return: false, backspace: false, delete: false, tab: false,
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageUp: false, pageDown: false, home: false, end: false,
    ctrl: false, shift: false, meta: false,
  } as unknown as Parameters<typeof toKeyPress>[1]

  assert.equal(toKeyPress("", { ...none, home: true }).key, "home")
  assert.equal(toKeyPress("", { ...none, end: true }).key, "end")

  const keymap = buildKeymap()
  assert.equal(
    resolve(keymap, toKeyPress("", { ...none, end: true }), false, ["messages_last"]),
    "messages_last",
    "tombol yang disebut petunjuk di layar HARUS sampai ke aksinya",
  )
  assert.equal(
    resolve(keymap, toKeyPress("", { ...none, home: true }), false, ["messages_first"]),
    "messages_first",
  )
})

test("layar pembuka menampilkan keadaan leader — tanpa itu ctrl+x terlihat rusak", async () => {
  // Splash tidak merender Footer, satu-satunya tempat indikator leader dan pesan
  // flash muncul. Akibatnya ctrl+x di layar pembuka TIDAK MEMBERI UMPAN BALIK
  // APA PUN: tombolnya bekerja, tapi dari tempat user tidak ada bedanya dengan
  // keybinding yang mati.
  const h = mount()
  try {
    await tick()
    h.clear()
    h.stdin.press("\u0018") // ctrl+x
    await tick()

    assert.match(h.frame(), /ctrl\+x/, "leader harus terlihat sebelum ada percakapan")
  } finally {
    h.cleanup()
  }
})

test("layar pembuka menampilkan pesan flash, mis. status mode mouse", async () => {
  const h = mount()
  try {
    await tick()
    h.stdin.press("\u0018")
    await tick(1)
    h.clear()
    h.stdin.press("m")
    await tick()

    assert.match(h.frame(), /mouse off/, "toggle berjalan; statusnya harus terlihat juga")
  } finally {
    h.cleanup()
  }
})

test("command yang dijalankan dari popup tetap masuk histori prompt", async () => {
  // Mengetik "/" SELALU membuka popup, dan memilih dari popup memanggil send()
  // langsung — melewati submit(), satu-satunya tempat pushHistory dipanggil.
  // Akibatnya tidak ada satu pun slash command yang pernah masuk histori.
  const h = mount()
  try {
    await tick()
    for (const ch of "/agents") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r") // pilih /agents dari popup
    await tick(6)
    assert.equal(h.recorded.sent.at(-1)?.text, "/agents", "command benar-benar terkirim")

    h.clear()
    h.stdin.press("\u001b[A") // panah atas
    await tick()

    assert.match(h.frame(), /\/agents/, "panah atas harus memanggilnya kembali")
  } finally {
    h.cleanup()
  }
})

test("ctrl+x lalu panah bawah membuka panel sub-agent", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    await tick()

    h.clear()
    h.stdin.press("") // ctrl+x
    await tick(1)
    h.stdin.press("[B") // panah bawah
    await tick()

    assert.match(h.frame(), /sub-agents/)
    assert.match(h.frame(), /explore/)
  } finally {
    h.cleanup()
  }
})

test("x di panel membatalkan satu sub-agent lewat klien", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    await tick()
    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B")
    await tick()

    // `x` PERTAMA hanya mempersenjatai konfirmasi — menghentikan sub-agent
    // tidak bisa dibatalkan, jadi satu tekanan tidak pernah cukup.
    h.stdin.press("x")
    await tick()
    assert.deepEqual(h.recorded.aborted, [], "tekanan pertama belum boleh membatalkan apa pun")
    assert.match(h.frame(), /press x again to cancel explore/)

    h.stdin.press("x")
    await tick()

    assert.deepEqual(h.recorded.aborted, ["anak"], "yang dibatalkan sesi ANAK, bukan induk")
  } finally {
    h.cleanup()
  }
})

test("mengetik saat panel terbuka TIDAK membatalkan sub-agent dan tidak menyunting draft", async () => {
  // Temuan review akhir, ditemukan lewat pty: panel bukan modal, jadi huruf
  // "x" di tengah kata yang sedang diketik jatuh ke cabang pembatalan dan
  // membunuh sub-agent terpilih tanpa konfirmasi — sementara "fi"-nya masuk
  // draft dan "x"-nya hilang. Panel sekarang memiliki papan ketik selama
  // terbuka: tidak satu pun dari ketiga huruf ini boleh punya efek.
  const h = mount()
  try {
    await tick()
    for (const id of ["a", "b"]) {
      h.push({
        type: "subagent.updated",
        sessionID: session.id,
        child: { sessionID: id, agent: `agent-${id}`, status: "running", startedAt: Date.now(), note: "n" },
      })
    }
    await tick()

    h.stdin.press("\u0018")
    await tick(1)
    h.stdin.press("\u001b[B") // buka panel
    await tick()
    assert.match(h.frame(), /sub-agents/, "panel harus terbuka dulu")

    h.clear()
    // Satu tick di antara tiap huruf: tanpa itu ketiganya menyatu jadi SATU
    // chunk yang dibaca Ink sebagai tempelan, dan yang diuji bukan lagi
    // mengetik melainkan menempel.
    for (const ch of "fix") {
      h.stdin.press(ch)
      await tick(1)
    }
    await tick()

    // Ketikan yang ditelan panel tidak menghasilkan render sama sekali, jadi
    // bingkai kosong di sini BUKAN bukti apa pun — satu event dipakai untuk
    // memaksa render baru, supaya `doesNotMatch` di bawahnya menguji layar
    // sungguhan, bukan buffer yang kebetulan masih kosong.
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "a", agent: "agent-a", status: "running", startedAt: Date.now(), note: "still alive" },
    })
    await tick()

    assert.deepEqual(h.recorded.aborted, [], "mengetik tidak boleh membatalkan sub-agent apa pun")
    assert.match(h.frame(), /still alive/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /fi(?!x again)/, "huruf yang ditelan panel tidak boleh muncul di draft")
    // Huruf "x" di ujung kata pun tidak membunuh apa pun: ia hanya
    // mempersenjatai konfirmasi, dan mengumumkannya.
    assert.match(h.frame(), /press x again to cancel/)

    // Dan papan ketik kembali ke penyunting begitu panel ditutup — modal
    // berarti sementara, bukan permanen.
    h.stdin.press("\u001b") // esc
    await tick()
    h.clear()
    for (const ch of "fix") {
      h.stdin.press(ch)
      await tick(1)
    }
    await tick()
    assert.match(h.frame(), /fix/, "setelah panel tertutup, ketikan harus masuk draft lagi")
    assert.deepEqual(h.recorded.aborted, [], "dan tetap tidak membatalkan apa pun")
  } finally {
    h.cleanup()
  }
})

// ---------- regresi review round 1: ctrl+x saat panel terbuka ----------

test("ctrl+x saat panel terbuka mempersenjatai leader, BUKAN membatalkan sub-agent", async () => {
  // Kritis dari review: toKeyPress mengembalikan { key: "x", ctrl: true } untuk
  // ctrl+x — bentuk yang SAMA dengan tombol "x" polos yang membatalkan baris
  // terpilih. Tanpa penjaga modifier, ctrl+x saat panel terbuka salah dibaca
  // sebagai pembatalan, dan leader (ctrl+x q/d/m/?) jadi mati total selama
  // panel terbuka.
  const h = mount()
  try {
    await tick()
    // DUA sub-agent, bukan satu: dengan satu baris saja, mutasi yang salah
    // (panah bawah dibaca sebagai navigasi, bukan penutup) memindahkan
    // seleksi 0 -> 0 lewat modulo 1 -- TIDAK ADA render sama sekali, dan
    // bingkai KOSONG lolos begitu saja dari `doesNotMatch` di bawah tanpa
    // membuktikan apa pun. Dengan dua baris, 0 -> 1 itu perubahan NYATA.
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak2", agent: "qc", status: "running", startedAt: Date.now(), note: "reviewing" },
    })
    await tick()

    // Tanda yang HARUS tetap terlihat sepanjang test -- pembuktian bahwa
    // bingkai yang diperiksa nanti benar-benar hasil render baru, bukan
    // buffer kosong yang lolos begitu saja dari `doesNotMatch`.
    for (const ch of "zzz") h.stdin.press(ch)
    await tick(1)

    h.stdin.press("") // ctrl+x
    await tick(1)
    h.stdin.press("[B") // panah bawah — buka panel
    await tick()
    assert.match(h.frame(), /sub-agents/, "panel harus terbuka dulu")

    h.clear()
    h.stdin.press("") // ctrl+x LAGI, panel masih terbuka
    await tick()
    assert.match(h.frame(), /ctrl\+x/, "harus mempersenjatai leader, BUKAN dibaca sebagai 'x' pembatal")
    assert.deepEqual(h.recorded.aborted, [], "ctrl+x sendirian tidak boleh membatalkan apa pun")

    h.clear()
    h.stdin.press("[B") // panah bawah menyelesaikan chord leader yang sama — menutup panel
    await tick()
    // Dibuktikan LEBIH DULU bahwa bingkai ini nyata (bukan buffer kosong)
    // sebelum bergantung pada `doesNotMatch` di bawahnya -- kalau tidak,
    // sebuah handler yang seluruhnya rusak dan tidak pernah me-render ulang
    // akan lolos identik dengan handler yang benar.
    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(
      h.frame(),
      /sub-agents/,
      "chord leader (ctrl+x lalu panah bawah) harus MENUTUP panel, bukan menavigasi baris di dalamnya",
    )
    assert.deepEqual(h.recorded.aborted, [], "menutup panel tidak boleh membatalkan apa pun")
  } finally {
    h.cleanup()
  }
})

test("panah atas dan bawah di panel berputar di kedua ujung, tidak berhenti di sana", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "a", agent: "explore", status: "running", startedAt: Date.now(), note: "x" },
    })
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "b", agent: "qc", status: "running", startedAt: Date.now(), note: "y" },
    })
    await tick()

    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B") // buka panel — baris terpilih default indeks 0 ("a")
    await tick()

    // Dari baris PERTAMA, panah ATAS harus berputar ke baris TERAKHIR.
    // `x` ditekan DUA KALI: yang pertama mempersenjatai konfirmasi.
    h.stdin.press("[A")
    await tick()
    h.stdin.press("x")
    await tick()
    h.stdin.press("x")
    await tick()
    assert.deepEqual(h.recorded.aborted, ["b"], "panah atas dari baris pertama harus berputar ke baris terakhir")

    // Dan dari baris TERAKHIR (masih terpilih — membatalkan tidak memindah
    // seleksi), panah BAWAH harus berputar balik ke baris PERTAMA.
    h.stdin.press("[B")
    await tick()
    h.stdin.press("x")
    await tick()
    h.stdin.press("x")
    await tick()
    assert.deepEqual(
      h.recorded.aborted,
      ["b", "a"],
      "panah bawah dari baris terakhir harus berputar balik ke baris pertama",
    )
  } finally {
    h.cleanup()
  }
})

test("esc menutup panel sub-agent tanpa membatalkan apa pun", async () => {
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "explore", status: "running", startedAt: Date.now(), note: "reading" },
    })
    await tick()

    // Tanda yang HARUS tetap terlihat -- tanpa ini, kalau penangan esc
    // suatu saat rusak total (tidak pernah menutup, tidak pernah me-render
    // ulang apa pun), bingkai KOSONG tetap lolos dari `doesNotMatch` di
    // bawah, persis seperti temuan review untuk test ctrl+x di atasnya.
    for (const ch of "zzz") h.stdin.press(ch)
    await tick(1)

    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B")
    await tick()
    assert.match(h.frame(), /sub-agents/)

    h.clear()
    h.stdin.press("") // esc polos
    await tick()

    assert.match(h.frame(), /zzz/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /sub-agents/, "panel harus tertutup")
    assert.deepEqual(h.recorded.aborted, [], "esc tidak membatalkan apa pun")
  } finally {
    h.cleanup()
  }
})

test("panel tanpa sub-agent menampilkan pesan kosong, bukan kotak hampa", async () => {
  const h = mount()
  try {
    await tick()
    h.clear()
    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B")
    await tick()

    assert.match(h.frame(), /no sub-agents running/)
  } finally {
    h.cleanup()
  }
})

test("panel menjendela baris — baris yang terdorong keluar jendela benar-benar tidak tampil", async () => {
  // Important 2 dari review: cek lama cuma memeriksa /agent11/ ADA, yang
  // BENAR baik ketika windowing bekerja MAUPUN saat windowing dihapus
  // seluruhnya (tanpa windowing, kedua belas baris tampil, termasuk
  // agent11). Cek ini harus GAGAL kalau windowing hilang -- jadi ia juga
  // membuktikan baris paling ATAS (agent0) sudah terdorong keluar jendela.
  const h = mount()
  try {
    await tick()
    for (let i = 0; i < 12; i += 1) {
      h.push({
        type: "subagent.updated",
        sessionID: session.id,
        child: { sessionID: `s${i}`, agent: `agent${i}`, status: "running", startedAt: Date.now(), note: "n" },
      })
    }
    await tick()

    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B") // buka panel, baris terpilih indeks 0
    await tick()

    // Sepuluh langkah pertama tidak diperiksa -- bingkainya masih menumpuk
    // riwayat SEBELUM baris terakhir terpilih, termasuk saat agent0 MEMANG
    // masih terlihat. Bingkai yang diperiksa nanti harus hasil dari LANGKAH
    // TERAKHIR saja, bukan gabungan seluruh riwayat penekanan.
    for (let i = 0; i < 10; i += 1) {
      h.stdin.press("[B")
      await tick(1)
    }

    h.clear()
    h.stdin.press("[B") // langkah TERAKHIR ke baris terakhir (indeks 11 dari 12)
    await tick()

    assert.match(h.frame(), /agent11/, "baris terpilih harus terlihat, bukan terdorong keluar jendela")
    assert.doesNotMatch(
      h.frame(),
      /agent0\b/,
      "baris PALING ATAS harus sudah terdorong keluar jendela -- tanpa windowing, ia masih tampil di sini",
    )
  } finally {
    h.cleanup()
  }
})

test("berganti sesi menutup panel dan menjepit seleksi yang basi terhadap sesi baru", async () => {
  // Important 3 dari review: reducer mengosongkan `subagents` pada
  // session.switch, tapi `subagentPanelOpen`/`subagentSelected` hidup di
  // state App, bukan reducer — tanpa reset eksplisit, baris terpilih dari
  // sesi LAMA (indeks 2 dari 3 baris) tetap tersimpan sementara sesi BARU
  // cuma punya satu sub-agent, dan `x` akan membaca di luar array.
  const h = mount()
  try {
    await tick()
    for (const id of ["a", "b", "c"]) {
      h.push({
        type: "subagent.updated",
        sessionID: session.id,
        child: { sessionID: id, agent: `agent-${id}`, status: "running", startedAt: Date.now(), note: "n" },
      })
    }
    await tick()

    h.stdin.press("")
    await tick(1)
    h.stdin.press("[B") // buka panel — indeks 0
    await tick()
    h.stdin.press("[B") // indeks 1
    await tick()
    h.stdin.press("[B") // indeks 2 — baris TERAKHIR dari sesi lama
    await tick()

    // Panel sekarang MODAL: selama terbuka ia memiliki papan ketik, jadi
    // "/new" tidak akan pernah sampai ke penyunting sebelum panelnya ditutup.
    // Itu tidak menghapus skenario yang diuji di sini — `subagentSelected`
    // sengaja BERTAHAN lewat tutup/buka, jadi indeks basi (2) tetap terbawa
    // ke sesi baru yang cuma punya satu baris.
    h.clear()
    h.stdin.press("")
    await tick()
    assert.match(h.frame(), /enter to send/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /sub-agents/, "esc harus menutup panel dulu")

    for (const ch of "/new") h.stdin.press(ch)
    await tick()
    h.stdin.press("\r")
    await tick(6)

    // Sesi baru cuma melahirkan SATU sub-agent — indeks basi (2) sudah di luar array ini.
    h.push({
      type: "subagent.updated",
      sessionID: "ses_baru_1",
      child: { sessionID: "d", agent: "agent-d", status: "running", startedAt: Date.now(), note: "n" },
    })
    await tick()

    // Buffer Ink menumpuk bingkai lama — bingkai dari SEBELUM perpindahan
    // masih menyebut "sub-agents", jadi buffer dibuang lebih dulu; ctrl+x
    // dipakai SEKALIGUS untuk memaksa satu render baru (frame() butuh sesuatu
    // ditulis lagi setelah `clear`) dan untuk memulai membuka kembali panelnya.
    h.clear()
    h.stdin.press("")
    await tick()
    // Dibuktikan LEBIH DULU bahwa bingkai ini nyata (leader benar-benar
    // bersenjata) sebelum bergantung pada `doesNotMatch` -- render yang
    // tidak pernah terjadi sama sekali akan lolos identik dari cek
    // "tidak ada sub-agents" ini.
    assert.match(h.frame(), /ctrl\+x/, "bingkai ini harus benar-benar hasil render baru")
    assert.doesNotMatch(h.frame(), /sub-agents/, "panel harus tetap tertutup setelah pindah sesi")

    h.stdin.press("[B") // buka lagi, setelah berganti sesi
    await tick()

    assert.match(h.frame(), /›/, "marker seleksi harus ada di satu baris, tidak menghilang karena indeks basi")

    h.stdin.press("x")
    await tick()
    h.stdin.press("x")
    await tick()
    assert.deepEqual(
      h.recorded.aborted,
      ["d"],
      "yang dibatalkan sub-agent sesi BARU — indeks basi tidak boleh membaca di luar array",
    )
  } finally {
    h.cleanup()
  }
})

// ---------- followup-1: pesan sekejap tersembunyi selama turn berjalan ----------

/** Menyetel status ke "working", cara yang sama dipakai test Esc di atas. */
function pushWorking(h: Harness): void {
  h.push({
    type: "message.updated",
    sessionID: session.id,
    message: { id: "u_working", sessionID: session.id, role: "user", created: 1, parts: [] },
  })
}

test("flash panel tetap terlihat walau turn sedang bekerja — defect 1 followup-1", async () => {
  // Precedence lama: status === "working" menang di atas segalanya, jadi
  // `hint` (flash aktif) tidak pernah dirender selama status bekerja. Ini
  // persis kondisi panel sub-agent: dibuka justru SAAT turn berjalan. Tanpa
  // perbaikan, tombol yang ditelan panel (mis. huruf biasa) tidak
  // menghasilkan umpan balik APA PUN — comment app.tsx:683-686 mengklaim
  // ini dicegah, padahal tidak, selama status bekerja.
  const h = mount()
  try {
    await tick()
    pushWorking(h)
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "reviewer", status: "running", startedAt: Date.now(), note: "n" },
    })
    await tick()

    h.stdin.press("") // ctrl+x
    await tick(1)
    h.stdin.press("[B") // panah bawah — buka panel
    await tick()
    assert.match(h.frame(), /sub-agents/, "panel harus terbuka dulu")

    h.clear()
    h.stdin.press("z") // tombol yang tidak dikenal panel — memicu flash penuntun
    await tick()

    assert.match(
      h.frame(),
      /sub-agent panel has the keyboard/,
      "flash panel harus terlihat walau status sedang bekerja",
    )
    // Marker kerja harus tetap ada — bukan hilang begitu flash menang, hanya
    // berubah bentuk jadi penanda singkat di depan flash.
    assert.match(h.frame(), /●\s*sub-agent panel has the keyboard/, "marker '● ' harus mendahului flash")
    assert.doesNotMatch(
      h.frame(),
      /● working — esc to cancel/,
      "frasa panjang 'working' harus digantikan flash, bukan tampil berdampingan",
    )
  } finally {
    h.cleanup()
  }
})

test("leader ctrl+x tetap terlihat walau turn sedang bekerja — defect 1 followup-1", async () => {
  // Konsekuensi kedua dari precedence lama: `leaderActive` juga kalah dari
  // status bekerja, jadi menekan ctrl+x SELAMA turn berjalan (justru saat
  // `ctrl+x d` paling berguna) tidak memberi konfirmasi bahwa leader
  // bersenjata — user mengira keybinding-nya mati.
  const h = mount()
  try {
    await tick()
    pushWorking(h)
    await tick()

    h.clear()
    h.stdin.press("") // ctrl+x
    await tick()

    assert.match(h.frame(), /ctrl\+x/, "leader harus terlihat walau status sedang bekerja")
    assert.match(h.frame(), /●\s*ctrl\+x/, "marker '● ' harus mendahului indikator leader")
  } finally {
    h.cleanup()
  }
})

test("dialog izin di tengah konfirmasi x melucutinya — defect 3 followup-1", async () => {
  // Sebelum diperbaiki: cabang panel (app.tsx:606) dilewati SELURUHNYA
  // selama `state.permission` terisi, dan tidak ada yang melucuti
  // `cancelArmed`. Urutan followup-1: persenjatai `x` pada satu baris,
  // sebuah sub-agent memunculkan dialog bash, dijawab, lalu `x` TUNGGAL
  // berikutnya membatalkan langsung — padahal aturan panel bilang "tombol
  // lain apa pun melucuti", dan menjawab dialog jelas termasuk itu.
  const h = mount()
  try {
    await tick()
    h.push({
      type: "subagent.updated",
      sessionID: session.id,
      child: { sessionID: "anak", agent: "reviewer", status: "running", startedAt: Date.now(), note: "n" },
    })
    await tick()

    h.stdin.press("") // ctrl+x
    await tick(1)
    h.stdin.press("[B") // panah bawah — buka panel
    await tick()
    assert.match(h.frame(), /sub-agents/, "panel harus terbuka dulu")

    h.stdin.press("x") // persenjatai konfirmasi pada baris "reviewer"
    await tick()
    assert.match(h.frame(), /press x again to cancel reviewer/)

    // Sub-agent memicu dialog izin (mis. bash) DI TENGAH konfirmasi.
    h.push({
      type: "permission.request",
      sessionID: session.id,
      request: {
        id: "perm_mid",
        sessionID: session.id,
        kind: "bash",
        title: "bash: rm -rf tmp",
        detail: "rm -rf tmp",
        pattern: "rm *",
        created: 1,
      },
    })
    await tick()
    assert.match(h.frame(), /Permission requested \(bash\)/, "dialog harus muncul")

    h.stdin.press("y") // jawab: allow once
    await tick()
    assert.deepEqual(h.recorded.permissions, [{ id: "perm_mid", decision: "once" }])

    // Dialog selesai di sisi server — disiarkan balik supaya klien tahu
    // sudah terjawab, sama seperti aliran sungguhan.
    h.push({ type: "permission.resolved", sessionID: session.id, permissionID: "perm_mid", granted: true })
    await tick()

    // `x` TUNGGAL berikutnya HARUS mempersenjatai lagi, bukan langsung
    // membatalkan — menjawab dialog termasuk "tombol lain" yang melucuti.
    h.stdin.press("x")
    await tick()

    assert.deepEqual(
      h.recorded.aborted,
      [],
      "x tunggal setelah dialog TIDAK BOLEH langsung membatalkan",
    )
    assert.match(
      h.frame(),
      /press x again to cancel reviewer/,
      "harus kembali mempersenjatai dari awal, bukan mengeksekusi pembatalan lama",
    )
  } finally {
    h.cleanup()
  }
})
