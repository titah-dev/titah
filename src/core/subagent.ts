import path from "node:path"
import { abort, prompt, registerCancel } from "./agent.ts"
import { adapterFor } from "./delegate/index.ts"
import { bus } from "./event.ts"
import type { SubagentState } from "./event.ts"
import { textOf } from "./message.ts"
import { maySpawnExternal, type EffectivePermission } from "./permission.ts"
import type { Agent, Config } from "./schema.ts"
import { createChildSession } from "./storage/session.ts"

/**
 * Penjadwalan sub-agent.
 *
 * Dipisah dari agent.ts supaya bisa diuji tanpa model, tanpa sesi, dan tanpa
 * filesystem — kunci concurrency yang hanya bisa diuji lewat giliran sungguhan
 * adalah kunci yang tidak pernah benar-benar diuji.
 */

/**
 * Pembaca boleh jalan serentak tanpa batas; selain itu penulis, dan penulis antre.
 *
 * `bash` ikut dihitung: shell yang diizinkan bisa `sed -i`, dan memperlakukannya
 * sebagai pembaca membuka pintu belakang ke persoalan yang serialisasi ini ada
 * untuk mencegahnya. Izin yang TIDAK disebut juga bukan deny — ia mewarisi
 * kebijakan global, yang defaultnya "ask".
 */
export function isReader(agent: Agent): boolean {
  // Agent yang men-delegate SELALU penulis, apa pun isi `permission`-nya.
  //
  // Blok izin Titah tidak pernah sampai ke CLI eksternal: mesin itu punya
  // kebijakannya sendiri dan menyunting berkas tanpa bertanya ke sini. Kalau
  // blok itu tetap dibaca, "mengeraskan" agent dengan edit/write/bash serba
  // deny justru MELEPASKANNYA dari kunci tulis — ia lalu jalan berbarengan
  // dengan penulis lain di direktori yang sama sementara CLI-nya benar-benar
  // mengubah pohon kerja, dan snapshot yang diambil di tengah itu membuat
  // `/undo` mengembalikan campuran dua pekerjaan. Justru usaha user untuk
  // lebih aman yang memicu kerusakannya.
  if (agent.delegate !== undefined) return false

  const permission = agent.permission
  if (!permission) return false
  return permission.edit === "deny" && permission.write === "deny" && permission.bash === "deny"
}

/** Ekor antrean penulis per direktori kerja. */
const tail = new Map<string, Promise<unknown>>()

/**
 * Menjalankan `run` setelah penulis sebelumnya di direktori yang sama selesai.
 *
 * Kuncinya per DIREKTORI KERJA, bukan per sesi, karena repo bayangan snapshot
 * memang dikunci di situ. Dua penulis di direktori yang sama akan membuat satu
 * snapshot memuat perubahan keduanya bercampur, dan `/undo` kehilangan cara
 * memisahkan siapa mengubah apa.
 */
export function withWriteLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(cwd)
  const previous = tail.get(key) ?? Promise.resolve()

  // `previous` sendiri TIDAK PERNAH reject — nilai yang tersimpan di `tail`
  // selalu sudah lewat `.catch()` di bawah sebelum disimpan. Jadi cukup satu
  // handler; onRejected di sini tidak akan pernah terpanggil.
  const result = previous.then(run)
  tail.set(
    key,
    // Ini jaring pengamannya: menyerap rejection SEBELUM masuk `tail` supaya
    // giliran berikutnya tetap melihat ekor yang resolve. Kalau kegagalan
    // menahan kunci, satu sub-agent yang error membuat setiap penulis
    // berikutnya di direktori itu menggantung sampai sesi ditutup.
    result.catch(() => undefined),
  )
  return result
}

/** Agent yang boleh dijadikan bawahan. `primary` tidak pernah termasuk. */
export function dispatchableAgents(config: Config): string[] {
  return Object.entries(config.agent)
    .filter(([, agent]) => agent.mode === "subagent" || agent.mode === "all")
    .map(([id]) => id)
}

