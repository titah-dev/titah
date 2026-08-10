import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import type { Key } from "ink"
import type { Client } from "./client.ts"
import { buildKeymap, describeKey, resolve, type Keymap, type KeyPress } from "./keybinds.ts"
import { initialState, promptHistory, reduce, totalUsage, type TuiState } from "./state.ts"
import {
  browseHistory,
  DRAFT,
  moveCursorLine,
  onFirstLine,
  onLastLine,
  pushHistory,
} from "./editing.ts"
import {
  Editor,
  Footer,
  History,
  InfoPanel,
  PermissionDialog,
  Popup,
  Splash,
  Working,
} from "./components.tsx"
import {
  agentPickerItems,
  applySuggestion,
  sessionSuggestions,
  detectTrigger,
  modelSuggestions,
  skillSuggestions,
  suggest,
  type Suggestion,
} from "./complete.ts"
import { IMMEDIATE_COMMANDS, listCommands } from "../core/command.ts"
import type { Config } from "../core/schema.ts"
import { allLines, editorRows, historyRows, viewport, type Expansion, type Line } from "./layout.ts"
import type { MouseSource } from "./mouse.ts"
import { shouldShowLogo, shouldShowMark, markLines } from "./logo.ts"
import type { Session } from "../core/message.ts"

const LEADER_TIMEOUT = 2000

/** Satu klik roda menggulir tiga baris — sama seperti kebanyakan pager. */
const WHEEL_LINES = 3

/** Aksi yang mengubah isi prompt — dan karenanya mengakhiri telusur histori. */
const MUTATES_DRAFT = new Set(["input_newline", "input_backspace", "input_delete_to_line_start"])

/** Menerjemahkan event tombol Ink ke bentuk netral yang dipahami keybinds.ts. */
export function toKeyPress(input: string, key: Key): KeyPress {
  const named: [boolean, string][] = [
    [key.escape, "escape"],
    [key.return, "return"],
    [key.backspace, "backspace"],
    [key.delete, "delete"],
    [key.tab, "tab"],
    [key.upArrow, "up"],
    [key.downArrow, "down"],
    [key.leftArrow, "left"],
    [key.rightArrow, "right"],
    [key.pageUp, "pageup"],
    [key.pageDown, "pagedown"],
    // Wajib ada: `messages_first` terikat ke `home` dan `messages_last` ke `end`,
    // dan penunjuk gulir di layar menyebut "end to jump". Tanpa pemetaan ini
    // petunjuk itu menyuruh user menekan tombol yang tidak terhubung ke apa pun.
    [key.home, "home"],
    [key.end, "end"],
  ]
  const match = named.find(([flag]) => flag)
  return {
    key: match ? match[1] : input,
    ctrl: key.ctrl,
    alt: key.meta,
    shift: key.shift,
  }
}

/**
 * Membuang karakter kontrol dari input, kecuali newline. CR menjadi newline.
 *
 * Ink mengirim tempelan multi-karakter sebagai SATU event dengan
 * `key.return = false`. Tanpa penyaringan ini, CR/tab/escape di dalam teks yang
 * ditempel masuk mentah ke prompt dan ikut terkirim ke model.
 */
export function sanitizePaste(input: string): string {
  const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g")
  return input.replace(/\r\n?/g, "\n").replace(CONTROL, "")
}

export interface AppProps {
  client: Client
  session: Session
  cwd: string
  model: string
  /** Nama agent internal dari config. Tab berputar di antaranya. */
  agents?: string[]
  defaultAgent?: string
  keybindOverrides?: Record<string, string>
  /** Dipakai autocomplete: daftar agent, command, skill, dan model. */
  config: Config
  /** Klik dan roda mouse. Kosong berarti terminal tanpa dukungan mouse. */
  mouse?: MouseSource
}

