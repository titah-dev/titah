import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "titah-compact-")))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.TITAH_DB = path.join(root, "compact.db")
// Sama seperti agent.test.ts: buildSystemPrompt membaca $HOME sungguhan kalau
// tidak diisolasi, walau tidak relevan untuk pemadatan — konsisten saja.
process.env.HOME = path.join(root, "home")

const { prompt, setModelResolver } = await import("../src/core/agent.ts")
const { createSession } = await import("../src/core/storage/session.ts")

const project = path.join(root, "proyek")
fs.mkdirSync(project, { recursive: true })

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const USAGE = {
  inputTokens: { total: 11, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: undefined, reasoning: undefined },
}

function text(...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t0", delta })),
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]
}

/** Satu model palsu yang membalas giliran-giliran berurutan dari `chunks`. */
function mockStreaming(chunks: LanguageModelV4StreamPart[][]): () => void {
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const parts = chunks[Math.min(call, chunks.length - 1)] as LanguageModelV4StreamPart[]
      call += 1
      return { stream: simulateReadableStream({ chunks: parts }) }
    },
  })
  return setModelResolver(() => model)
}

/**
 * Membuktikan bahwa `/compact` benar-benar MEMBACA `config.compaction.tailTurns`,
 * bukan hanya menerimanya di signature tanpa memakainya.
 *
 * Sengaja tidak menegaskan lewat spy/mock pada `planCompaction` — itu membuktikan
 * kode MEMANGGIL fungsinya, bukan bahwa nilainya benar-benar dipakai model.
 * Diuji lewat OBSERVABLE yang berubah bersama nilainya: jumlah pesan yang
 * diringkas vs dipertahankan, dibaca dari teks jawaban `/compact` yang
 * sesungguhnya sampai ke user. Kalau baris `config.compaction.tailTurns` di
 * agent.ts dihapus (kembali ke `planCompaction(rows)` polos), hasilnya diam-diam
 * memakai KEEP_TURNS bawaan (2) dan test ini gagal — dibuktikan lewat mutasi
 * yang sama di laporan tugas ini.
 */
test("tailTurns dari config menentukan berapa giliran yang tersisa setelah /compact", async () => {
  const restore = mockStreaming([
    text("balasan satu"),
    text("balasan dua"),
    text("balasan tiga"),
    text("Ringkasan singkat tiga giliran."),
  ])
  try {
    fs.writeFileSync(
      path.join(project, "titah.json"),
      // tailTurns=1 BEDA dari default (2) — kalau config diabaikan, hasilnya
      // akan cocok dengan default, bukan dengan nilai ini.
      JSON.stringify({ compaction: { tailTurns: 1 } }),
    )
    const session = createSession(project)

    await prompt({ sessionID: session.id, text: "satu" })
    await prompt({ sessionID: session.id, text: "dua" })
    await prompt({ sessionID: session.id, text: "tiga" })

    // Riwayat sekarang: 3 giliran (user+assistant) = 6 baris model. Dengan
    // tailTurns=1, hanya giliran TERAKHIR ("tiga") tersisa apa adanya — 2
    // pesan — dan 4 pesan pertama (giliran "satu" dan "dua") diringkas.
    const assistant = await prompt({ sessionID: session.id, text: "/compact" })

    const body = assistant.parts.find((part) => part.type === "text")
    assert.ok(body?.type === "text", "jawaban /compact harus berupa teks")
    assert.match(
      body.text,
      /^Compacted 4 messages into a summary, keeping the last 2 verbatim\./,
    )
  } finally {
    restore()
  }
})
