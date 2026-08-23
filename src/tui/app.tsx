import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import type { Key } from "ink"
import type { Client } from "./client.ts"
import {
  buildKeymap,
  leaderMenu as buildLeaderMenu,
  describeKey,
  LEADER_ACTIONS,
  leaderKeyFor,
  leaderName,
  resolve,
  type Action,
  type Keymap,
  type KeyPress,
} from "./keybinds.ts"
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
  QuestionDialog,
  Popup,
  Splash,
  Working,
} from "./components.tsx"
import { SubagentPanel, SUBAGENT_PANEL_ROWS } from "./subagent-panel.tsx"
import { Panel } from "./panel.tsx"
import { droppedNotice, panelLayout, type PanelLine } from "./panels.ts"
import { loadExtensions, type ExtensionFailure, type LoadedExtension } from "../core/extension.ts"
import { errorLines, renderPanel } from "./extension-host.ts"
import { checkUpdate, updateNotice } from "../core/update.ts"
import { loadRegistry } from "../core/extension-registry.ts"
import { installLabel, pickerRows } from "../core/extension-picker.ts"
import { installedExtensions } from "../core/extension.ts"
import { installExtension } from "../core/extension-install.ts"
import { editConfigFile } from "../core/config-edit.ts"
import { globalConfigFile } from "../core/paths.ts"
import { LoginPanel, loginLines, type LoginProgress } from "./login.tsx"
import {
  AccountError,
  accountServer,
  currentAccount,
  login as runLogin,
  revokeToken,
  signOut,
} from "../core/account.ts"
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
import { nextEffort, type EffortChoice } from "../core/prompt.ts"
import {
  allLines,
  editorRows,
  historyRows,
  RESERVED_ROWS,
  toolSteps,
  turnAgent,
  viewport,
  type Expansion,
  type Line,
} from "./layout.ts"
import type { MouseSource } from "./mouse.ts"
import { shouldShowLogo, shouldShowMark, markLines } from "./logo.ts"
import { fitsWideHeader, headerLines } from "./header.ts"
import type { Session } from "../core/message.ts"

const LEADER_TIMEOUT = 2000

/**
 * Jeda sebelum menu leader muncul.
 *
 * Cukup lama supaya yang hafal tombolnya tidak pernah melihatnya, cukup pendek
 * supaya yang lupa tidak merasa menunggu. Angka yang sama dipakai which-key di
 * Emacs dan Vim karena alasan yang sama.
 */
const LEADER_MENU_DELAY = 400

/**
 * Berapa lama ctrl+c kedua masih dihitung sebagai konfirmasi.
 *
 * Cukup lama untuk tekanan kedua yang disengaja, cukup pendek supaya senjata
 * itu tidak menganggur — ctrl+c yang ditekan sepuluh menit lalu tidak boleh
 * membuat tekanan hari ini langsung menutup sesi.
 */
const EXIT_CONFIRM_TIMEOUT = 3000

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

/**
 * Nama untuk sapaan header: nama asli kalau ada, kalau tidak bagian lokal email.
 *
 * Alamat email utuh memakan setengah kolom dan menyapa orang dengan domainnya.
 */
