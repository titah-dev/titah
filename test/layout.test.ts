import assert from "node:assert/strict"
import test from "node:test"
import {
  allLines,
  editorRows,
  historyRows,
  messageLines,
  promptLabel,
  viewport,
} from "../src/tui/layout.ts"
import { logoLines, logoWidth, markLines, shouldShowLogo } from "../src/tui/logo.ts"
import type { Message } from "../src/core/message.ts"

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  sessionID: "ses",
  role: "assistant",
  created: 1,
  parts: [],
  ...overrides,
})

// ---------- perataan pesan ----------

test("prompt user jadi blok bertepi, teks multi-baris tetap utuh", () => {
  const lines = messageLines(
    message("m", { role: "user", parts: [{ type: "text", text: "baris satu\nbaris dua" }] }),
    false,
  ).filter((line) => line.kind !== "blank")

  // Talang kiri dua kolom, dengan bulatan di baris pertama tiap bagian: huruf
  // tidak menempel tepi terminal, dan batas tiap bagian terlihat tanpa dibaca.
  assert.equal(lines[0]?.text, "⏺ ┌─ you ")
  assert.equal(lines[0]?.kind, "user-head")
  assert.equal(lines[1]?.text, "  │ baris satu")
  assert.equal(lines[2]?.text, "  │ baris dua")
  assert.equal(lines[1]?.kind, "user")
  assert.equal(lines.at(-1)?.text, "  └─")
})

test("blok prompt diberi label sesuai jenisnya", () => {
  // Saat menggulir riwayat panjang, yang dicari biasanya "di mana saya menyuruh
  // ini" — dan perintah terlihat sangat berbeda dari pertanyaan biasa.
  assert.equal(promptLabel("apa kabar"), "you")
  assert.equal(promptLabel("/compact"), "command")
  assert.equal(promptLabel("  /model gpt"), "command")
  assert.equal(promptLabel("@claude tolong cek"), "delegated")
})

test("blok prompt tidak bisa diklik seperti blok tool", () => {
  const lines = messageLines(
    message("m", { role: "user", parts: [{ type: "text", text: "halo" }] }),
    false,
  )
  assert.ok(lines.every((line) => line.toolID === undefined))
})

test("tool selesai diringkas satu baris, isinya hanya muncul saat dibuka", () => {
  const withTool = message("m", {
    parts: [
      {
        type: "tool",
        callID: "c1",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          title: "read a.ts (10 baris)",
          output: "baris1\nbaris2\nbaris3",
          truncated: false,
          started: 1,
          ended: 2,
        },
      },
    ],
  })

  const tertutup = messageLines(withTool, false).filter((line) => line.kind !== "blank")
  assert.equal(tertutup.length, 1)
  assert.match(tertutup[0]?.text ?? "", /✓ read a\.ts \(10 baris\) …$/)

  const terbuka = messageLines(withTool, true).filter((line) => line.kind !== "blank")
  assert.equal(terbuka.length, 4, "judul + tiga baris isi")
  assert.match(terbuka[1]?.text ?? "", /│ baris1/)
})

test("tool ditolak dan gagal menampilkan alasannya", () => {
  const ditolak = messageLines(
    message("m", {
      parts: [
        {
          type: "tool",
          callID: "c",
          tool: "write",
          state: {
            status: "denied",
            input: {},
            title: "write a.txt",
            reason: "tidak ada klien",
            started: 1,
            ended: 2,
          },
        },
      ],
    }),
    false,
  )
  assert.match(ditolak[0]?.text ?? "", /⊘ write a\.txt/)
  assert.match(ditolak[1]?.text ?? "", /tidak ada klien/)
})

test("kunci baris unik supaya React tidak bingung", () => {
  const lines = allLines(
    [
      message("a", { parts: [{ type: "text", text: "satu\ndua" }] }),
      message("b", { parts: [{ type: "text", text: "satu\ndua" }] }),
    ],
    false,
  )
  const keys = lines.map((line) => line.key)
  assert.equal(new Set(keys).size, keys.length)
})

// ---------- viewport ----------

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: "assistant" as const, text: `b${i}`, key: `k${i}` }))

test("riwayat yang muat ditampilkan utuh tanpa penunjuk gulir", () => {
  const window = viewport(lines(5), 10, 0)
  assert.equal(window.lines.length, 5)
  assert.equal(window.hiddenAbove, 0)
  assert.equal(window.hiddenBelow, 0)
})

test("scroll 0 menempel di baris TERBARU, bukan yang paling awal", () => {
  const window = viewport(lines(100), 10, 0)
  assert.equal(window.lines[0]?.text, "b90")
  assert.equal(window.lines.at(-1)?.text, "b99")
  assert.equal(window.hiddenAbove, 90)
  assert.equal(window.hiddenBelow, 0)
})

test("menggulir ke atas menggeser jendela dan melaporkan sisa di bawah", () => {
  const window = viewport(lines(100), 10, 20)
  assert.equal(window.lines[0]?.text, "b70")
  assert.equal(window.hiddenAbove, 70)
  assert.equal(window.hiddenBelow, 20)
})

