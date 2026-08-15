import assert from "node:assert/strict"
import test from "node:test"
import {
  PROGRESS_INTERVAL_MS,
  PROGRESS_LINES,
  tailOf,
  throttleProgress,
} from "../src/core/progress.ts"

/** Jam palsu: waktu dikendalikan test, bukan ditunggu. */
function clock() {
  let at = 0
  const pending: { run: () => void; when: number }[] = []
  return {
    now: () => at,
    schedule: ((run: () => void, delay: number) => {
      const entry = { run, when: at + delay }
      pending.push(entry)
      return entry as never
    }) as unknown as typeof setTimeout,
    advance(ms: number) {
      at += ms
      for (const entry of [...pending]) {
        if (entry.when > at) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.run()
      }
    },
  }
}

// ---------- ekor ----------

test("hanya beberapa baris TERAKHIR yang disimpan", () => {
  const text = Array.from({ length: 100 }, (_, i) => `baris ${i}`).join("\n")
  const tail = tailOf(text)
  assert.equal(tail.split("\n").length, PROGRESS_LINES)
  assert.match(tail, /baris 99$/)
  assert.equal(tail.includes("baris 50"), false)
})

test("baris kosong di ekor dibuang lebih dulu", () => {
  /*
   * Keluaran perintah hampir selalu berakhir dengan newline. Tanpa ini, baris
   * terakhir yang terlihat selalu kosong — satu dari lima baris terbuang untuk
   * tidak menampilkan apa pun.
   */
  assert.equal(tailOf("a\nb\n\n\n"), "a\nb")
  assert.equal(tailOf("   \n\n"), "", "yang isinya cuma spasi berarti belum ada kabar")
})

test("baris tunggal yang sangat panjang dipotong keras", () => {
  // Progress bar dan base64 datang sebagai satu baris sepanjang megabyte.
  const tail = tailOf("x".repeat(10_000))
  assert.ok(tail.length <= 2049, `masih ${tail.length}`)
  assert.ok(tail.startsWith("…"), "terlihat terpotong")
})

// ---------- pembatasan laju ----------

test("potongan yang datang beruntun DIGABUNG, bukan dibuang", () => {
  /*
   * Ini yang membedakan pembatas laju dari pembuang. Yang dikurangi
   * frekuensinya, bukan isinya — kalau isinya ikut hilang, yang terlihat di
   * layar bukan keluaran perintah melainkan cuplikan acaknya.
   */
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })

  p.push("satu\n")
  p.push("dua\n")
  p.push("tiga\n")
  p.flush()

  assert.equal(seen.at(-1), "satu\ndua\ntiga", "semua isinya sampai")
})

test("seribu potongan dalam satu detik tidak jadi seribu terbitan", () => {
  /*
   * `npm test` memuntahkan ribuan potongan dalam beberapa detik. Menerbitkan
   * tiap potongan berarti ribuan render Ink dan layar yang kedip-kedip —
   * keluhan yang sudah pernah muncul di TUI ini dan sudah diperbaiki sekali.
   */
  const c = clock()
  let count = 0
  const p = throttleProgress(() => (count += 1), { now: c.now, schedule: c.schedule })

  for (let i = 0; i < 1000; i += 1) {
    p.push(`baris ${i}\n`)
    c.advance(1)
  }
  p.flush()

  const batas = Math.ceil(1000 / PROGRESS_INTERVAL_MS) + 2
  assert.ok(count <= batas, `${count} terbitan, seharusnya ≤ ${batas}`)
  assert.ok(count >= 2, "tapi bukan berarti diam sama sekali")
})

test("terbitan PERTAMA tidak ditunda", () => {
  /*
   * Perintah yang mencetak sesuatu lalu diam berjam-jam adalah kasus yang
   * paling butuh kabar. Menunda yang pertama membuat justru kasus itu terlihat
   * menggantung, tanpa alasan.
   */
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })

  p.push("mulai\n")
  assert.deepEqual(seen, ["mulai"], "langsung, tanpa menunggu interval")
})

test("flush menerbitkan sisa yang tertahan", () => {
  // Potongan di jendela terakhir belum terbit, dan justru itu yang biasanya
  // berisi hasilnya.
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })

  p.push("awal\n")
  c.advance(10)
  p.push("HASIL AKHIR\n")
  assert.equal(seen.length, 1, "yang kedua masih tertahan")

  p.flush()
  assert.match(seen.at(-1) ?? "", /HASIL AKHIR/)
})

test("setelah flush, potongan yang telat tidak menerbitkan apa pun", () => {
  /*
   * Anak proses yang dibunuh masih bisa memuntahkan sisa buffer sesudah tool
   * dilaporkan selesai. Kalau itu terbit, state `running` menimpa `completed` —
   * dan tool yang sudah selesai kembali terlihat sedang berjalan, selamanya.
   */
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })

  p.push("a\n")
  p.flush()
  const sesudah = seen.length

  p.push("telat\n")
  c.advance(1000)
  assert.equal(seen.length, sesudah, "tidak ada terbitan baru")
})

test("flush dua kali tidak menerbitkan dua kali", () => {
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })
  p.push("a\n")
  p.flush()
  p.flush()
  assert.equal(seen.length, 1)
})

test("tidak ada keluaran sama sekali berarti tidak ada terbitan", () => {
  // Tool yang diam tidak boleh memunculkan blok kosong di bawah namanya.
  const c = clock()
  const seen: string[] = []
  const p = throttleProgress((tail) => seen.push(tail), { now: c.now, schedule: c.schedule })
  p.flush()
  assert.deepEqual(seen, [])
})