/**
 * Super agent yang siap ikut `/tim`: terdaftar, hidup, dan punya spesialis.
 *
 * Yang tanpa `specialist` DILEWATI, bukan dimasukkan dengan nama saja. `/tim`
 * membagi tugas berdasarkan spesialis; memasukkan yang tidak punya berarti
 * membaginya berdasarkan nama, dan nama tidak memberi tahu apa pun tentang
 * siapa yang paling cocok mengerjakan apa.
 */
export function teamAgents(config: Config): string[] {
  return Object.entries(config.externalAgent)
    .filter(([, agent]) => agent.enabled !== false && (agent.specialist ?? "") !== "")
    .map(([id]) => id)
}

/** Super agent yang terdaftar tapi tidak bisa ikut `/tim`, beserta sebabnya. */
export function teamSkipped(config: Config): { id: string; why: string }[] {
  return Object.entries(config.externalAgent)
    .filter(([, agent]) => agent.enabled !== false && (agent.specialist ?? "") === "")
    .map(([id]) => ({ id, why: "no `specialist` — /tim cannot tell what to give it" }))
}

export interface RunSubagentOptions {
  parentSessionID: string
  agentID: string
  instruction: string
  cwd: string
  config: Config
  signal: AbortSignal
  /**
   * Izin efektif induk. Sub-agent tidak pernah mendapat lebih dari ini.
   *
   * Opsional supaya pemanggil lama tetap sah, tapi `task` SELALU mengisinya —
   * dan tanpa isian itu batas induk tidak berlaku sama sekali.
   */
  parentPermission?: EffectivePermission
}

export interface SubagentResult {
  answer: string
  childSessionID: string
  status: "done" | "failed" | "stopped"
}