function displayName(account: { user: { name?: string; email: string } } | undefined) {
  if (!account) return undefined
  const name = account.user.name?.trim()
  return name && name.length > 0 ? name : account.user.email.split("@")[0]
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
  /** Versi Titah. Diperiksa terhadap `engines.titah` setiap extension. */
  version: string
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
  version,
  mouse,
}: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [session, setSession] = useState(initialSession)
  const [state, dispatch] = useReducer(reduce, { ...initialState, session: initialSession })
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [leaderActive, setLeaderActive] = useState(false)
  /**
   * Menu leader sedang terbuka.
   *
   * Terpisah dari `leaderActive` karena keduanya menyala pada waktu yang
   * berbeda: leader menyala SEKETIKA, menunya menyusul setelah jeda pendek.
   * Yang hafal tombolnya tidak pernah melihat menu ini berkedip.
   */
  const [leaderMenu, setLeaderMenu] = useState(false)
  /**
   * ctrl+c sudah ditekan sekali pada prompt kosong, dan tekanan berikutnya
   * akan menutup Titah.
   *
   * Berbatas waktu: senjata yang tidak pernah kedaluwarsa berarti ctrl+c yang
   * ditekan sepuluh menit lalu masih bisa menutup sesi hari ini.
   */
  const [exitArmed, setExitArmed] = useState(false)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const leaderMenuTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Dua lapis: `expandAll` dari ctrl+x d, dan himpunan tool yang dibuka satu per
  // satu lewat klik. Dipisah supaya menutup "semua" tidak ikut menutup blok yang
  // sengaja dibuka user, dan sebaliknya.
  // Pelacakan mouse bisa dimatikan supaya terminal boleh menyorot teks lagi.
  const [mouseCapture, setMouseCapture] = useState(true)
  const [expandAll, setExpandAll] = useState(false)
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set())
  const expandTools: Expansion = expandAll ? true : openTools
  // Panel sub-agent: `selected` disimpan lepas dari `open` supaya menutup lalu
  // membuka lagi tidak melompat balik ke baris nol tanpa alasan.
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false)
  /*
   * Dua state terpisah, bukan satu enum sisi-yang-aktif.
   *
   * Kedua panel boleh terbuka bersamaan, dan yang menutup salah satunya saat
   * terminal menyempit adalah LANTAI — bukan user. State di sini tetap menyala
   * supaya panel muncul sendiri lagi begitu terminal dilebarkan; kalau lantai
   * ikut mematikannya, melebarkan terminal tidak memulihkan apa pun.
   */
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [extensions, setExtensions] = useState<LoadedExtension[]>([])
  /**
   * Panel yang sedang memegang papan tombol, kalau ada.
   *
   * Terpisah dari "terbuka", dan itu yang menentukan: panel samping dibuka
   * untuk DILIHAT sambil bekerja, tidak seperti panel sub-agent yang memakan
   * tombol selama terbuka. Menyatukan keduanya berarti membuka panel git
   * membuat prompt tidak bisa diketik lagi.
   */
  const [panelFocus, setPanelFocus] = useState<"left" | "right" | undefined>(undefined)
  /**
   * Sisi yang benar-benar TERGAMBAR, disegarkan tiap render.
   *
   * Ref dan bukan nilai di dep array, karena `panels` dihitung jauh di bawah
   * `runLeaderAction` — menaruhnya di deps callback itu akan membacanya sebelum
   * ia diinisialisasi. Dan tanpa jembatan apa pun, callback itu menutup atas
   * `extensions` dari render PERTAMA, yang masih kosong: `<leader>f` lalu selalu
   * menjawab "no side panel is open" meski panelnya jelas ada di layar.
   *
   * Pola yang sama dengan `view.current` di bawah: hanya render yang tahu apa
   * yang sedang terlihat, dan penanganan tombol datang belakangan.
   */
  const drawnPanels = useRef<("left" | "right")[]>([])
  /**
   * Isi panel per sisi, beserta error terakhirnya.
   *
   * Error DISIMPAN bersama barisnya dan bukan menggantikannya: panel yang
   * berkedip ke kosong setiap kali satu refresh gagal lebih mengganggu daripada
   * panel yang menampilkan keadaan sebelumnya dengan penanda gagal.
   */
  const [panelContent, setPanelContent] = useState<
    Partial<Record<"left" | "right", { lines: PanelLine[]; error?: string }>>
  >({})
  /**
   * Dinaikkan oleh keempat pemicu refresh Q26. Satu angka, bukan empat effect
   * yang masing-masing memanggil render — empat pemanggil untuk satu pekerjaan
   * berarti dua pemicu yang berdekatan menjalankan render dua kali.
   */
  const [refreshToken, setRefreshToken] = useState(0)
  const [updateHint, setUpdateHint] = useState<string | undefined>(undefined)
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
  /**
   * Login yang sedang berjalan.
   *
   * Punya state sendiri, bukan sekadar `notice`, karena kode verifikasinya
   * harus tetap terbaca selama menit-menit user pindah ke browser — sebuah
   * baris yang lewat sekali akan tergulir hilang tepat saat dibutuhkan.
   */
  const [loginProgress, setLoginProgress] = useState<LoginProgress | undefined>(undefined)
  const loginAbort = useRef<AbortController | undefined>(undefined)

  /*
   * Nama yang disapa header. Disimpan sebagai state, bukan dibaca ulang tiap
   * render: `currentAccount()` membuka file di disk, dan layar ini digambar
   * ulang puluhan kali per giliran. Cukup disegarkan saat login dan logout —
   * hanya dua peristiwa itu yang bisa mengubahnya.
   */
  const [accountName, setAccountName] = useState<string | undefined>(
    () => displayName(currentAccount()),
  )

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

  /*
   * Putaran agent, TANPA entri kosong di depannya.
   *
   * Dulu ia diawali `undefined` sebagai "tanpa agent", supaya Tab bisa kembali
   * ke perilaku default tanpa harus tahu nama agent mana pun. Entri itu tidak
   * pernah benar-benar berarti apa yang tertulis: `client.send` menghilangkan
   * field `agent` saat nilainya kosong, dan server mengisinya sendiri dengan
   * `config.defaultAgent` — yang selalu terisi `build`. Jadi "tanpa agent"
   * menjalankan `build`, lengkap dengan prompt dan izinnya.
   *
   * Yang tersisa hanyalah akibatnya di layar: header menyembunyikan nama mode
   * saat entri itu dipilih, jadi user menjalankan `build` sambil melihat layar
   * yang tidak menyebut mode apa pun. Persis yang ingin dicegah `defaultAgent`
   * saat ia diisi otomatis.
   *
   * `[undefined]` dipertahankan HANYA sebagai jaring pengaman untuk daftar yang
   * kosong: Tab pada array kosong menghasilkan `undefined` dan mode hilang
   * tanpa sebab. Pada praktiknya `DEFAULT_AGENTS` selalu menyuntik
   * plan/build/build-auto, jadi cabang itu tidak pernah ditempuh.
   */
  const agentRing = useRef<(string | undefined)[]>(
    agents && agents.length > 0 ? [...agents] : [undefined],
  ).current
  const [agentIndex, setAgentIndex] = useState(() => {
    const start = agentRing.indexOf(defaultAgent)
    return start === -1 ? 0 : start
  })
  const activeAgent = agentRing[agentIndex]

  /*
   * DUA nama agent di layar, dan bedanya disengaja.
   *
   * `activeAgent` menjawab "giliran berikutnya pakai apa" — ia berubah begitu
   * Tab ditekan. `runningAgent` menjawab "yang sedang bekerja ini apa" — ia
   * dibaca dari pesan yang sedang mengalir, jadi ia TIDAK ikut berubah, persis
   * seperti izin giliran itu yang juga sudah dibekukan sejak awal.
   *
   * Tanpa yang kedua, menekan Tab di tengah giliran membuat seluruh layar
   * mengaku sedang menjalankan agent yang sebenarnya belum menyentuh apa pun.
   */
  const runningAgent = turnAgent(state.messages)

  /*
   * Kata kerja berganti tiap Titah memulai tool baru — `ls` lalu `cat` adalah
   * dua kata yang berbeda.
   *
   * Dulu ia berganti tiap delapan detik, dan itu keliru dengan cara yang halus:
   * kata yang berganti sendiri sementara pekerjaannya diam MEMBERI kesan ada
   * kemajuan. Itu kesan yang paling tidak boleh dipalsukan oleh indikator
   * kerja — tool yang macet lima menit sekarang memegang satu kata selama lima
   * menit, apa adanya.
   *
   * Ref-nya ditulis SAAT RENDER, bukan di `useEffect`. Efek berjalan setelah
   * bingkai tergambar, jadi bingkai pertama sebuah langkah akan memakai
   * `sinceStep` milik langkah SEBELUMNYA — satu bingkai dengan cahaya di posisi
   * yang salah, tepat pada bingkai yang paling diperhatikan. Penulisan ini
   * idempoten untuk masukan render yang sama, jadi aman diulang.
   */
  const step = toolSteps(state.messages)
  const stepStarted = useRef({ step, tick })
  if (stepStarted.current.step !== step) stepStarted.current = { step, tick }

  /*
   * Panjang kesimpulan, disimpan di KLIEN seperti model dan agent.
   *
   * Server tidak perlu mengingatnya: ia dikirim per giliran, jadi tidak ada
   * keadaan yang bisa menyimpang antara apa yang tertulis di layar dan apa yang
   * dipakai giliran berikutnya. Mulai dari `"default"` — sekali ditekan, ia
   * mengalahkan `agent.effort` di config, dan itu memang maksudnya.
   */
  const [effort, setEffort] = useState<EffortChoice>("default")

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

  /*
   * Aksi leader yang disumbang extension, mis. `extension:@titah/extension-git`.
   *
   * Berprefiks supaya tidak pernah bisa bertabrakan dengan nama aksi bawaan.
   * Tombolnya sendiri masih bisa bertabrakan — itu diperiksa saat install, bukan
   * di sini; yang termuat lebih dulu di config menang, sama seperti sisi.
   */
  const extensionBindings = useMemo(() => {
    const bindings: Record<string, string> = {}
    for (const entry of extensions) {
      if (entry.key !== undefined) bindings[`extension:${entry.spec}`] = entry.key
    }
    return bindings
  }, [extensions])

  /*
   * `useMemo` dan bukan `useRef`: extension dimuat secara asinkron, jadi keymap
   * yang dibekukan pada render pertama tidak akan pernah memuat tombol mereka —
   * dan tombol yang terdaftar tapi mati lebih buruk daripada tombol yang tidak
   * ada.
   */
  const keymap = useMemo<Keymap>(
    () => buildKeymap({ ...keybindOverrides, ...extensionBindings }),
    [keybindOverrides, extensionBindings],
  )
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
    /*
     * 250ms, dan kali ini angkanya tidak akan naik lagi.
     *
     * Tiga percobaan sudah dipakai untuk menemukan bahwa masalahnya bukan di
     * angka ini: 1000ms terbaca lamban, 250ms terbaca pas tapi braille-nya
     * tersendat, 100ms membuat braille mengalir DAN layar bergetar. Di alternate
     * screen tiap detak menulis ulang bingkainya, jadi laju punya batas atas
     * yang tidak bisa ditawar berapa pun rapinya kode di sekitarnya.
     *
     * Jadi yang diganti bentuk animasinya, bukan lajunya. Titik yang bernapas
     * jadi `@` dan cahaya yang menyapu kata sama-sama TIDAK butuh laju tinggi:
     * keduanya gerakan lambat menurut sifatnya, bukan gerakan cepat yang
     * dipaksa melambat. Lihat `SPINNER` dan `shimmer` di components.tsx.
     */
    const timer = setInterval(() => setTick((value) => value + 1), 250)
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
   * `/login` — alur perangkat yang sama persis dengan `titah login`.
   *
   * Panelnya dibiarkan berdiri beberapa detik setelah selesai, baik berhasil
   * maupun gagal: hasil yang langsung menghilang membuat user tidak pernah tahu
   * apakah yang barusan ia lakukan berhasil.
   */
  const startLogin = useCallback(() => {
    if (loginProgress && loginProgress.phase !== "done" && loginProgress.phase !== "failed") {
      return flash("a sign-in is already in progress")
    }

    const existing = currentAccount()
    const server = accountServer(config)
    if (existing && existing.server === server) {
      return flash(`already signed in as ${existing.user.email} — /logout first`)
    }

    const controller = new AbortController()
    loginAbort.current = controller
    setLoginProgress({ phase: "starting", server })

    void runLogin(
      server,
      {
        onPrompt: (authorization, browserOpened) =>
          setLoginProgress({ phase: "waiting", server, authorization, browserOpened }),
        onSlowDown: () =>
          setLoginProgress((current) => (current ? { ...current, slowedDown: true } : current)),
      },
      { signal: controller.signal },
    )
      .then((account) => {
        setAccountName(displayName(account))
        setLoginProgress({ phase: "done", server, email: account.user.email })
        setTimeout(() => setLoginProgress(undefined), 6000)
      })
      .catch((error: unknown) => {
        setLoginProgress({
          phase: "failed",
          server,
          error: error instanceof AccountError ? error.message : String(error),
        })
        setTimeout(() => setLoginProgress(undefined), 10_000)
      })
      .finally(() => {
        loginAbort.current = undefined
      })
  }, [config, flash, loginProgress])

  const cancelLogin = useCallback((): boolean => {
    if (!loginAbort.current) return false
    loginAbort.current.abort()
    loginAbort.current = undefined
    setLoginProgress(undefined)
    flash("sign-in cancelled")
    return true
  }, [flash])

  const doLogout = useCallback(() => {
    const account = currentAccount()
    if (!account) return flash("not signed in")
    // Token lokal dihapus lepas dari hasil pencabutan di server: sign out yang
    // gagal karena jaringan mati tapi meninggalkan token di disk berbohong.
    void revokeToken(account).then((revoked) => {
      flash(
        revoked
          ? `signed out ${account.user.email}`
          : `signed out ${account.user.email} locally — could not reach ${account.server}`,
      )
    })
    signOut()
    setAccountName(undefined)
  }, [flash])

  const showAccount = useCallback(() => {
    const account = currentAccount()
    flash(
      account
        ? `signed in as ${account.user.email} · ${account.server}`
        : `not signed in · /login uses ${accountServer(config)}`,
    )
  }, [config, flash])

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
      client.send(session.id, text, model, activeAgent, effort).catch((error: unknown) => {
        flash(error instanceof Error ? error.message : String(error))
      })
    },
    [activeAgent, client, effort, flash, model, remember, session.id],
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

  /*
   * Picker extension: satu tempat melihat status, mencari, dan memasang.
   *
   * Tiga keadaan dibedakan di labelnya, karena Enter berarti hal berbeda pada
   * masing-masing — dan yang paling berbeda adalah `available`, yang MENULIS ke
   * config user. Lihat `installLabel` di core/extension-picker.ts.
   */
  const openExtensionPicker = useCallback(() => {
    void loadRegistry()
      .then((snapshot) => {
        const rows = pickerRows({
          configured: Object.keys(config.extension),
          installed: installedExtensions(),
          registry: snapshot.entries,
          proposedKeys: Object.fromEntries(
            extensions.filter((entry) => entry.key !== undefined).map((entry) => [entry.spec, entry.key as string]),
          ),
          keymap,
        })

        if (rows.length === 0) {
          return flash(
            snapshot.stale
              ? `no extensions listed — registry unreachable (${snapshot.reason ?? "offline"})`
              : "no extensions listed yet",
          )
        }

        setPopup({
          // Keusangan disebut DI JUDUL, bukan disembunyikan. Daftar yang mungkin
          // ketinggalan tetap berguna selama user tahu ia sedang melihat cache.
          title: snapshot.stale ? "Extensions (offline — cached list)" : "Extensions",
          items: rows.map((row) => ({
            kind: "extension" as const,
            value: row.packageName,
            label: `${STATE_MARK[row.state]} ${row.title}`,
            detail: [
              installLabel(row),
              row.version !== undefined ? `v${row.version}` : "",
              row.keyConflict !== undefined ? `key ${row.key} is taken by ${row.keyConflict}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            disabled: row.state === "installed",
          })),
          selected: 0,
          fromMenu: true,
        })
      })
      .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
  }, [config.extension, extensions, keymap, flash])

  /*
   * Memasang dari picker: unduh dulu, TULIS config sesudahnya.
   *
   * Urutan itu yang menentukan. Ditulis lebih dulu, unduhan yang gagal
   * meninggalkan config yang menyebut extension yang tidak ada — dan sesi
   * berikutnya membuka dengan notice kegagalan untuk sesuatu yang user tidak
   * tahu pernah tercatat.
   */
  const installFromPicker = useCallback(
    (packageName: string): void => {
      flash(`installing ${packageName} …`)
      void installExtension({ packageName })
        .then((result) => {
          if (config.extension[packageName] === undefined) {
            editConfigFile(globalConfigFile(), ["extension", packageName], {})
          }
          flash(`${packageName}@${result.version} installed — restart Titah to load it`)
        })
        .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
    },
    [config.extension, flash],
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

  /**
   * Daftar aksi leader, sebagai item menu.
   *
   * Aksi tanpa chord ber-leader DILEWATI: mencantumkannya berarti menawarkan
   * tombol yang tidak ada. Itu bisa terjadi kalau user mengganti binding-nya
   * jadi tombol polos lewat `keybinds`.
   */
  const leaderMenuEntries = useMemo(
    () =>
      buildLeaderMenu(
        extensions
          .filter((entry) => entry.key !== undefined)
          .map((entry) => ({ action: `extension:${entry.spec}`, describe: entry.panel.title })),
      ),
    [extensions],
  )

  const leaderItems = useCallback((): Suggestion[] => {
    const prefix = leaderName(keymap)
    return leaderMenuEntries.flatMap((entry) => {
      const key = leaderKeyFor(keymap, entry.action)
      if (key === undefined) return []
      return [
        {
          kind: "action" as const,
          value: entry.action,
          label: `${prefix} ${key}`,
          detail: entry.describe,
        },
      ]
    })
  }, [keymap, leaderMenuEntries])

  const openLeaderMenu = useCallback(() => {
    setPopup({ title: `${leaderName(keymap)} …`, items: leaderItems(), selected: 0, fromMenu: true })
  }, [keymap, leaderItems])

  const openCommandPalette = useCallback(() => {
    setPopup({
      title: "Commands",
      /*
       * Command DAN aksi leader dalam satu daftar.
       *
       * Aksi leader tidak punya nama yang bisa diketik — satu-satunya cara
       * menemukannya adalah menekan leader lalu menebak. Menaruhnya di sini
       * membuatnya bisa dicari seperti yang lain, lengkap dengan tombolnya,
       * dan `ctrl+p` jadi satu tempat untuk "apa saja yang bisa saya lakukan".
       */
      items: [
        ...listCommands(config).map((entry) => ({
          kind: "command" as const,
          value: `/${entry.name} `,
          label: `/${entry.name}`,
          detail: entry.description,
        })),
        ...leaderItems(),
      ],
      selected: 0,
      fromMenu: true,
    })
  }, [config, leaderItems])

  /**
   * Satu implementasi untuk setiap aksi leader.
   *
   * Dipakai DUA jalur: tombol yang ditekan setelah leader, dan pilihan dari
   * menu. Dua salinan berarti menu yang perlahan menyimpang dari tombolnya —
   * dan menu yang menjanjikan sesuatu yang berbeda dari yang terjadi lebih
   * buruk daripada tidak ada menu.
   */
  const runLeaderAction = useCallback(
    (action: Action): void => {
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
        case "subagents_panel":
          // TIDAK mereset `subagentSelected`: komentar di deklarasinya bilang
          // pilihan sengaja dipertahankan lewat tutup/buka.
          setSubagentPanelOpen((value) => !value)
          return
        case "panel_left":
          setLeftPanelOpen((value) => !value)
          return
        case "panel_right":
          setRightPanelOpen((value) => !value)
          return
        case "panel_refresh":
          setRefreshToken((value) => value + 1)
          return
        case "panel_focus":
          /*
           * Berputar hanya di antara sisi yang benar-benar TERGAMBAR.
           *
           * Memfokuskan sisi yang ditutup lantai berarti tombol menghilang ke
           * panel yang tidak ada di layar, dan satu-satunya jalan keluarnya Esc
           * yang tidak diketahui user sedang ia butuhkan.
           */
          setPanelFocus((current) => {
            const drawn = drawnPanels.current
            if (drawn.length === 0) {
              flash("no side panel is open")
              return undefined
            }
            const index = current === undefined ? -1 : drawn.indexOf(current)
            return drawn[index + 1]
          })
          return
        case "extension_picker":
          openExtensionPicker()
          return
        default:
          break
      }

      /*
       * Tombol extension membuka sisi MILIKNYA, bukan sisi yang terakhir aktif.
       *
       * Panel git yang duduk di kiri harus dibuka oleh tombolnya sendiri di
       * kiri; membukanya di sisi mana pun yang terakhir disentuh berarti tombol
       * yang sama melakukan hal berbeda tergantung riwayat yang tidak terlihat.
       */
      if (action.startsWith("extension:")) {
        const spec = action.slice("extension:".length)
        const owner = extensions.find((entry) => entry.spec === spec)
        if (owner?.side === "right") setRightPanelOpen((value) => !value)
        else if (owner !== undefined) setLeftPanelOpen((value) => !value)
        return
      }

      switch (action) {
        case "session_undo":
          void client
            .undo(session.id)
            .then((result) => flash(`undo: ${result.files.length} files restored`))
            .catch((error: unknown) =>
              flash(error instanceof Error ? error.message : String(error)),
            )
          return
        // Keduanya sudah punya penanganannya sejak lama lewat `/new` dan
        // `/session`; yang tidak ada hanyalah sambungan dari leader. Sebelum
        // ini `session_new` menjawab "not available yet" dan `session_list`
        // tidak menjawab apa pun — dua binding yang terdaftar tapi mati, dan
        // menu yang mencantumkannya akan berbohong.
        case "session_new":
          return startNewSession()
        case "session_list":
          return openSessionPicker()
        case "effort_cycle": {
          const next = nextEffort(effort)
          setEffort(next)
          return flash(
            next === "default"
              ? "conclusion: default — length is up to the model"
              : `conclusion: ${next}`,
          )
        }
        case "app_help":
          return openLeaderMenu()
        default:
          return
      }
    },
    [
      client,
      effort,
      exit,
      flash,
      mouse,
      mouseCapture,
      openExtensionPicker,
      openLeaderMenu,
      openSessionPicker,
      session.id,
      startNewSession,
    ],
  )

  /**
   * Menjalankan pilihan dari menu.
   *
   * Command tanpa argumen DIJALANKAN, bukan sekadar disisipkan — memilih
   * "/model" dari daftar lalu harus menekan Enter lagi adalah alasan orang
   * mengira fitur ini rusak.
   */
  const runSuggestion = useCallback(
    (item: Suggestion): void => {
      if (item.kind === "action") return runLeaderAction(item.value as Action)
      if (item.kind === "extension") return installFromPicker(item.value)
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
        if (name === "login") return startLogin()
        if (name === "logout") return doLogout()
        if (name === "account") return showAccount()
        if (name === "exit") return exit()
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
      doLogout,
      draft,
      flash,
      openAgentPicker,
      openModelPicker,
      openSessionPicker,
      openSkillPicker,
      send,
      showAccount,
      startLogin,
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
    const local = /^\/(model|skill|agent|session|new|login|logout|account|exit)\b\s*(.*)$/.exec(text)
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
      if (local[1] === "login") return startLogin()
      if (local[1] === "logout") return doLogout()
      if (local[1] === "account") return showAccount()
      // Diketik penuh, jadi maksudnya sudah jelas: tidak ada konfirmasi kedua
      // seperti ctrl+c. Yang perlu dijaga dari tekanan tak sengaja adalah
      // tombol, bukan perintah yang harus dieja lima huruf lalu Enter.
      if (local[1] === "exit") return exit()
      return openSkillPicker(local[2] ?? "")
    }

    setDraft("")
    setCursor(0)
    send(text)
  }, [doLogout, draft, exit, openAgentPicker, openModelPicker, openSessionPicker, openSkillPicker, remember, send, showAccount, startLogin, startNewSession, state.status])

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

  const armExit = useCallback(() => {
    setExitArmed(true)
    clearTimeout(exitTimer.current)
    exitTimer.current = setTimeout(() => setExitArmed(false), EXIT_CONFIRM_TIMEOUT)
  }, [])

  const armLeader = useCallback(() => {
    setLeaderActive(true)
    clearTimeout(leaderTimer.current)
    leaderTimer.current = setTimeout(() => {
      setLeaderActive(false)
      setLeaderMenu(false)
    }, LEADER_TIMEOUT)

    /*
     * Menu muncul SETELAH JEDA, bukan seketika.
     *
     * Inilah yang membuatnya menolong tanpa mengganggu. Yang hafal `ctrl+x d`
     * menekan dua tombol dalam sepersekian detik dan tidak pernah melihat menu
     * ini sama sekali; yang lupa berhenti sejenak, dan justru di jeda itulah ia
     * butuh daftarnya. Menampilkannya seketika membuat setiap penekanan leader
     * berkedip untuk orang yang tidak membutuhkannya.
     */
    clearTimeout(leaderMenuTimer.current)
    leaderMenuTimer.current = setTimeout(() => {
      setLeaderMenu(true)
      openLeaderMenu()
    }, LEADER_MENU_DELAY)
  }, [openLeaderMenu])

  useInput((input, key) => {
    const press = toKeyPress(input, key)

    /*
     * Senjata keluar dilucuti oleh tombol APA PUN selain ctrl+c.
     *
     * Dibaca lebih dulu ke variabel lokal karena `setExitArmed` tidak berlaku
     * seketika: cabang ctrl+c di bawah masih akan melihat nilai state yang
     * lama. Tanpa salinan ini, tekanan kedua tidak pernah terbaca sebagai
     * konfirmasi dan Titah tidak bisa ditutup sama sekali.
     */
    const wasExitArmed = exitArmed
    if (exitArmed && resolve(keymap, press, false, ["input_clear"]) !== "input_clear") {
      setExitArmed(false)
      clearTimeout(exitTimer.current)
    }

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
    /*
     * Panel yang fokus menerima tombol POLOS, dan hanya itu.
     *
     * Modifier dilewatkan supaya ctrl+c, ctrl+d, dan gulir riwayat tetap
     * bekerja tanpa harus melepas fokus lebih dulu — kalau tidak, memfokuskan
     * panel akan mengunci user keluar dari cara menghentikan giliran.
     *
     * Esc mengembalikan papan tombol tanpa menutup panelnya: yang diminta user
     * saat menekan Esc adalah bisa mengetik lagi, bukan kehilangan panel yang
     * baru saja ia buka.
     */
    if (panelFocus !== undefined && !state.permission && !state.question && !leaderActive) {
      const owner = extensions.find((entry) => entry.side === panelFocus)
      const plain = press.ctrl !== true && press.alt !== true
      if (owner === undefined) {
        setPanelFocus(undefined)
      } else if (press.key === "escape" && plain) {
        setPanelFocus(undefined)
        return
      } else if (plain) {
        const verdict = owner.panel.onKey?.({ key: press.key })
        if (verdict?.refresh === true) setRefreshToken((value) => value + 1)
        /*
         * Ditelan apa pun jawabannya, selama panel sedang fokus.
         *
         * Meneruskan tombol yang tidak dipakai panel ke editor berarti `b` di
         * panel git kadang berpindah tampilan dan kadang mengetik "b" ke prompt
         * — tergantung isi panel saat itu, yang user tidak bisa lihat.
         */
        return
      }
    }

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
      // `input_clear` ikut lolos: ctrl+c harus tetap bisa membersihkan prompt
      // dan mempersenjatai keluar walau panel sedang memegang papan ketik.
      if (resolve(keymap, press, false, ["leader", "app_exit", "input_clear"]) === undefined) {
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
      const action = resolve(keymap, press, true, leaderMenuEntries.map((entry) => entry.action))
      setLeaderActive(false)
      clearTimeout(leaderTimer.current)
      clearTimeout(leaderMenuTimer.current)
      // Menu ditutup lebih dulu: aksinya sendiri boleh membuka popup lain
      // (mis. pemilih sesi), dan menutup sesudahnya akan menutup yang itu.
      if (leaderMenu) setPopup(undefined)
      setLeaderMenu(false)
      if (action) runLeaderAction(action as Action)
      return
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

    // Satu penangan, dua tombol: `ctrl+r` dan `<leader>r` sama-sama bermuara ke
    // `runLeaderAction`, jadi tidak ada dua salinan logika putaran yang bisa
    // menyimpang.
    if (resolve(keymap, press, false, ["effort_cycle"]) === "effort_cycle") {
      runLeaderAction("effort_cycle")
      return
    }

    if (resolve(keymap, press, false, ["session_interrupt"]) === "session_interrupt") {
      // Login yang menunggu persetujuan dibatalkan lebih dulu. Ia satu-satunya
      // hal di layar yang sedang menunggu, dan Esc di depan panel yang berkata
      // "Esc cancels" harus membatalkan panel itu — bukan giliran di baliknya.
      if (cancelLogin()) return
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
      // Lebar yang SAMA dengan yang dipakai saat merender di bawah. Kalau
              // berbeda, jumlah baris untuk menghitung batas gulir tidak sama
              // dengan jumlah baris yang benar-benar tampil, dan gulirnya meleset.
              const totalLines = allLines(state.messages, expandTools, textWidth).length
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

    /*
     * ctrl+c: membersihkan prompt, dan HANYA itu. Keluar butuh dua kali.
     *
     * Sebelumnya satu tekanan pada prompt kosong langsung menutup Titah. Itu
     * salah satu tombol yang paling sering ditekan karena refleks — untuk
     * membatalkan ketikan, untuk menghentikan sesuatu — dan refleks yang
     * menutup sesi berjam-jam adalah kerugian yang tidak sebanding dengan
     * kemudahan yang ditawarkannya.
     *
     * Kalau ada teks, itu SATU-SATUNYA yang terjadi: prompt dibersihkan dan
     * tidak ada yang dipersenjatai. Orang yang membatalkan ketikan tidak sedang
     * setengah jalan menuju keluar, dan tekanan kedua untuk membersihkan sisa
     * ketikan berikutnya tidak boleh menutup aplikasi.
     */
    if (resolve(keymap, press, false, ["input_clear"]) === "input_clear") {
      if (draft !== "") {
        setDraft("")
        setCursor(0)
        setHistoryIndex(DRAFT)
        setExitArmed(false)
        return
      }
      if (wasExitArmed) return exit()
      armExit()
      return
    }

    /*
     * ctrl+d dan `<leader>q` TIDAK ikut butuh dua kali.
     *
     * Keduanya tidak punya arti lain di sini — tidak ada yang menekan ctrl+d
     * untuk membatalkan ketikan — jadi konfirmasi di sana hanya menambah satu
     * tekanan tanpa mencegah apa pun.
     */
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
  /*
   * Pembagian kolom dihitung SEKALI, dan tiga pemakainya membaca hasil yang
   * sama: lebar teks riwayat di bawah, lebar Box panel di render, dan notice
   * yang menjelaskan panel yang hilang. Tiga ekspresi terpisah untuk satu
   * pembagian adalah cara reservasi dan gambar menyimpang — catatan di
   * `subagentPanelHeight` di bawah mencatat kejadian yang sama pada tinggi.
   */
  const panels = panelLayout({
    columns: size.columns,
    floor: config.panel.floor,
    left: leftPanelOpen ? config.panel.left.width : 0,
    right: rightPanelOpen ? config.panel.right.width : 0,
  })
  const textWidth = Math.max(20, panels.content - 2)

  /*
   * Notice, bukan error. Panel yang tertutup karena terminal sempit adalah
   * keadaan yang bisa dibalik user dengan melebarkan jendelanya, dan satu baris
   * merah untuk hal yang tidak merusak apa pun mengajari orang mengabaikan
   * merah yang sungguhan.
   *
   * Kalimatnya datang dari `panels.ts`, satu tempat dengan yang MENUTUP panel:
   * notice yang disusun di sini akan menyebut sisi yang salah begitu urutan
   * penutupan di sana berubah. Dan karena ia string biasa, effect di bawah
   * hanya menyala saat kalimatnya benar-benar berubah — bukan setiap resize.
   */
  /*
   * Fokus dilepas kalau panelnya tidak lagi tergambar — ditutup user, ditutup
   * lantai, atau extension-nya gagal dimuat. Fokus yang tertinggal pada panel
   * yang hilang menelan setiap tombol polos tanpa ada apa pun di layar yang
   * menjelaskan kenapa.
   */
  useEffect(() => {
    if (panelFocus === undefined) return
    const width = panelFocus === "left" ? panels.left : panels.right
    if (width === 0 || !extensions.some((entry) => entry.side === panelFocus)) setPanelFocus(undefined)
  }, [panelFocus, panels.left, panels.right, extensions])

  drawnPanels.current = (["left", "right"] as const).filter(
    (side) =>
      (side === "left" ? panels.left : panels.right) > 0 && extensions.some((entry) => entry.side === side),
  )

  const droppedMessage = droppedNotice(panels.dropped, config.panel.floor)
  useEffect(() => {
    if (droppedMessage) flash(droppedMessage)
  }, [droppedMessage, flash])

  /*
   * Memuat extension sekali per sesi.
   *
   * Kegagalannya dilaporkan lewat notice dan tidak menjatuhkan apa pun — aturan
   * yang sama dengan plugin dan dengan server MCP yang mati.
   */
  useEffect(() => {
    let alive = true
    void loadExtensions({ config, cwd, version }).then((result) => {
      if (!alive) return
      setExtensions(result.extensions)
      if (result.failures.length > 0) flash(failureNotice(result.failures))
    })
    return () => {
      alive = false
    }
  }, [config, cwd, version, flash])

  /*
   * Empat pemicu refresh Q26, dan tiga di antaranya gratis di sini.
   *
   * `state.status` memberi DUA tepi sekaligus: idle→working adalah prompt yang
   * baru dikirim, working→idle adalah `session.idle`. Yang kedua yang paling
   * penting dan paling mudah terlewat — panel diff paling usang justru SESUDAH
   * agent menyunting berkas, bukan sebelum.
   *
   * Pemicu ketiga adalah panel yang dibuka. Yang keempat tombol manual, di
   * penanganan aksi `panel_refresh`.
   */
  useEffect(() => {
    setRefreshToken((value) => value + 1)
  }, [state.status, leftPanelOpen, rightPanelOpen])

  /*
   * Pengecekan update: satu request, lewat cache enam jam, hasilnya satu baris.
   * TIDAK pernah memasang apa pun — lihat `core/update.ts`.
   */
  useEffect(() => {
    let alive = true
    void checkUpdate({ current: version }).then((status) => {
      if (alive) setUpdateHint(updateNotice(status))
    })
    return () => {
      alive = false
    }
  }, [version])

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
      <Working
        tick={tick}
        step={step}
        sinceStep={tick - stepStarted.current.tick}
        elapsed={Math.max(0, Math.round((Date.now() - startedAt) / 1000))}
        {...(runningAgent ? { agent: runningAgent } : {})}
      />
    ) : null
  // Didefinisikan SEKALI dan dipasang di kedua cabang render, seperti popupBox.
  // Layar pembuka punya `return` sendiri, dan sebuah overlay yang hanya dipasang
  // di cabang bawah tidak akan pernah terlihat oleh orang yang baru membuka
  // Titah — justru saat `/login` paling mungkin diketik.
  const loginBox = loginProgress ? <LoginPanel progress={loginProgress} /> : null

  /*
   * Riwayat ditata ulang jauh lebih jarang daripada spinner berputar.
   *
   * Bulatan langkah berjalan punya empat bingkai; pada tiap detak ketiga ia
   * menyelesaikan satu putaran per ~1.2 detik — cukup untuk terbaca sebagai
   * gerak, dan itu memang seluruh tugasnya. Mengikutkannya ke 100ms berarti
   * menata ulang SELURUH riwayat sepuluh kali per detik demi glyph yang tidak
   * akan terlihat lebih hidup.
   *
   * `useMemo`-nya yang membuat spinner cepat itu terjangkau: tanpa ini setiap
   * detak melewati `allLines` lagi, termasuk mengurai markdown tiap jawaban.
   */
  /*
   * Label status: agent · model · tingkat kesimpulan.
   *
   * Tingkatnya hanya muncul kalau BUKAN `default`. Mode yang tidak terlihat
   * adalah mode berbahaya — tapi mode yang tidak pernah diubah siapa pun juga
   * tidak layak memakan tempat di baris yang sudah padat. Yang ditampilkan
   * adalah penyimpangan dari bawaan, bukan seluruh keadaan.
   */
  const statusLabel = [activeAgent, model, effort === "default" ? undefined : `⌁${effort}`]
    .filter(Boolean)
    .join(" · ")

  /*
   * Bulatan langkah ikut detak PENUH lagi.
   *
   * Ia sempat dibagi tiga ketika detaknya 100ms, supaya riwayat tidak ditata
   * ulang sepuluh kali per detik. Pada 250ms pembagian itu justru merugikan:
   * empat bingkai × 750ms adalah tiga detik per putaran, dan langkah yang
   * berputar setiap tiga detik terlihat macet, bukan sibuk. Empat bingkai pada
   * 250ms pas satu putaran per detik.
   *
   * `useMemo`-nya tetap berguna walau kuncinya kini `tick`: setiap ketikan,
   * setiap resize, dan setiap event yang bukan detak tidak lagi mengurai ulang
   * markdown seluruh riwayat.
   */
  const lines = useMemo(
    () => allLines(state.messages, expandTools, textWidth, tick),
    [state.messages, expandTools, textWidth, tick],
  )
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
  // Diukur dari `loginLines` yang SAMA dengan yang dirender, bukan dari angka
  // yang ditulis tangan di sini — itulah cara reservasi dan render menyimpang
  // diam-diam, sebagaimana sudah pernah terjadi pada panel sub-agent di atas.
  // Judul + dua baris bingkai.
  const loginHeight = loginProgress ? loginLines(loginProgress).length + 3 : 0
  const withMark = shouldShowMark(size.columns, size.rows)
  /*
   * Tingginya DITANYAKAN kepada yang menggambarnya, bukan dihitung ulang di
   * sini. Header tiga kolom punya baris pembatas yang tidak ada di header lama,
   * dan angka yang dihitung terpisah lalu dipercaya tetap cocok adalah cara
   * baris teratas riwayat terpotong diam-diam.
   */
  const headerHeight =
    withMark && fitsWideHeader(size.columns, markLines())
      ? headerLines({ columns: size.columns, logo: markLines(), cwd, model }).length
      : withMark
        ? markLines().length + 2
        : 4
  const available = historyRows(
    size.rows,
    editorHeight +
      permissionHeight +
      questionHeight +
      popupHeight +
      workingHeight +
      subagentPanelHeight +
      loginHeight,
    headerHeight,
  )
  const window = viewport(lines, available, scroll)

  /*
   * Props satu panel, dibangun dari SATU tempat untuk kedua sisi.
   *
   * Judulnya datang dari extension yang termuat, dan `PANEL_EMPTY` yang muncul
   * kalau tidak ada — jadi sisi yang terbuka tanpa extension mengatakan
   * keadaannya alih-alih menggambar kotak kosong yang terlihat seperti bug.
   */
  const panelProps = (side: "left" | "right") => {
    const extension = extensions.find((entry) => entry.side === side)
    const content = panelContent[side]
    return {
      side,
      width: side === "left" ? panels.left : panels.right,
      rows: available,
      title: extension?.panel.title ?? (side === "left" ? "Left" : "Right"),
      focused: panelFocus === side,
      lines: content?.error !== undefined ? [...content.lines, ...errorLines(content.error)] : (content?.lines ?? []),
    }
  }

  /*
   * Menjalankan render untuk sisi yang benar-benar TERGAMBAR.
   *
   * Bergantung pada `panels.left`/`panels.right` dan bukan pada state buka/tutup
   * milik user: panel yang ditutup lantai tidak digambar, dan menjalankan
   * render-nya berarti membayar `git worktree list` untuk sesuatu yang tidak
   * akan terlihat.
   */
  useEffect(() => {
    let alive = true
    for (const side of ["left", "right"] as const) {
      const width = side === "left" ? panels.left : panels.right
      const extension = extensions.find((entry) => entry.side === side)
      if (width === 0 || extension === undefined) continue

      void renderPanel({ extension, width, rows: available }).then((result) => {
        if (!alive) return
        setPanelContent((current) => ({
          ...current,
          // Baris lama dipertahankan saat render gagal. Lihat komentar
          // deklarasi `panelContent`.
          [side]: result.error === undefined ? result : { lines: current[side]?.lines ?? [], error: result.error },
        }))
      })
    }
    return () => {
      alive = false
    }
  }, [extensions, panels.left, panels.right, available, refreshToken])



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
        {/* Panel ikut digambar DI SINI juga, bukan hanya sesudah percakapan
            dimulai. Layar pembuka adalah tempat orang pertama kali mencoba
            tombolnya — panel yang tidak muncul di situ terbaca sebagai
            extension yang gagal dipasang, bukan sebagai layar yang berbeda.

            `columns` yang diteruskan ke Splash adalah kolom TENGAH, supaya
            logo dan prompt terpusat di ruang yang benar-benar tersisa. */}
        <Box flexDirection="row" flexGrow={1}>
          {panels.left > 0 ? <Panel {...panelProps("left")} /> : null}
          <Box flexDirection="column" flexGrow={1}>
        <Splash
          columns={panels.content}
          rows={size.rows}
          /* Diputuskan dari kolom TENGAH, bukan dari lebar terminal.
             Dengan panel terbuka, `size.columns` menjanjikan ruang yang sudah
             diambil panel — jadi Titah memilih logo besar lalu menggambarnya di
             kolom yang lebih sempit, dan huruf pertamanya terpotong. */
          showLogo={shouldShowLogo(panels.content, size.rows)}
          cwd={cwd}
          model={model}
          {...(activeAgent ? { agent: activeAgent } : {})}
          editor={
            <>
              {loginBox}
              {subagentPanelBox}
              {popupBox}
              {editorBox}
            </>
          }
        />
          </Box>
          {panels.right > 0 ? <Panel {...panelProps("right")} /> : null}
        </Box>
        {/* Footer juga di sini: ia satu-satunya tempat keadaan leader dan pesan
            flash terlihat, dan layar pembuka adalah tempat orang pertama kali
            mencoba keybinding. */}
        <Footer
          status={state.status}
          model={statusLabel}
          usage={usage}
          leaderActive={leaderActive}
          exitArmed={exitArmed}
          {...(notice ? { hint: notice } : updateHint ? { hint: updateHint } : {})}
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
        {...(accountName ? { account: accountName } : {})}
      />

      {/* Baris, bukan kolom: `flexGrow` di sini mengambil sisa TINGGI dari
          kolom luar, sementara `flexGrow` milik History mengambil sisa LEBAR di
          dalam baris ini. Panel punya lebar eksplisit dan `flexShrink={0}`,
          jadi yang mengalah saat ruang kurang selalu riwayat — dan lantai yang
          memastikan ia tidak mengalah terlalu jauh.

          Dialog izin, editor, dan footer sengaja TIDAK ikut ke dalam baris ini:
          dialog izin yang menyempit ke lebar riwayat akan memotong perintah
          yang justru sedang diminta persetujuannya. */}
      <Box flexDirection="row" flexGrow={1}>
        {panels.left > 0 ? <Panel {...panelProps("left")} /> : null}
        <History
          lines={window.lines}
          hiddenAbove={window.hiddenAbove}
          hiddenBelow={window.hiddenBelow}
          jumpHint={jumpKey}
        />
        {panels.right > 0 ? <Panel {...panelProps("right")} /> : null}
      </Box>

      {/* Ruang tunggu tetap: dua baris, selalu, apa pun panjang percakapannya
          dan di mana pun posisi gulirnya. `flexShrink={0}` yang menjaganya —
          tanpa itu, isi yang memanjang akan memerasnya habis, dan ruangnya
          justru hilang tepat saat layar penuh, yaitu saat digulir. Lihat
          `RESERVED_ROWS`. */}
      <Box height={RESERVED_ROWS} flexShrink={0} />

      {state.error ? <Text color="red">⚠ {state.error}</Text> : null}
      {/* Redup dan tanpa warna peringatan: ini informasi, bukan kegagalan, dan
          satu baris merah untuk hal yang tidak merusak apa pun mengajari user
          mengabaikan warna merah yang sungguhan. */}
      {state.notice ? <Text dimColor>· {state.notice}</Text> : null}
      {state.question ? <QuestionDialog request={state.question} /> : null}
      {state.permission ? <PermissionDialog request={state.permission} /> : null}
      {loginBox}

      {subagentPanelBox}
      {popupBox}
      {workingBox}
      {editorBox}
      <Footer
        status={state.status}
        model={statusLabel}
        usage={usage}
        leaderActive={leaderActive}
        exitArmed={exitArmed}
        {...(notice ? { hint: notice } : {})}
        mouseCapture={mouseCapture}
      />
    </Box>
  )
}

/**
 * Satu baris notice untuk extension yang gagal dimuat.
 *
 * Menyebut spec-nya, bukan hanya jumlahnya: "1 extension failed" menyuruh orang
 * mencari yang mana, dan pada dua sisi terpasang itu berarti menebak. Sisanya
 * dihitung karena satu baris footer tidak bisa memuat tiga pesan penuh.
 */
function failureNotice(failures: ExtensionFailure[]): string {
  const first = failures[0]
  const rest = failures.length - 1
  const tail = rest > 0 ? ` (+${rest} more)` : ""
  return `extension ${first?.spec}: ${first?.message}${tail}`
}

/**
 * Penanda tiga keadaan picker.
 *
 * Dibedakan secara VISUAL dan bukan hanya di teks keterangan: Enter berarti hal
 * berbeda pada masing-masing, dan tombol yang artinya berubah tanpa tampilan
 * yang membedakan barisnya adalah tombol yang orang tekan lalu menyesal.
 */
const STATE_MARK = { installed: "✓", configured: "↓", available: "+" } as const

export type { TuiState }