test("gulir berlebihan dijepit di batas, tidak menghasilkan jendela kosong", () => {
  const window = viewport(lines(20), 5, 9999)
  assert.equal(window.lines.length, 5)
  assert.equal(window.lines[0]?.text, "b0", "berhenti di baris pertama")
  assert.equal(window.hiddenAbove, 0)
})

test("tinggi nol atau negatif tetap menghasilkan minimal satu baris", () => {
  assert.equal(viewport(lines(10), 0, 0).lines.length, 1)
  assert.equal(viewport(lines(10), -5, 0).lines.length, 1)
})

// ---------- pembagian tinggi ----------

test("editor tumbuh mengikuti isi tapi tidak menelan layar", () => {
  assert.equal(editorRows("", 30), 3, "satu baris isi + dua bingkai")
  assert.equal(editorRows("a\nb\nc", 30), 5)
  assert.equal(editorRows("a\n".repeat(50), 30), 12, "dibatasi sepertiga layar + bingkai")
})

test("area riwayat menyusut saat editor membesar, dan tidak pernah nol", () => {
  assert.equal(historyRows(30, 3), 22)
  assert.equal(historyRows(30, 12), 13)
  assert.equal(historyRows(8, 20), 1, "layar sangat pendek tetap menyisakan satu baris")
})

// ---------- logo ----------

test("logo terbaca dari file, berupa huruf blok yang solid", () => {
  const art = logoLines()

  assert.ok(art.length >= 5)
  assert.ok(logoWidth(art) > 20)
  assert.ok(
    art.every((line) => line === "" || /^[\u2580-\u259f ]+$/.test(line)),
    "hanya karakter blok dan spasi — garis tipis terlihat pudar di font tipis",
  )
})

test("lambang juga berupa blok, dan tiap barisnya sama lebar", () => {
  const mark = markLines()

  assert.ok(
    mark.every((line) => /^[▀-▟ ]+$/.test(line)),
    "garis miring ASCII terlihat pudar di sebelah logo blok",
  )
  assert.equal(
    new Set(mark.map((line) => line.length)).size,
    1,
    "lebar yang ragged akan menggeser tiap baris sendiri-sendiri saat ditata",
  )
})

test("layar lebar dapat wordmark Rubik Iso, layar sempit dapat yang ringkas", () => {
  const lebar = logoLines(200, 60)
  const ringkas = logoLines(60, 60)

  assert.ok(logoWidth(lebar) > logoWidth(ringkas), "yang lebar memang lebih besar")
  assert.notDeepEqual(lebar, ringkas)

  // Tepat di ambang: satu kolom kurang dari yang dibutuhkan versi lebar sudah
  // harus turun ke versi ringkas, bukan menampilkan logo yang terpotong.
  assert.deepEqual(logoLines(logoWidth(lebar) + 4, 60), lebar)
  assert.deepEqual(logoLines(logoWidth(lebar) + 3, 60), ringkas)
})

test("layar pendek juga menurunkan pilihan, bukan hanya layar sempit", () => {
  const lebar = logoLines(200, 60)
  assert.deepEqual(logoLines(200, lebar.length + 12), lebar)
  assert.deepEqual(logoLines(200, lebar.length + 11), logoLines(60, 60), "kurang tinggi → ringkas")
})

test("logo disembunyikan hanya kalau versi TERKECIL pun tidak muat", () => {
  const ringkas = logoLines(60, 60)
  const lebar = logoWidth(ringkas)

  assert.equal(shouldShowLogo(lebar + 4, ringkas.length + 12), true)
  assert.equal(shouldShowLogo(lebar - 1, 50), false, "terlalu sempit untuk keduanya")
  assert.equal(shouldShowLogo(200, ringkas.length + 11), false, "terlalu pendek untuk keduanya")
})

test("task yang gagal atau dihentikan TIDAK digambar dengan glyph sukses", () => {
  // `task` tidak pernah melempar: sub-agent yang gagal atau dihentikan tetap
  // hasil sah yang harus dibaca koordinator, jadi part-nya berstatus
  // "completed". Tanpa `outcome`, riwayat menuliskan `✓ task penulis (failed)`
  // — centang di atas sub-agent yang jelas-jelas tidak berhasil.
  const withOutcome = (outcome: "failed" | "stopped") =>
    messageLines(
      message("m", {
        parts: [
          {
            type: "tool",
            callID: "c",
            tool: "task",
            state: {
              status: "completed",
              input: {},
              title: `task penulis (${outcome})`,
              output: outcome === "failed" ? "FAILED: boom" : "STOPPED BY USER after 3s.",
              truncated: false,
              outcome,
              started: 1,
              ended: 2,
            },
          },
        ],
      }),
      false,
    ).filter((line) => line.kind !== "blank")

  const gagal = withOutcome("failed")[0]
  assert.match(gagal?.text ?? "", /✗ task penulis \(failed\)/)
  assert.equal(gagal?.kind, "tool-bad")

  const dihentikan = withOutcome("stopped")[0]
  assert.match(dihentikan?.text ?? "", /⊘ task penulis \(stopped\)/)
  assert.equal(dihentikan?.kind, "tool-bad")
})
