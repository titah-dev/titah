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
  HistoryLine,
  Scrollback,
  InfoPanel,
  PermissionDialog,
  QuestionDialog,
  Popup,
  Splash,
  Working,
} from "./components.tsx"
import { SubagentPanel, SUBAGENT_PANEL_ROWS } from "./subagent-panel.tsx"
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
  /*
   * Penangkapan mouse BAWAANNYA MATI, dan itu syarat agar menggulir bekerja.
   *
   * Begitu aplikasi menyalakan mouse tracking, terminal mengirim roda ke
   * aplikasi alih-alih menggulir scrollback-nya sendiri. Dulu itu setimpal:
   * Titah memakainya untuk klik-pada-baris-tool dan menggulir sendiri. Sekarang
   * keduanya tidak ada lagi — riwayat ada di scrollback terminal — jadi
   * menyalakannya hanya merampas satu-satunya cara menggulir yang tersisa.
   *
   * Sakelarnya dibiarkan ada, dan petunjuknya menyebutkan akibatnya, supaya
   * user yang memang menginginkan seleksi teks berbasis aplikasi tetap bisa —
   * tapi ia harus memilihnya sendiri.
   */
  const [mouseCapture, setMouseCapture] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set())
  const expandTools: Expansion = expandAll ? true : openTools
  // Panel sub-agent: `selected` disimpan lepas dari `open` supaya menutup lalu
  // membuka lagi tidak melompat balik ke baris nol tanpa alasan.
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false)
  const [subagentSelected, setSubagentSelected] = useState(0)
  /**
   * Sesi anak yang `x`-nya sudah dipersenjatai dan menunggu tekanan kedua.
   *
   * Disimpan sebagai sessionID, bukan boolean: konfirmasi milik SATU baris,
   * dan baris yang dipilih bisa berpindah di antara dua tekanan itu.
   */
  const [cancelArmed, setCancelArmed] = useState<string | undefined>(undefined)
  // Dijepit di SATU tempat, dipakai baik oleh handler `x` maupun render: indeks
  // yang tersimpan bisa basi kalau daftar menyusut (berganti sesi sambil panel
  // terbuka), dan tanpa penjepitan ini keduanya bisa membaca baris yang sudah
  // tidak ada di array.
  const clampedSubagentSelected =
    state.subagents.length === 0 ? 0 : Math.min(subagentSelected, state.subagents.length - 1)
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
  /*
   * Klik-untuk-membuka detail tool DICABUT, dan ini konsekuensi yang tidak bisa
   * dihindari dari `<Static>`.
   *
   * Riwayat sekarang tercetak ke scrollback TERMINAL, dan posisi layar bingkai
   * dinamis bergantung pada seberapa jauh terminal digulir — sesuatu yang tidak
   * pernah diberitahukan kepada aplikasi. Memetakan `y` sebuah klik ke baris
   * riwayat berarti menebak, dan tebakan yang meleset membuka detail tool yang
   * SALAH tanpa ada yang tahu.
   *
   * Menukar fitur ini dengan hilangnya kedipan adalah pertukaran yang disengaja:
   * opencode dan Claude Code sama-sama tidak punya klik-untuk-membuka, karena
   * keduanya memakai model scrollback yang sama.
   *
   * `ctrl+x d` tetap ada dan membuka SEMUA detail sekaligus, jadi isinya tidak
   * pernah benar-benar tidak terjangkau.
   */


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
      // Reducer sudah mengosongkan `subagents` pada session.switch, tapi panel
      // buka/pilihannya hidup di state App, bukan reducer — tanpa ini, panel
      // yang terbuka saat berpindah sesi menampilkan baris sesi BARU sementara
      // sorotan `›` masih menunjuk indeks dari sesi LAMA.
      setSubagentPanelOpen(false)
      setSubagentSelected(0)
      setCancelArmed(undefined)
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

  /**
   * Menjawab pertanyaan model — dan, kalau intent-nya `switch-agent`, benar-benar
   * berpindah mode.
   *
   * Perpindahannya dilakukan DI SINI, di klien, karena ring agent adalah state
   * klien: server tidak tahu mode mana yang sedang dipilih di layar. Model
   * hanya diberi tahu hasilnya lewat nilai balik tool-nya.
   */
  const answerQuestion = useCallback(
    (question: { id: string; intent?: string }, answer: string) => {
      if (question.intent === "switch-agent" && answer !== "") {
        const index = agentRing.indexOf(answer)
        if (index !== -1) {
          setAgentIndex(index)
          flash(`agent: ${answer}`)
        }
      }
      void client.answerQuestion(session.id, question.id, answer)
    },
    [agentRing, client, flash, session.id],
  )

  const submit = useCallback(() => {
    const text = draft.trim()

    /*
     * Pertanyaan yang menunggu mengalahkan segalanya, TERMASUK penjaga
     * "sedang bekerja".
     *
     * Penjaga itu ada supaya user tidak mengirim prompt baru di tengah giliran.
     * Tapi pertanyaan model hanya pernah muncul DI TENGAH giliran — kalau
     * penjaganya berlaku di sini, Enter tidak melakukan apa-apa dan gilirannya
     * menggantung sampai timeout, dengan jawaban sudah terketik di layar.
     */
    if (state.question) {
      const question = state.question
      setDraft("")
      setCursor(0)
      answerQuestion(question, text)
      return
    }

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

    // Panel sub-agent memakan navigasi SEBELUM popup — kalau tidak, keduanya
    // berebut panah yang sama begitu keduanya sama-sama terbuka.
    //
    // DUA penjaga tambahan, keduanya bug yang sama: menganggap tombol tanpa
    // melihat modifier-nya.
    //
    // 1. `!leaderActive` — begitu ctrl+x menyalakan leader, tombol BERIKUTNYA
    //    (mis. panah bawah untuk menutup panel lewat menu leader yang sama)
    //    harus sampai ke penyelesaian chord leader di bawah, bukan ditelan
    //    sebagai navigasi baris.
    // 2. `plainKey` pada tiap cabang — tanpa ini, `x` polos DAN ctrl+x
    //    (bentuk tombol leader) terlihat identik ke `press.key === "x"`, jadi
    //    ctrl+x saat panel terbuka salah dibaca sebagai "batalkan baris ini"
    //    padahal seharusnya mempersenjatai menu leader. Cabang panah kena
    //    lubang yang sama: ctrl+↑/shift+↑ (utk gulir riwayat) akan tertelan
    //    jadi navigasi baris kalau modifier-nya tidak diperiksa.
    if (subagentPanelOpen && !state.permission && !leaderActive) {
      const plainKey = press.ctrl !== true && press.alt !== true && press.shift !== true
      if (press.key === "escape" && plainKey) {
        setCancelArmed(undefined)
        return setSubagentPanelOpen(false)
      }
      if ((press.key === "up" || press.key === "down") && plainKey) {
        // Pindah baris membatalkan konfirmasi: `x` yang sudah dipersenjatai
        // untuk satu sub-agent tidak boleh diwariskan ke baris tetangganya.
        setCancelArmed(undefined)
        const step = press.key === "up" ? -1 : 1
        return setSubagentSelected((current) => {
          const total = state.subagents.length
          return total === 0 ? 0 : (current + step + total) % total
        })
      }
      if (press.key === "x" && plainKey) {
        const target = state.subagents[clampedSubagentSelected]
        if (!target) return

        /*
         * `x` DIKONFIRMASI, bukan langsung membunuh.
         *
         * Membuat panel modal saja tidak cukup, dan itu terbukti di terminal
         * sungguhan: dengan panel modal, mengetik "fix" memang tidak lagi
         * menyisakan "fi" di draft — tapi huruf ketiganya tetap menghentikan
         * sub-agent terpilih. Menghentikan sub-agent tidak bisa dibatalkan
         * dan pekerjaannya hilang, jadi satu tekanan tidak boleh cukup.
         *
         * Tekanan pertama mempersenjatai baris ini dan mengumumkannya; tekanan
         * kedua di baris yang sama baru menjalankannya. Tombol lain apa pun —
         * termasuk pindah baris — melucutinya lagi.
         */
        if (cancelArmed !== target.sessionID) {
          setCancelArmed(target.sessionID)
          return flash(`press x again to cancel ${target.agent}`)
        }
        setCancelArmed(undefined)
        // Sengaja sessionID ANAK, bukan `session.id` induk: membatalkan induk
        // akan menghentikan seluruh giliran koordinator, padahal tujuan panel
        // ini justru menghindari itu — satu sub-agent macet tidak boleh
        // memaksa seluruh tim berhenti.
        flash(`cancelling ${target.agent}`)
        void client
          .abort(target.sessionID)
          // Hasilnya TIDAK dibuang: sub-agent yang sudah selesai tidak punya
          // apa pun untuk dihentikan, dan tanpa pesan ini `x` di baris itu
          // terlihat persis seperti `x` yang gagal bekerja.
          .then((result) => {
            if (!result.aborted) flash(`${target.agent} is no longer running`)
          })
          .catch(() => flash("server unreachable — nothing was cancelled"))
        return
      }

      // Tombol apa pun selain `x` di baris yang sama melucuti konfirmasi.
      if (cancelArmed !== undefined) setCancelArmed(undefined)

      /*
       * Panel bersifat MODAL: selama terbuka, ia memiliki papan ketik.
       *
       * Sebelumnya tombol lain jatuh ke penyunting di bawah, dan itu berarti
       * user yang membuka panel untuk memantau lalu mulai mengetik pesan
       * berikutnya kehilangan huruf `x`-nya ke pembatalan sub-agent — tanpa
       * konfirmasi, tanpa jalan mengembalikan. Panel toh sudah mengambil
       * ↑/↓ dari penyunting, jadi setengah-modal hanya menyisakan tebakan
       * tentang tombol mana yang masih hidup.
       *
       * Yang tetap TEMBUS hanya dua jalan keluar global: tombol leader (chord
       * `ctrl+x` — termasuk `ctrl+x ↓` yang menutup panel) dan tombol keluar.
       * Keduanya bermodifier, jadi tak satu pun bisa muncul dari mengetik
       * biasa. Palet perintah SENGAJA tidak ikut: panel ini duduk di atas
       * popup dalam urutan penanganan, jadi palet yang terbuka di baliknya
       * tidak akan pernah menerima panah maupun Enter — pintu yang membuka
       * kotak yang tidak bisa dipakai lebih buruk daripada pintu yang terkunci.
       */
      if (resolve(keymap, press, false, ["leader", "app_exit"]) === undefined) {
        // Tombol yang ditelan diam-diam terasa seperti terminal yang mati.
        // Satu baris di footer memberi tahu KE MANA papan ketik pergi dan cara
        // mengambilnya kembali — pesan yang sama untuk tiap tombol, jadi tidak
        // menumpuk jadi kebisingan.
        flash("sub-agent panel has the keyboard · esc to close it")
        return
      }
    }

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

    /*
     * Pertanyaan model: hanya TIGA tombol yang dibelokkan di sini.
     *
     * Mengetik jawabannya sengaja TIDAK ditangani di cabang ini — ia jatuh ke
     * editor seperti biasa, jadi backspace, panah, tempelan, dan semua perilaku
     * yang sudah ada tetap berlaku tanpa disalin ulang. Yang berbeda hanya apa
     * yang terjadi saat Enter, dan itu ditangani di `submit`.
     *
     * Didahulukan atas dialog izin karena pertanyaan menerima ketikan bebas:
     * kalau izin lebih dulu, huruf yang diketik user sebagai jawaban tertelan
     * sebagai y/a/n, dan "yakin" berubah jadi izin yang tidak pernah diberikan.
     */
    if (state.question) {
      const question = state.question

      // Esc = tidak menjawab. Model menerimanya sebagai izin melanjutkan dengan
      // asumsi terbaiknya, BUKAN sebagai penolakan.
      if (resolve(keymap, press, false, ["session_interrupt"]) === "session_interrupt") {
        answerQuestion(question, "")
        return
      }

      // Angka = pintasan pilihan, dan hanya kalau draft masih kosong. Begitu
      // user mulai mengetik, "2" adalah bagian dari jawabannya.
      if (question.options.length > 0 && draft === "" && /^[1-9]$/.test(input)) {
        const chosen = question.options[Number(input) - 1]
        if (chosen !== undefined) {
          answerQuestion(question, chosen)
          return
        }
      }
      // Sisanya jatuh ke bawah: user sedang mengetik jawabannya.
    }

    // Dialog izin memakan tombol lebih dulu — user harus menjawabnya.
    if (state.permission) {
      // Aturan panel adalah "tombol apa pun selain `x` di baris yang sama
      // melucuti konfirmasi" — tapi cabang itu (di atas) dilewati SELURUHNYA
      // begitu `state.permission` terisi, jadi `x` yang sudah dipersenjatai
      // sebelum dialog muncul tetap bersenjata sepanjang dialog dijawab.
      // Menjawab dialog jelas termasuk "tombol lain", jadi dilucuti di sini juga.
      if (cancelArmed !== undefined) setCancelArmed(undefined)
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
        "subagents_panel",
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
              ? "mouse captured — terminal scrolling is OFF while this is on"
              : "mouse released — wheel scrolls the terminal, drag selects text",
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
        case "subagents_panel":
          // TIDAK mereset `subagentSelected`: komentar di deklarasinya bilang
          // pilihan sengaja dipertahankan lewat tutup/buka, jadi kodenya harus
          // benar-benar begitu, bukan diam-diam melompat balik ke baris nol.
          setSubagentPanelOpen((value) => !value)
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

    /*
     * Gulir kustom DICABUT, dan itu konsekuensi langsung dari `<Static>`.
     *
     * Riwayat yang sudah selesai sekarang tercetak ke scrollback TERMINAL, jadi
     * yang menggulirnya adalah terminal itu sendiri — roda mouse, shift+PageUp,
     * dan pencarian bawaan terminal semuanya bekerja, dan semuanya lebih baik
     * daripada yang pernah ditiru di sini. Menyisakan tombol gulir yang tidak
     * lagi menggulir apa pun cuma mengajari user bahwa tombolnya rusak.
     *
     * Ini juga yang menghapus keluhan "jarak prompt tidak menentu": tidak ada
     * lagi jendela yang bisa bergeser lepas dari prompt.
     *
     * Tombolnya tetap DITELAN, dan itu bukan sisa. Tanpa ini PageUp berakhir
     * sebagai `[5~` yang terketik di dalam prompt — tombol yang tidak melakukan
     * apa-apa masih jauh lebih baik daripada tombol yang mengotori masukan.
     */
    if (
      resolve(keymap, press, false, [
        "messages_line_up",
        "messages_line_down",
        "messages_half_page_up",
        "messages_half_page_down",
        "messages_page_up",
        "messages_page_down",
        "messages_first",
        "messages_last",
      ])
    ) {
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

  /*
   * Lebar tempat jawaban dibungkus.
   *
   * Dikurangi dua dari lebar terminal supaya tidak pernah menyentuh kolom
   * terakhir: terminal yang membungkus sendiri di kolom terakhir menghasilkan
   * baris kosong hantu, dan baris hantu itu menggeser seluruh perhitungan
   * gulir sebanyak satu baris per paragraf.
   */
  const textWidth = Math.max(20, size.columns - 2)

  const usage = totalUsage(state.messages)
  const editorBox = <Editor value={draft} cursor={cursor} disabled={state.status === "working"} />
  const popupBox = popup ? (
    <Popup title={popup.title} items={popup.items} selected={popup.selected} />
  ) : null
  const subagentPanelBox = subagentPanelOpen ? (
    <SubagentPanel
      subagents={state.subagents}
      selected={clampedSubagentSelected}
      {...(cancelArmed !== undefined ? { armed: cancelArmed } : {})}
    />
  ) : null
  const workingBox =
    state.status === "working" ? (
      <Working tick={tick} elapsed={Math.max(0, Math.round((Date.now() - startedAt) / 1000))} />
    ) : null

  const lines = allLines(state.messages, expandTools, textWidth)

  /*
   * Riwayat dibelah: yang SUDAH SELESAI dicetak sekali ke scrollback terminal,
   * yang masih hidup digambar ulang tiap frame.
   *
   * Ini yang menghapus kedipan. Sebelumnya seluruh layar adalah satu bingkai
   * dinamis setinggi `size.rows`, jadi setiap detak spinner — sepuluh kali per
   * detik — menghapus lalu menulis ulang SELURUH layar.
   *
   * Yang hidup hanya pesan TERAKHIR, dan hanya selama giliran berjalan. Begitu
   * giliran selesai ia ikut menetap. `<Static>` menuntut daftarnya hanya
   * bertambah, dan pembagian ini memenuhinya: pesan berpindah dari hidup ke
   * menetap tepat sekali, dengan cara ditambahkan.
   */
  const liveCount = state.status === "working" && state.messages.length > 0 ? 1 : 0
  const settledMessages = state.messages.slice(0, state.messages.length - liveCount)
  const liveMessages = state.messages.slice(state.messages.length - liveCount)
  const settledLines = allLines(settledMessages, expandTools, textWidth)
  const liveLines = allLines(liveMessages, expandTools, textWidth)

  /*
   * Kunci yang memaksa scrollback dicetak ulang seluruhnya.
   *
   * `<Static>` tidak pernah memperbarui yang sudah tercetak, jadi dua hal harus
   * memaksanya mulai dari nol: berganti sesi (isinya milik percakapan lain) dan
   * membuka/menutup detail tool (baris yang sama berubah isinya). Tanpa ini,
   * ctrl+x d tidak mengubah apa pun di layar.
   */
  const scrollbackKey = `${session.id}:${expandAll ? "all" : "some"}:${openTools.size}`
  const editorHeight = editorRows(draft, size.rows)
  const permissionHeight = state.permission ? Math.min(14, state.permission.detail.split("\n").length + 4) : 0
  // Pertanyaan memakan tinggi juga, kalau tidak riwayat digambar di atasnya.
  const questionHeight = state.question
    ? Math.min(14, state.question.question.split("\n").length + state.question.options.length + 4)
    : 0
  const popupHeight = popup ? Math.min(10, Math.max(1, popup.items.length)) + 3 : 0
  const workingHeight = state.status === "working" ? 1 : 0
  // Angka `SUBAGENT_PANEL_ROWS` di sini HARUS sama dengan yang dipakai
  // SubagentPanel untuk mem-windowing barisnya — sebelumnya reservasi ini
  // (dulu `min(10, ...)`) menyimpang diam-diam dari render (dulu tanpa batas
  // sama sekali), dan begitu satu giliran menghasilkan sebelas-plus sub-agent,
  // baris riwayat terbaru terdorong keluar layar tanpa satu pun error.
  const subagentPanelHeight = subagentPanelOpen
    ? Math.min(SUBAGENT_PANEL_ROWS, Math.max(1, state.subagents.length)) + 3
    : 0
  const withMark = shouldShowMark(size.columns, size.rows)
  const headerHeight = withMark ? markLines().length + 2 : 4
  const available = historyRows(
    size.rows,
    editorHeight + permissionHeight + questionHeight + popupHeight + workingHeight + subagentPanelHeight,
    headerHeight,
  )
  /*
   * Bagian hidup DIBATASI tinggi layar, dan itu bukan gulir.
   *
   * Satu jawaban bisa lebih panjang dari terminal, dan bingkai dinamis yang
   * lebih tinggi dari layar membuat Ink menulis di luar batas — layarnya lalu
   * kacau, bukan sekadar terpotong. `scroll: 0` berarti selalu menempel pada
   * baris terbaru, yang memang satu-satunya perilaku yang masuk akal untuk
   * jawaban yang sedang mengalir.
   */
  const liveWindow = viewport(liveLines, available, 0)

  /*
   * Menambatkan prompt di dasar layar selama isinya BELUM memenuhi layar.
   *
   * `<Static>` mencetak ke scrollback lalu bingkai dinamis menyusul tepat di
   * bawahnya. Begitu isi melebihi tinggi terminal, terminal menggulir dan
   * prompt duduk di dasar dengan sendirinya — tapi di awal sesi, ketika baru
   * ada beberapa baris, prompt ikut naik dan menempel di bawah baris terakhir
   * di tengah layar. Itu yang terasa "ikut naik".
   *
   * Tingginya bisa dihitung justru karena kasusnya hanya berlaku SEBELUM
   * terminal menggulir: selama total baris masih kurang dari tinggi layar, apa
   * yang tercetak sama persis dengan apa yang terlihat. Setelah itu selisihnya
   * nol dan penyangga ini hilang dengan sendirinya.
   */
  const printedRows = headerHeight + settledLines.length
  const dynamicRows =
    liveWindow.lines.length +
    editorHeight +
    permissionHeight +
    questionHeight +
    popupHeight +
    workingHeight +
    subagentPanelHeight +
    1 // footer
  const bottomPad = Math.max(0, size.rows - printedRows - dynamicRows)

  // Peta baris layar → baris riwayat, disegarkan tiap render.
  //
  // Hanya render yang tahu baris mana sedang terlihat dan di baris layar
  // keberapa riwayat dimulai; klik datang belakangan, lewat listener yang tidak
  // ikut dirender. Ref inilah jembatannya.
  useEffect(() => {
    /*
     * Hanya bagian HIDUP yang bisa diklik sekarang.
     *
     * Yang sudah menetap ada di scrollback terminal, dan Titah tidak tahu di
     * baris layar keberapa ia berada — terminal boleh menggulirnya kapan saja
     * tanpa memberi tahu siapa pun. Memetakan klik ke sana berarti menebak, dan
     * tebakan yang meleset membuka detail tool yang salah.
     */
    /*
     * Baris layar tempat bagian HIDUP dimulai = tinggi header + jumlah baris
     * yang sudah menetap. Keduanya dicetak `<Static>` di atas bingkai dinamis.
     *
     * Memakai `headerHeight` saja — seperti sebelum riwayat pindah ke Static —
     * membuat klik meleset sebanyak jumlah baris yang sudah menetap, dan
     * melesetnya diam: yang terbuka adalah detail tool yang salah.
     */
    view.current = {
      top: headerHeight + settledLines.length,
      lines: liveWindow.lines,
      total: liveLines.length,
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
              {subagentPanelBox}
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
    <>
      {/* Dicetak SEKALI ke scrollback terminal, di atas bingkai dinamis.
          Menggulirnya memakai gulir terminal sendiri — itu yang membuat
          posisi prompt tidak pernah lagi mengambang di atas ruang kosong. */}
      {/* Panel atas ikut dicetak SEKALI, di puncak scrollback.
          `<Static>` menulis di ATAS bingkai dinamis, jadi panel yang tinggal di
          bingkai itu akan terdorong ke tengah layar — di bawah riwayat, bukan di
          atasnya. Dicetak sekali juga lebih jujur terhadap isinya: cwd, model,
          dan sesi adalah keadaan saat percakapan DIMULAI. */}
      <Scrollback
        lines={settledLines}
        resetKey={scrollbackKey}
        header={
          <InfoPanel
            cwd={cwd}
            model={model}
            {...(activeAgent ? { agent: activeAgent } : {})}
            {...(state.session ? { session: state.session } : {})}
            columns={size.columns}
            showMark={withMark}
          />
        }
      />

      {/* Bingkai DINAMIS, dan sengaja sekecil mungkin: hanya inilah yang
          digambar ulang tiap detak spinner. */}
      <Box flexDirection="column">
      {bottomPad > 0 ? <Box height={bottomPad} flexShrink={0} /> : null}

      {liveWindow.lines.map((line) => (
        <HistoryLine key={line.key} line={line} />
      ))}

      {state.error ? <Text color="red">⚠ {state.error}</Text> : null}
      {/* Redup dan tanpa warna peringatan: ini informasi, bukan kegagalan, dan
          satu baris merah untuk hal yang tidak merusak apa pun mengajari user
          mengabaikan warna merah yang sungguhan. */}
      {state.notice ? <Text dimColor>· {state.notice}</Text> : null}
      {state.question ? <QuestionDialog request={state.question} /> : null}
      {state.permission ? <PermissionDialog request={state.permission} /> : null}

      {subagentPanelBox}
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
    </>
  )
}

export type { TuiState }
