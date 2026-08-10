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
    assert.doesNotMatch(h.frame().split("\n").at(-6) ?? "", /halo/, "editor harus kosong lagi")
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
    assert.doesNotMatch(h.frame().split("\n").at(-5) ?? "", /zzz/)
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
    h.stdin.press("@")
    await tick()
    assert.match(h.frame(), /Agents & files/)

    h.clear()
    h.stdin.press("\u001b")
    await tick()
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

    h.clear()
    h.mouse.emit({ kind: "press", x: 6, y: barisPertama })
    await tick()
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

    // Dibersihkan SETELAH leader: menekan ctrl+x sendiri sudah menulis satu
    // bingkai (footer berubah), dan bingkai itu masih memuat penunjuk gulir.
    h.stdin.press("\u0018")
    await tick(1)
    h.clear()
    h.stdin.press("b")
    await tick()

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

    h.stdin.press("x")
    await tick()

    assert.deepEqual(h.recorded.aborted, ["anak"], "yang dibatalkan sesi ANAK, bukan induk")
  } finally {
    h.cleanup()
  }
})