/**
 * Menjalankan satu sub-agent sampai selesai.
 *
 * Pembaca langsung jalan; penulis melewati `withWriteLock` lebih dulu. Statusnya
 * disiarkan ke stream sesi INDUK — TUI hanya berlangganan satu sesi, jadi
 * kemajuan anak yang hanya disiarkan ke sesinya sendiri tidak akan pernah terlihat.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
  /*
   * Super agent memakai jalur yang SAMA dengan agent internal ber-`delegate`.
   *
   * Definisi sintetis, bukan mesin kedua: yang membedakan keduanya hanya dari
   * mana nama CLI-nya datang — dari `agent.<id>.delegate` atau dari id
   * `externalAgent` itu sendiri. Sisanya identik, dan menyalin sesi anak,
   * penerbitan event panel, serta penanganan pembatalan ke tempat kedua berarti
   * dua tempat yang bisa diam-diam melenceng.
   */
  const external = options.config.externalAgent[options.agentID]
  const definition =
    options.config.agent[options.agentID] ??
    (external && external.enabled !== false
      ? ({ mode: "subagent", delegate: options.agentID, tools: {}, skills: [] } as unknown as Agent)
      : undefined)

  if (!definition || definition.mode === "primary") {
    return {
      answer: `Agent "${options.agentID}" is not dispatchable. Available: ${dispatchableAgents(options.config).join(", ") || "(none)"}.`,
      childSessionID: "",
      status: "failed",
    }
  }

  const child = createChildSession(options.parentSessionID, options.cwd, options.agentID)
  const startedAt = Date.now()

  const publish = (status: SubagentState["status"], note: string) => {
    bus.publish({
      type: "subagent.updated",
      sessionID: options.parentSessionID,
      child: { sessionID: child.id, agent: options.agentID, status, startedAt, note },
    })
  }

  const reader = isReader(definition)
  publish(reader ? "running" : "queued", reader ? "starting" : "waiting for a turn")

  /*
   * Satu handle pembatalan milik ANAK ini, dipakai oleh SEMUA jalur.
   *
   * Ada dua cara membatalkan, dan sebelumnya keduanya berakhir berbeda:
   * `Esc` membatalkan sinyal INDUK, sementara `x` di panel membatalkan sesi
   * ANAK lewat server. Karena setiap cabang di bawah hanya membaca
   * `options.signal`, pembatalan lewat panel tidak pernah terbaca sebagai
   * pembatalan — hasilnya jatuh ke cabang error dan koordinator diberi tahu
   * agent-nya GAGAL, lalu bisa saja mengulangi kerja yang baru saja
   * dihentikan user. Handle ini membuat kedua jalur bertemu di satu tempat.
   */
  const control = new AbortController()
  const cancelled = () => control.signal.aborted

  // Disiarkan SEGERA begitu handle ini dibatalkan, dari arah mana pun — bukan
  // menunggu `work()` mendapat gilirannya lewat `withWriteLock`. Sub-agent
  // yang masih QUEUED bisa menunggu lama sebelum antreannya mulai; tanpa ini,
  // baris di panel terlihat mati sampai antrean itu akhirnya jalan, padahal
  // pembatalannya sudah terjadi detik itu juga. Publish dobel untuk
  // `sessionID` yang sama tidak berbahaya — reducer di `state.ts` menimpa
  // baris berdasarkan `sessionID`.
  //
  // Cabang `cancelled()` di dalam `work()` TETAP WAJIB ada meski publish ini
  // sudah terjadi — bukan basa-basi untuk kasus tanpa antrean. Publish yang
  // mendarat SETELAH abort ini bisa menimpa baris "stopped" balik ke
  // "running": `publish("running", "working")` begitu `work()` mulai, dan
  // `onUpdate` sub-agent ber-delegate yang masih boleh mengirim satu update
  // tool terakhir sementara proses eksternalnya baru menutup. Tanpa cabang
  // `cancelled()` di `work()` menangkap keduanya dan mempublikasikan
  // "stopped" lagi, baris itu tersangkut `◐ running ...` selamanya walau
  // sub-agent-nya sudah benar-benar berhenti.
  control.signal.addEventListener("abort", () => publish("stopped", "stopped by user"), {
    once: true,
  })

  const work = async (): Promise<SubagentResult> => {
    // `withWriteLock` menunda `run`-nya lewat `.then()` bahkan saat antrean
    // kosong — itu SATU microtask, bukan nol. Kalau pembatalan datang tepat di
    // jendela itu, tanpa pengecekan ini giliran anak tetap mulai lewat
    // `prompt()` dan menghabiskan kerja yang seharusnya sudah dibatalkan,
    // padahal hasilnya toh akan dilabeli "stopped" juga di bawah.
    if (cancelled()) {
      publish("stopped", "stopped by user")
      return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
    }

    publish("running", "working")
    try {
      // Agent yang men-delegate memakai CLI eksternal sebagai mesinnya, bukan
      // loop model Titah sendiri — lihat `Agent.delegate` di schema.ts. Cabang
      // ini duduk di DALAM `try` yang sama dengan `prompt()` di bawah supaya
      // `adapter.prompt()` yang reject (CLI tidak terpasang, timeout, dibunuh
      // abort) jatuh ke `catch` yang sama: satu tempat yang menegakkan kontrak
      // "tidak pernah melempar" untuk kedua mesin, bukan dua tempat yang bisa
      // diam-diam melenceng satu sama lain.
      if (definition.delegate !== undefined) {
        /*
         * Induk yang tidak boleh menulis tidak boleh menjalankan CLI eksternal
         * atas namanya.
         *
         * Blok izin Titah tidak pernah sampai ke sana — CLI itu punya
         * kebijakannya sendiri dan menyunting berkas tanpa bertanya. Jadi
         * membiarkannya jalan berarti `plan` bisa mengubah repo lewat pintu
         * yang tidak punya kunci sama sekali. Menolaknya lebih jujur daripada
         * berpura-pura membatasi.
         */
        if (options.parentPermission && !maySpawnExternal(options.parentPermission)) {
          const note = `blocked: "${options.agentID}" runs an external CLI`
          publish("failed", note)
          return {
            answer:
              `Refused: "${options.agentID}" runs through the external CLI ` +
              `"${definition.delegate}", and the agent dispatching it may not write files. ` +
              "Titah's permission block never reaches an external CLI, so it cannot be " +
              "held to that limit — it is refused instead of pretending.",
            childSessionID: child.id,
            status: "failed",
          }
        }

        const adapter = adapterFor(options.config, definition.delegate)
        if (!adapter) {
          const note = `unknown external agent "${definition.delegate}"`
          publish("failed", note)
          return {
            answer: `Agent "${options.agentID}" delegates to "${definition.delegate}", which is not defined in \`externalAgent\`.`,
            childSessionID: child.id,
            status: "failed",
          }
        }

        // Sengaja TANPA `resumeSessionID`: sub-agent diberi satu tugas, dan
        // memakai sesi eksternal yang sudah dipetakan akan membiasnya dengan
        // percakapan yang tidak pernah ia diberitahu.
        const delegated = await adapter.prompt({
          prompt: options.instruction,
          cwd: options.cwd,
          // Sinyal milik ANAK, bukan milik induk: inilah yang membuat `x` di
          // panel benar-benar membunuh subprocess-nya.
          signal: control.signal,
          onUpdate: (update) => {
            if (update.kind === "tool") publish("running", `running ${update.name}`)
          },
        })

        if (cancelled()) {
          publish("stopped", "stopped by user")
          return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
        }

        const note = delegated.isError ? (delegated.errorMessage ?? "failed") : "done"
        publish(delegated.isError ? "failed" : "done", note)
        return {
          answer: delegated.isError
            ? `FAILED: ${delegated.errorMessage ?? "no explanation"}`
            : delegated.answer,
          childSessionID: child.id,
          status: delegated.isError ? "failed" : "done",
        }
      }

      const message = await prompt({
        sessionID: child.id,
        text: options.instruction,
        agent: options.agentID,
        ...(options.parentPermission ? { permissionCeiling: options.parentPermission } : {}),
      })

      if (cancelled()) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }

      // `prompt()` tidak melempar untuk kegagalan giliran biasa — ia menangkap
      // sendiri dan mengembalikan pesan dengan `.error` terisi. Tanpa
      // pengecekan ini, giliran yang sungguh gagal (bukan dibatalkan) akan
      // dilaporkan "done" dengan jawaban kosong.
      if (message.error !== undefined) {
        publish("failed", message.error)
        return { answer: `FAILED: ${message.error}`, childSessionID: child.id, status: "failed" }
      }

      publish("done", "done")
      return { answer: textOf(message).trim(), childSessionID: child.id, status: "done" }
    } catch (error) {
      if (cancelled()) {
        publish("stopped", "stopped by user")
        return { answer: stoppedNote(startedAt), childSessionID: child.id, status: "stopped" }
      }
      const reason = error instanceof Error ? error.message : String(error)
      publish("failed", reason)
      return { answer: `FAILED: ${reason}`, childSessionID: child.id, status: "failed" }
    }
  }

  // Sinyal induk membatalkan giliran anak lewat handle milik sesi anak.
  // Didaftarkan SEBELUM `work` dipanggil, dan `prompt()` mendaftarkan
  // controller giliran anak secara sinkron sebelum await pertamanya — jadi
  // abort yang datang segera setelah fungsi ini dipanggil tidak pernah jatuh
  // di jendela kosong tanpa pendengar (lihat pengecekan di awal `work` untuk
  // jendela `withWriteLock` yang tersisa).
  const stop = () => control.abort()
  // Sinyal yang SUDAH aborted tidak pernah memanggil listener barunya, jadi
  // giliran yang dibatalkan sebelum `task` sempat dijalankan akan berjalan
  // penuh kalau hanya listener yang dipasang. Diteruskan langsung di sini.
  if (options.signal.aborted) stop()
  else options.signal.addEventListener("abort", stop, { once: true })

  // Handle anak juga dipublikasikan lewat `registerCancel`, supaya
  // `abort(childSessionID)` dari server (tombol `x` di panel) menemukannya —
  // termasuk untuk sub-agent ber-delegate, yang tidak pernah masuk ke peta
  // `running` milik `prompt()` sama sekali.
  const release = registerCancel(child.id, control)

  // Giliran internal berjalan di controller milik `prompt()` sendiri; ia harus
  // ikut dihentikan begitu handle anak dibatalkan, dari arah mana pun.
  control.signal.addEventListener("abort", () => abort(child.id), { once: true })

  try {
    return reader ? await work() : await withWriteLock(options.cwd, work)
  } finally {
    options.signal.removeEventListener("abort", stop)
    release()
  }
}

function stoppedNote(startedAt: number): string {
  return `STOPPED BY USER after ${Math.round((Date.now() - startedAt) / 1000)}s.`
}