export function App({
  client,
  session: initialSession,
  cwd,
  model: initialModel,
  agents,
  defaultAgent,
  keybindOverrides,
  config,
  mouse,
}: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [session, setSession] = useState(initialSession)
  const [state, dispatch] = useReducer(reduce, { ...initialState, session: initialSession })
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [leaderActive, setLeaderActive] = useState(false)
  // Dua lapis: `expandAll` dari ctrl+x d, dan himpunan tool yang dibuka satu per
  // satu lewat klik. Dipisah supaya menutup "semua" tidak ikut menutup blok yang
  // sengaja dibuka user, dan sebaliknya.
  // Pelacakan mouse bisa dimatikan supaya terminal boleh menyorot teks lagi.
  const [mouseCapture, setMouseCapture] = useState(true)
  const [expandAll, setExpandAll] = useState(false)
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set())
  const expandTools: Expansion = expandAll ? true : openTools
  const [scroll, setScroll] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [model, setModel] = useState(initialModel)

  // Histori prompt. `historyIndex` DRAFT berarti user sedang mengetik teks baru;
  // `stash` menyimpannya supaya panah bawah bisa mengembalikannya utuh.
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(DRAFT)
  const stash = useRef("")

  // Popup pilihan: autocomplete `@`/`/`, pemilih model, pemilih skill.
  const [popup, setPopup] = useState<
    {
        title: string
        items: Suggestion[]
        selected: number
        /** Dibuka oleh perintah, bukan oleh detektor `@`/`/`. */
        fromMenu: boolean
      }
    | undefined
  >(undefined)

  // Spinner + waktu berjalan, keduanya di dekat prompt (bukan hanya di footer).
  const [tick, setTick] = useState(0)
  const [startedAt, setStartedAt] = useState(0)

  // Daftar agent selalu diawali entri kosong = tanpa agent, supaya Tab bisa
  // kembali ke perilaku default tanpa harus tahu nama agent mana pun.
  const agentRing = useRef<(string | undefined)[]>([undefined, ...(agents ?? [])]).current
  const [agentIndex, setAgentIndex] = useState(() => {
    const start = agentRing.indexOf(defaultAgent)
    return start === -1 ? 0 : start
  })
  const activeAgent = agentRing[agentIndex]

  // Ukuran layar disimpan di state supaya resize terminal ikut merender ulang;
  // membaca stdout.rows saat render saja tidak memicu apa pun.
  //
  // `||`, BUKAN `??`: sebagian pty melaporkan 0×0 (pty tanpa ukuran jendela,
  // beberapa runner CI). Nol lolos dari `??` lalu menghasilkan `height={0}` —
  // layar kosong total tanpa satu pun pesan error.
  const [size, setSize] = useState({
    columns: Math.max(20, stdout?.columns || 80),
    rows: Math.max(8, stdout?.rows || 24),
  })
  useEffect(() => {
    if (!stdout) return
    const onResize = () =>
      setSize({
        columns: Math.max(20, stdout.columns || 80),
        rows: Math.max(8, stdout.rows || 24),
      })
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])

  const keymap = useRef<Keymap>(buildKeymap(keybindOverrides)).current
  // Petunjuk di layar dibaca DARI keymap, bukan ditulis tetap: user boleh
  // mengubah keybind lewat config, dan petunjuk yang menyebut tombol salah
  // lebih menyesatkan daripada tidak ada petunjuk.
  const jumpKey = describeKey(keymap, "messages_last")
  const view = useRef<{ top: number; lines: Line[]; total: number }>({
    top: 0,
    lines: [],
    total: 0,
  })
  const leaderTimer = useRef<NodeJS.Timeout | undefined>(undefined)

  // Satu langganan SSE untuk seluruh umur aplikasi.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of client.events(session.id, controller.signal)) {
          dispatch(event)
        }
      } catch {
        // abort saat keluar — bukan error yang perlu ditampilkan
      }
    })()
    void (async () => {
      const messages = await client.messages(session.id)

      // Status ditanyakan ke server, tidak disimpulkan dari riwayat. Riwayat
      // hanya bercerita soal masa lalu; hanya server yang tahu apakah ADA yang
      // sedang berjalan sekarang. Gagal bertanya dianggap tidak berjalan —
      // sesi yang menolak menerima prompt jauh lebih merugikan daripada spinner
      // yang seharusnya menyala tapi tidak.
      const running = await client
        .status(session.id)
        .then((state) => state.running)
        .catch(() => false)

      dispatch({ type: "messages.loaded", messages, running })
      // Disemai di sini, bukan dari state.messages: efek yang ikut berubah tiap
      // pesan masuk akan menyemai ulang dan menggandakan prompt yang barusan
      // dikirim, karena server memantulkannya kembali sebagai message.updated.
      setHistory(promptHistory(messages))
      setHistoryIndex(DRAFT)
    })()
    return () => controller.abort()
  }, [client, session.id])

  useEffect(() => {
    if (state.status !== "working") return
    setStartedAt(Date.now())
    const timer = setInterval(() => setTick((value) => value + 1), 90)
    return () => clearInterval(timer)
  }, [state.status])


  // Klik dan roda mouse.
  useEffect(() => {
    if (!mouse) return
    return mouse.subscribe((event) => {
      const { top, lines, total } = view.current

      if (event.kind === "wheel-up" || event.kind === "wheel-down") {
        const step = event.kind === "wheel-up" ? WHEEL_LINES : -WHEEL_LINES
        setScroll((value) => Math.max(0, Math.min(value + step, Math.max(0, total - 1))))
        return
      }
      if (event.kind !== "press") return

      // y berbasis 1 dari terminal; `top` adalah baris layar tempat riwayat mulai.
      const line = lines[event.y - 1 - top]
      if (!line?.toolID) return
      const id = line.toolID

      // Klik saat ctrl+x d sedang membuka SEMUANYA berarti "cukup yang ini":
      // sisanya menutup, yang diklik tetap terbuka.
      setExpandAll(false)
      setOpenTools((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    })
  }, [mouse])

  const flash = useCallback((text: string) => {
    setNotice(text)
    setTimeout(() => setNotice(undefined), 4000)
  }, [])

  /**
   * Satu-satunya jalan mengirim prompt ke server.
   *
   * Pembukuannya — histori, lompat ke bawah, membersihkan error lama — ada DI
   * SINI, bukan di `submit()`. Sebelumnya ia hidup di `submit()` saja, sementara
   * command yang dipilih dari popup memanggil pengiriman langsung; karena
   * mengetik `/` SELALU membuka popup, tidak ada satu pun slash command yang
   * pernah masuk histori prompt.
   */
  /**
   * Pembukuan yang berlaku untuk SETIAP prompt yang dikirim user — termasuk
   * command yang ditangani sepenuhnya di klien dan tidak pernah menyentuh server.
   */
  const remember = useCallback((text: string) => {
    // Error dan pemberitahuan dari giliran sebelumnya yang tertinggal di atas
    // prompt terbaca seolah milik perintah yang BARU saja dikirim.
    dispatch({ type: "notice.clear" })
    setNotice(undefined)
    // Tanpa ini, mengirim sementara riwayat tergulir ke atas membuat jawabannya
    // datang di luar layar tanpa tanda apa pun bahwa ia sudah tiba.
    setScroll(0)
    setHistory((entries) => pushHistory(entries, text))
    setHistoryIndex(DRAFT)
    stash.current = ""
  }, [])

  const send = useCallback(
    (text: string) => {
      remember(text)
      client.send(session.id, text, model, activeAgent).catch((error: unknown) => {
        flash(error instanceof Error ? error.message : String(error))
      })
    },
    [activeAgent, client, flash, model, remember, session.id],
  )

  // Menu yang dibuka perintah pun tidak boleh muncul kosong, dengan alasan yang
  // sama seperti popup ketikan — dan di sini diam saja lebih buruk lagi, karena
  // user baru saja MEMINTA daftarnya. Sebutkan bahwa memang tidak ada isinya.
  const openModelPicker = useCallback(
    (query = "") => {
      const items = modelSuggestions(config, query)
      if (items.length === 0) return flash(query ? `no model matches "${query}"` : "no models configured")
      setPopup({ title: "Switch model", items, selected: 0, fromMenu: true })
    },
    [config, flash],
  )

  const openSkillPicker = useCallback(
    (query = "") => {
      const items = skillSuggestions(config, cwd, query)
      if (items.length === 0) return flash(query ? `no skill matches "${query}"` : "no skills found")
      setPopup({ title: "Insert skill", items, selected: 0, fromMenu: true })
    },
    [config, cwd, flash],
  )

  const openAgentPicker = useCallback(() => {
    setPopup({
      title: "Switch agent",
      items: agentPickerItems(config, agentRing),
      selected: Math.max(0, agentIndex),
      fromMenu: true,
    })
  }, [agentIndex, agentRing, config])

  const switchSession = useCallback(
    (next: Session) => {
      const abandoned = session.id

      setSession(next)
      dispatch({ type: "session.switch", session: next })
      setDraft("")
      setCursor(0)
      setScroll(0)
      flash(`session: ${next.title || next.id.slice(0, 12)}`)

      // Pembersihan dilakukan SESUDAH berpindah, dan tidak pernah menggagalkan
      // perpindahannya. Membuang sesi kosong itu kerapian; berpindah sesi itu
      // yang diminta user — kerapian tidak boleh menghalangi permintaan.
      //
      // Tanpa ini, membuka `/session` lalu berpindah beberapa kali meninggalkan
      // satu sesi kosong tiap perpindahan. Server yang memeriksa kosongnya, jadi
      // sesi yang ada isinya tidak mungkin ikut terbuang.
      if (abandoned !== next.id) {
        try {
          void client.discard(abandoned).catch(() => undefined)
        } catch {
          // klien tanpa dukungan discard — bukan alasan menggagalkan perpindahan
        }
      }
    },
    [client, flash, session.id],
  )

  const openSessionPicker = useCallback(() => {
    // Disaring ke folder tempat Titah dijalankan. Riwayat percakapan terikat ke
    // kode yang sedang dikerjakan; mencampur seluruh proyek membuat sesi yang
    // dicari tenggelam di antara yang tidak ada hubungannya.
    client
      .listSessions(cwd)
      .then((sessions) => {
        if (sessions.length === 0) return flash("no saved sessions yet")
        setPopup({
          title: "Resume session",
          items: sessionSuggestions(sessions, session.id),
          selected: 0,
          fromMenu: true,
        })
      })
      .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
  }, [client, cwd, flash, session.id])

  const startNewSession = useCallback(() => {
    client
      .createSession(cwd)
      .then(switchSession)
      .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
  }, [client, cwd, flash, switchSession])

  const openCommandPalette = useCallback(() => {
    setPopup({
      title: "Commands",
      items: listCommands(config).map((entry) => ({
        kind: "command" as const,
        value: `/${entry.name} `,
        label: `/${entry.name}`,
        detail: entry.description,
      })),
      selected: 0,
      fromMenu: true,
    })
  }, [config])

  /**
   * Menjalankan pilihan dari menu.
   *
   * Command tanpa argumen DIJALANKAN, bukan sekadar disisipkan — memilih
   * "/model" dari daftar lalu harus menekan Enter lagi adalah alasan orang
   * mengira fitur ini rusak.
   */
  const runSuggestion = useCallback(
    (item: Suggestion): void => {
      if (item.kind === "model") {
        setModel(item.value)
        return flash(`model: ${item.value}`)
      }
      if (item.kind === "pick-agent") {
        const index = agentRing.indexOf(item.value === "" ? undefined : item.value)
        setAgentIndex(index === -1 ? 0 : index)
        return flash(`agent: ${item.value || "(default)"}`)
      }
      if (item.kind === "session") {
        void client
          .listSessions(cwd)
          .then((sessions) => {
            const found = sessions.find((entry) => entry.id === item.value)
            if (found) switchSession(found)
          })
          .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
        return
      }
      if (item.kind === "skill") {
        // item.value sudah "/namespace:nama " — command yang PASTI dijalankan,
        // bukan kalimat yang model boleh abaikan.
        setDraft(item.value)
        return setCursor(item.value.length)
      }

      if (item.kind === "command") {
        const name = item.label.slice(1)

        // Teks yang diketik untuk MENCAPAI menu tidak boleh tertinggal di prompt.
        // Kalau dibiarkan, "/model" masih ada saat submenu terbuka, lalu ketikan
        // berikutnya menempel jadi "/modelhalo" dan tidak pernah terkirim.
        if (IMMEDIATE_COMMANDS.has(name)) {
          setDraft("")
          setCursor(0)
        }

        if (name === "model") return openModelPicker()
        if (name === "skill") return openSkillPicker()
        if (name === "agent") return openAgentPicker()
        if (name === "session") return openSessionPicker()
        if (name === "new") return startNewSession()
        if (IMMEDIATE_COMMANDS.has(name)) return send(`/${name}`)
        // Butuh argumen: sisipkan supaya user bisa mengetiknya.
        setDraft(item.value)
        return setCursor(item.value.length)
      }

      const trigger = detectTrigger(draft, cursor)
      if (!trigger) return
      const next = applySuggestion(draft, trigger, cursor, item)
      setDraft(next.draft)
      setCursor(next.cursor)
    },
    [
      agentRing,
      client,
      cursor,
      draft,
      flash,
      openAgentPicker,
      openModelPicker,
      openSessionPicker,
      openSkillPicker,
      send,
      startNewSession,
      switchSession,
    ],
  )

  const submit = useCallback(() => {
    const text = draft.trim()
    if (text === "" || state.status === "working") return

    // Perintah yang mengubah keadaan KLIEN ditangani di sini, tidak dikirim ke
    // server — server tidak tahu model mana yang sedang kamu pilih di layar.
    const local = /^\/(model|skill|agent|session|new)\b\s*(.*)$/.exec(text)
    if (local) {
      // Ditangani di klien, tapi tetap sebuah prompt yang user ketik — ia harus
      // bisa dipanggil kembali lewat panah atas seperti yang lain.
      remember(text)
      setDraft("")
      setCursor(0)
      if (local[1] === "model") return openModelPicker(local[2] ?? "")
      if (local[1] === "agent") return openAgentPicker()
      if (local[1] === "session") return openSessionPicker()
      if (local[1] === "new") return startNewSession()
      return openSkillPicker(local[2] ?? "")
    }

    setDraft("")
    setCursor(0)
    send(text)
  }, [draft, openAgentPicker, openModelPicker, openSessionPicker, openSkillPicker, remember, send, startNewSession, state.status])

  useEffect(() => {
    // Popup yang dibuka perintah (/model, /skill) tidak boleh ditimpa detektor.
        // Menu yang dibuka perintah TIDAK boleh ditutup oleh detektor. Membersihkan
    // draft setelah memilih "/model" memicu efek ini, dan sebelum flag-nya benar
    // menu model langsung hilang begitu dibuka.
    if (popup?.fromMenu) return

    // Menelusuri histori tidak boleh membuka popup. Memanggil kembali "/model"
    // akan memunculkan menu command, dan menu itu memakan panah atas — jadi
    // satu tekanan panah mengunci user keluar dari histori yang sedang dibuka.
    if (historyIndex !== DRAFT) return

    const trigger = detectTrigger(draft, cursor)
    if (!trigger) {
      setPopup((current) => (current?.fromMenu ? current : undefined))
      return
    }
    const items = suggest({ config, cwd, trigger })
    // Popup tanpa satu pun pilihan bukan popup: ia menutupi layar, lalu MEMAKAN
    // Enter karena tidak ada item yang bisa dijalankan — prompt terlihat mati
    // sampai user menemukan Escape sendiri. Dijaga di sini, di tempat daftarnya
    // dibuat, bukan di penangan tombol: penangan itu punya empat cabang yang
    // semuanya menganggap ada pilihan, dan menambal satu per satu menyisakan
    // kotak kosong yang tetap tergambar.
    if (items.length === 0) {
      setPopup((current) => (current?.fromMenu ? current : undefined))
      return
    }
    setPopup({
      title: trigger.char === "/" ? "Commands & skills" : "Agents & files",
      items,
      selected: 0,
      fromMenu: false,
    })
    // popup sengaja tidak jadi dependensi: kalau ikut, tiap setPopup memicu ulang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, cursor, config, cwd, historyIndex])

  const armLeader = useCallback(() => {
    setLeaderActive(true)
    clearTimeout(leaderTimer.current)
    leaderTimer.current = setTimeout(() => setLeaderActive(false), LEADER_TIMEOUT)
  }, [])

  useInput((input, key) => {
    const press = toKeyPress(input, key)

    // Popup memakan navigasi lebih dulu. Tanpa ini, panah bawah menggulir
    // riwayat sementara mata user ada di daftar pilihan.
    if (popup && !state.permission) {
      if (press.key === "escape") return setPopup(undefined)
      if (press.key === "up") {
        return setPopup((p) =>
          p ? { ...p, selected: (p.selected - 1 + p.items.length) % Math.max(1, p.items.length) } : p,
        )
      }
      if (press.key === "down") {
        return setPopup((p) =>
          p ? { ...p, selected: (p.selected + 1) % Math.max(1, p.items.length) } : p,
        )
      }
      if (press.key === "tab" || press.key === "return") {
        const item = popup.items[popup.selected]
        if (!item || item.disabled === true) return
        setPopup(undefined)
        return runSuggestion(item)
      }
      // Tombol lain jatuh ke penyunting di bawah, sehingga mengetik terus
      // mempersempit daftar alih-alih menutupnya.
    }

    // Dialog izin memakan tombol lebih dulu — user harus menjawabnya.
    if (state.permission) {
      const answer = resolve(keymap, press, false, [
        "permission_allow_once",
        "permission_allow_always",
        "permission_reject",
      ])
      const decision =
        answer === "permission_allow_once"
          ? "once"
          : answer === "permission_allow_always"
            ? "always"
            : answer === "permission_reject"
              ? "reject"
              : undefined
      if (decision) {
        void client.respondPermission(session.id, state.permission.id, decision)
      }
      return
    }

    if (leaderActive) {
      const action = resolve(keymap, press, true, [
        "app_exit",
        "session_new",
        "session_undo",
        "tool_details",
        "messages_last",
        "mouse_toggle",
        "app_help",
      ])
      setLeaderActive(false)
      clearTimeout(leaderTimer.current)

      switch (action) {
        case "app_exit":
          return exit()
        case "messages_last":
          return setScroll(0)
        case "mouse_toggle": {
          const next = !mouseCapture
          setMouseCapture(next)
          mouse?.setCapture?.(next)
          return flash(
            next
              ? "mouse on — click tool lines, wheel scrolls"
              : "mouse off — drag to select and copy, ctrl+x m to switch back",
          )
        }
        case "tool_details":
          // Menutup "semua" juga membersihkan yang dibuka lewat klik, supaya
          // satu tekanan benar-benar mengembalikan riwayat ke bentuk ringkas.
          setExpandAll((value) => {
            if (value) setOpenTools(new Set())
            return !value
          })
          return
        case "session_undo":
          void client
            .undo(session.id)
            .then((result) => flash(`undo: ${result.files.length} files restored`))
            .catch((error: unknown) =>
              flash(error instanceof Error ? error.message : String(error)),
            )
          return
        case "session_new":
          return flash("new session: not available yet")
        case "app_help":
          return flash(
            "↑↓ history · end jump to bottom · ctrl+x m select text · ctrl+x d tool details · ctrl+c quit",
          )
        default:
          return
      }
    }

    // Ctrl+P: palette command, sama seperti opencode.
    if (resolve(keymap, press, false, ["command_list"]) === "command_list") {
      return openCommandPalette()
    }

    // Tombol leader itu sendiri.
    if (resolve(keymap, press, false, ["leader"]) === "leader") return armLeader()

    const cycle = resolve(keymap, press, false, ["agent_cycle_reverse", "agent_cycle"])
    if (cycle && agentRing.length > 1) {
      const step = cycle === "agent_cycle_reverse" ? -1 : 1
      const next = (agentIndex + step + agentRing.length) % agentRing.length
      setAgentIndex(next)
      flash(`agent: ${agentRing[next] ?? "(default)"}`)
      return
    }

    if (resolve(keymap, press, false, ["session_interrupt"]) === "session_interrupt") {
      if (state.status === "working") {
        // Jaring pengaman: kalau server bilang tidak ada yang berjalan padahal
        // layar bilang bekerja, layarlah yang melenceng. Tanpa jalan keluar ini
        // satu-satunya cara membetulkannya adalah menutup Titah — dan sesi itu
        // menolak setiap prompt selama status bekerja.
        const reset = () => dispatch({ type: "session.idle", sessionID: session.id })
        void client
          .abort(session.id)
          .then((result) => {
            if (result.aborted) return flash("cancelled")
            reset()
            flash("nothing was running — status reset")
          })
          .catch(() => {
            reset()
            flash("server unreachable — status reset")
          })
      }
      return
    }

    const scrollAction = resolve(keymap, press, false, [
      "messages_line_up",
      "messages_line_down",
      "messages_half_page_up",
      "messages_half_page_down",
      "messages_page_up",
      "messages_page_down",
      "messages_first",
      "messages_last",
    ])
    if (scrollAction) {
      // Batas atas dihitung dari riwayat yang ada. Tanpa ini, ↑ terus menaikkan
      // nilai scroll meski layar sudah menampilkan baris paling awal, dan ↓
      // berikutnya terasa tidak melakukan apa-apa selama puluhan tekanan.
      const totalLines = allLines(state.messages, expandTools).length
      const page = Math.max(1, size.rows - 8)
      const maxScroll = Math.max(0, totalLines - 1)
      const clamp = (value: number) => Math.max(0, Math.min(value, maxScroll))
      if (scrollAction === "messages_line_up") setScroll((v) => clamp(v + 1))
      if (scrollAction === "messages_line_down") setScroll((v) => clamp(v - 1))
      if (scrollAction === "messages_half_page_up") setScroll((v) => clamp(v + Math.floor(page / 2)))
      if (scrollAction === "messages_half_page_down")
        setScroll((v) => clamp(v - Math.floor(page / 2)))
      if (scrollAction === "messages_page_up") setScroll((v) => clamp(v + page))
      if (scrollAction === "messages_page_down") setScroll((v) => clamp(v - page))
      // length, bukan length-1: menggulir sejauh jumlah pesan akan menyisakan
      // layar kosong, bukan memperlihatkan pesan pertama.
      if (scrollAction === "messages_first") setScroll(maxScroll)
      if (scrollAction === "messages_last") setScroll(0)
      return
    }

    const historyAction = resolve(keymap, press, false, [
      "input_history_prev",
      "input_history_next",
    ])
    if (historyAction) {
      const step = historyAction === "input_history_prev" ? -1 : 1

      // Pada draft multi-baris, panah memindahkan kursor dulu; histori baru
      // terpanggil dari baris paling atas (↑) atau paling bawah (↓). Tanpa
      // syarat ini, menyunting teks beberapa baris berubah jadi membuangnya.
      const atEdge = step === -1 ? onFirstLine(draft, cursor) : onLastLine(draft, cursor)
      if (!atEdge) return setCursor(moveCursorLine(draft, cursor, step))

      if (historyIndex === DRAFT) stash.current = draft
      const next = browseHistory(history, historyIndex, step)
      if (next === historyIndex) return

      const text = next === DRAFT ? stash.current : (history[next] ?? "")
      setHistoryIndex(next)
      setDraft(text)
      return setCursor(text.length)
    }

    // ctrl+c: bersihkan input kalau ada isinya, keluar kalau kosong (perilaku opencode).
    if (resolve(keymap, press, false, ["input_clear"]) === "input_clear") {
      if (draft !== "") {
        setDraft("")
        setCursor(0)
        setHistoryIndex(DRAFT)
        return
      }
      return exit()
    }

    if (resolve(keymap, press, false, ["app_exit"]) === "app_exit") return exit()

    const editAction = resolve(keymap, press, false, [
      "input_newline",
      "input_submit",
      "input_backspace",
      "input_delete_to_line_start",
      "input_move_left",
      "input_move_right",
      "input_line_home",
      "input_line_end",
    ])

    // Begitu draft disunting, ia bukan lagi entri histori melainkan teks baru
    // milik user: panah atas berikutnya harus mulai lagi dari yang terbaru,
    // bukan melanjutkan dari tengah daftar.
    if (MUTATES_DRAFT.has(editAction ?? "")) setHistoryIndex(DRAFT)

    switch (editAction) {
      case "input_submit":
        return submit()
      case "input_newline":
        setDraft((value) => value.slice(0, cursor) + "\n" + value.slice(cursor))
        return setCursor((value) => value + 1)
      case "input_backspace":
        if (cursor === 0) return
        setDraft((value) => value.slice(0, cursor - 1) + value.slice(cursor))
        return setCursor((value) => value - 1)
      case "input_delete_to_line_start":
        setDraft((value) => value.slice(cursor))
        return setCursor(0)
      case "input_move_left":
        return setCursor((value) => Math.max(0, value - 1))
      case "input_move_right":
        return setCursor((value) => Math.min(draft.length, value + 1))
      case "input_line_home":
        return setCursor(0)
      case "input_line_end":
        return setCursor(draft.length)
      default:
        break
    }

    // Karakter biasa — termasuk tempelan multi-karakter, yang oleh Ink dikirim
    // sebagai satu event dengan key.return = false. Karakter kontrol di dalam
    // tempelan (CR, tab, escape) dibuang: kalau tidak, ia masuk mentah ke prompt
    // dan ikut terkirim ke model.
    if (input && !key.ctrl && !key.meta) {
      const clean = sanitizePaste(input)
      if (clean === "") return
      setHistoryIndex(DRAFT)
      setDraft((value) => value.slice(0, cursor) + clean + value.slice(cursor))
      setCursor((value) => value + clean.length)
    }
  })

  const usage = totalUsage(state.messages)
  const editorBox = <Editor value={draft} cursor={cursor} disabled={state.status === "working"} />
  const popupBox = popup ? (
    <Popup title={popup.title} items={popup.items} selected={popup.selected} />
  ) : null
  const workingBox =
    state.status === "working" ? (
      <Working tick={tick} elapsed={Math.max(0, Math.round((Date.now() - startedAt) / 1000))} />
    ) : null

  const lines = allLines(state.messages, expandTools)
  const editorHeight = editorRows(draft, size.rows)
  const permissionHeight = state.permission ? Math.min(14, state.permission.detail.split("\n").length + 4) : 0
  const popupHeight = popup ? Math.min(10, Math.max(1, popup.items.length)) + 3 : 0
  const workingHeight = state.status === "working" ? 1 : 0
  const withMark = shouldShowMark(size.columns, size.rows)
  const headerHeight = withMark ? markLines().length + 2 : 4
  const available = historyRows(
    size.rows,
    editorHeight + permissionHeight + popupHeight + workingHeight,
    headerHeight,
  )
  const window = viewport(lines, available, scroll)

  // Peta baris layar → baris riwayat, disegarkan tiap render.
  //
  // Hanya render yang tahu baris mana sedang terlihat dan di baris layar
  // keberapa riwayat dimulai; klik datang belakangan, lewat listener yang tidak
  // ikut dirender. Ref inilah jembatannya.
  useEffect(() => {
    view.current = {
      top: headerHeight + (window.hiddenAbove > 0 ? 1 : 0),
      lines: window.lines,
      total: lines.length,
    }
  })

  // Layar pembuka: belum ada percakapan sama sekali.
  if (state.messages.length === 0 && state.permission === undefined) {
    return (
      <Box height={size.rows} flexDirection="column">
        <Splash
          columns={size.columns}
          rows={size.rows}
          showLogo={shouldShowLogo(size.columns, size.rows)}
          cwd={cwd}
          model={model}
          {...(activeAgent ? { agent: activeAgent } : {})}
          editor={
            <>
              {popupBox}
              {editorBox}
            </>
          }
        />
        {/* Footer juga di sini: ia satu-satunya tempat keadaan leader dan pesan
            flash terlihat, dan layar pembuka adalah tempat orang pertama kali
            mencoba keybinding. */}
        <Footer
          status={state.status}
          model={activeAgent ? `${activeAgent} · ${model}` : model}
          usage={usage}
          leaderActive={leaderActive}
          {...(notice ? { hint: notice } : {})}
          mouseCapture={mouseCapture}
        />
      </Box>
    )
  }


  return (
    <Box height={size.rows} flexDirection="column">
      <InfoPanel
        cwd={cwd}
        model={model}
        {...(activeAgent ? { agent: activeAgent } : {})}
        {...(state.session ? { session: state.session } : {})}
        columns={size.columns}
        showMark={withMark}
      />

      <History
        lines={window.lines}
        hiddenAbove={window.hiddenAbove}
        hiddenBelow={window.hiddenBelow}
        jumpHint={jumpKey}
      />

      {state.error ? <Text color="red">⚠ {state.error}</Text> : null}
      {state.permission ? <PermissionDialog request={state.permission} /> : null}

      {popupBox}
      {workingBox}
      {editorBox}
      <Footer
        status={state.status}
        model={activeAgent ? `${activeAgent} · ${model}` : model}
        usage={usage}
        leaderActive={leaderActive}
        {...(notice ? { hint: notice } : {})}
        mouseCapture={mouseCapture}
      />
    </Box>
  )
}

export type { TuiState }
