/**
 * Pelacakan mouse mode SGR.
 *
 * Urutan mouse HARUS disaring sebelum Ink melihatnya. Ink mengurai byte stdin
 * sebagai tombol, dan urutan mouse diawali ESC — satu klik akan terbaca sebagai
 * Escape, yang di Titah terikat ke `session_interrupt`. Tanpa penyaringan ini,
 * mengklik sesuatu akan MEMBATALKAN giliran yang sedang berjalan.
 */

export interface MouseEvent {
  kind: "press" | "release" | "wheel-up" | "wheel-down"
  /** Kolom dan baris berbasis 1, seperti yang dikirim terminal. */
  x: number
  y: number
}

/**
 * 1000 = lapor tekan/lepas. 1006 = koordinat SGR.
 *
 * Mode SGR dipakai karena mode X10 lama mengkodekan koordinat sebagai satu byte
 * dengan offset 32, sehingga kolom di atas 223 tidak bisa diwakili sama sekali.
 *
 * Mode 1002 (seret) sengaja TIDAK dinyalakan: ia membanjiri stdin dengan laporan
 * tiap piksel gerakan, dan Titah tidak punya satu pun fitur yang memakainya.
 */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1006h"
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l"

const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g

/**
 * Ekor yang jelas-jelas urutan mouse setengah jadi.
 *
 * Sengaja menuntut `ESC [ <` lengkap. Menahan ESC telanjang akan lebih aman
 * kelihatannya, tapi ESC telanjang ITULAH tombol Escape — menahannya membuat
 * pembatalan giliran berhenti bekerja, dan tidak ada urutan tombol lain yang
 * diawali `ESC [ <`.
 */
const PARTIAL = /\u001b\[<[\d;]*$/

const WHEEL = 64
const MOTION = 32

function classify(code: number, final: string): MouseEvent["kind"] | undefined {
  if ((code & WHEEL) !== 0) return (code & 1) === 0 ? "wheel-up" : "wheel-down"
  // Gerakan/seret tidak diminta, tapi sebagian terminal tetap mengirimkannya.
  if ((code & MOTION) !== 0) return undefined
  return final === "M" ? "press" : "release"
}

export interface Filtered {
  events: MouseEvent[]
  /** Byte yang tersisa untuk Ink, sudah bersih dari urutan mouse. */
  text: string
}

/**
 * Membuat penyaring yang stateful.
 *
 * State-nya perlu karena satu urutan mouse bisa terbelah antar chunk stdin.
 */
export function createMouseFilter(): (chunk: string) => Filtered {
  let pending = ""

  return (chunk: string): Filtered => {
    const input = pending + chunk
    pending = ""

    const events: MouseEvent[] = []
    let text = input.replace(SGR, (_match, code: string, x: string, y: string, final: string) => {
      const kind = classify(Number(code), final)
      if (kind) events.push({ kind, x: Number(x), y: Number(y) })
      return ""
    })

    const partial = PARTIAL.exec(text)
    if (partial) {
      pending = partial[0]
      text = text.slice(0, partial.index)
    }

    return { events, text }
  }
}

/** Sumber event mouse, supaya App bisa diuji tanpa terminal sungguhan. */
export interface MouseSource {
  subscribe(handler: (event: MouseEvent) => void): () => void
  /**
   * Menyalakan/mematikan pelacakan di terminal. Kosong pada sumber uji, yang
   * tidak punya terminal untuk diberi tahu.
   */
  setCapture?(enabled: boolean): void
}

export function createMouseSource(): MouseSource & { emit(event: MouseEvent): void } {
  const handlers = new Set<(event: MouseEvent) => void>()
  return {
    subscribe(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(event) {
      for (const handler of handlers) handler(event)
    },
  }
}
