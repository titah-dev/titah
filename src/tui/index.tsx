import { PassThrough } from "node:stream"
import { render } from "ink"
import { App } from "./app.tsx"
import { Client } from "./client.ts"
import { listen } from "../server/index.ts"
import type { Config } from "../core/schema.ts"
import { createMouseFilter, createMouseSource, MOUSE_OFF, MOUSE_ON } from "./mouse.ts"

export interface StartOptions {
  version: string
  cwd: string
  model: string
  /** Attach ke server yang sudah jalan. Kalau kosong, server lokal di-spawn. */
  attach?: string
  sessionID?: string
  keybinds?: Record<string, string>
  agents?: string[]
  defaultAgent?: string
  config: Config
}

/**
 * `titah` tanpa argumen menjalankan server lokal di port acak lalu attach TUI ke
 * situ (Q5). Dari sisi user terasa seperti satu proses; secara arsitektur ia
 * sudah client/server sejak awal, jadi `attach` ke server jauh gratis.
 */
/**
 * Alternate screen buffer, seperti nvim/opencode: TUI mengambil alih layar penuh
 * lalu MENGEMBALIKANNYA utuh saat keluar — scrollback terminal di atasnya tidak
 * ikut terlihat, dan tidak tertimpa.
 *
 * Pemulihan dipasang di banyak jalur keluar. Terminal yang ditinggalkan dalam
 * alt-screen tanpa kursor adalah kerusakan yang harus diperbaiki user dengan
 * `reset`, dan itu tidak boleh terjadi hanya karena Titah crash.
 */
function enterFullScreen(): () => void {
  const write = (sequence: string) => {
    if (process.stdout.isTTY) process.stdout.write(sequence)
  }

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    write(MOUSE_OFF)
    write("\u001b[?25h") // tampilkan kursor
    write("\u001b[?1049l") // kembali ke layar utama
  }

  write("\u001b[?1049h")
  write("\u001b[2J\u001b[H")
  write(MOUSE_ON)

  process.once("exit", restore)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      restore()
      process.exit(signal === "SIGINT" ? 130 : 143)
    })
  }
  process.once("uncaughtException", (error) => {
    restore()
    process.stderr.write(`titah: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  })

  return restore
}


/**
 * stdin yang sudah bersih dari urutan mouse, plus sumber event mouse-nya.
 *
 * Ink TIDAK boleh melihat byte mouse. Ia mengurai stdin sebagai tombol, dan
 * urutan mouse diawali ESC — yang di Titah terikat ke pembatalan giliran. Jadi
 * penyaringan terjadi SEBELUM stream diberikan ke Ink, bukan sesudahnya.
 */
function splitMouse(source: NodeJS.ReadStream) {
  const noop = () => {}
  if (!source.isTTY) return { stdin: source, mouse: undefined, dispose: noop }

  const mouse = createMouseSource()
  const filter = createMouseFilter()
  const pipe = new PassThrough()
  const keys = pipe as unknown as NodeJS.ReadStream

  // Ink memeriksa semua ini sebelum mau membaca apa pun; PassThrough polos
  // tidak punya satu pun, dan tanpa itu tidak ada tombol yang pernah sampai.
  keys.isTTY = true
  keys.setRawMode = (mode: boolean) => {
    source.setRawMode(mode)
    return keys
  }
  keys.ref = () => keys
  keys.unref = () => keys

  const onData = (chunk: Buffer | string) => {
    const { events, text } = filter(chunk.toString("utf8"))
    for (const event of events) mouse.emit(event)
    if (text !== "") pipe.write(text)
  }
  source.on("data", onData)

  // Listener `data` membuat stdin mengalir, dan stdin yang mengalir menahan
  // event loop tetap hidup — tanpa pelepasan ini, `titah` tidak pernah keluar.
  const dispose = () => {
    source.off("data", onData)
    source.pause()
    pipe.end()
  }

  // Pelacakan bisa dimatikan saat berjalan supaya seleksi teks terminal hidup
  // lagi. Ditulis langsung ke stdout, bukan lewat Ink: ini mode terminal, bukan
  // isi layar, jadi ia tidak pernah bertabrakan dengan bingkai yang dirender.
  const setCapture = (enabled: boolean) => {
    if (process.stdout.isTTY) process.stdout.write(enabled ? MOUSE_ON : MOUSE_OFF)
  }

  return { stdin: keys, mouse: { ...mouse, setCapture }, dispose }
}

export async function start(options: StartOptions): Promise<void> {
  let close: (() => Promise<void>) | undefined
  let baseURL = options.attach

  if (!baseURL) {
    const handle = await listen(options.version, 0, "127.0.0.1")
    baseURL = handle.url
    close = handle.close
  }

  const client = new Client(baseURL)
  await client.health()

  const session = options.sessionID
    ? { id: options.sessionID, title: "", directory: options.cwd, created: 0, updated: 0 }
    : await client.createSession(options.cwd)

  const restoreScreen = enterFullScreen()
  const input = splitMouse(process.stdin)
  const instance = render(
    <App
      client={client}
      session={session}
      cwd={options.cwd}
      model={options.model}
      config={options.config}
      {...(options.agents ? { agents: options.agents } : {})}
      {...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {})}
      {...(options.keybinds ? { keybindOverrides: options.keybinds } : {})}
      {...(input.mouse ? { mouse: input.mouse } : {})}
    />,
    { stdin: input.stdin, exitOnCtrlC: false },
  )

  try {
    await instance.waitUntilExit()
  } finally {
    input.dispose()
    restoreScreen()

    // Dibuang SEBELUM server ditutup — sesudahnya tidak ada yang menjawab.
    // Sesi yang tidak pernah dipakai tidak boleh menumpuk di daftar `/session`;
    // sesi yang ada isinya tidak akan tersentuh, server yang memastikan itu.
    await client.discard(session.id).catch(() => undefined)
    await close?.()
  }
}
