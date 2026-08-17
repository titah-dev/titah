import { z } from "zod"
import { RESERVE_FRACTION } from "../compact.ts"
import { readPlan, savePlan } from "../storage/session.ts"
import { ToolError, type TitahTool } from "./types.ts"

/**
 * Intent state (issue #5).
 *
 * Titah melacak *execution state* dengan baik — `ToolState` punya lima varian
 * dan tiap varian dipakai — tapi tidak punya *intent state* sama sekali.
 * Sebelum tool ini, satu-satunya ingatan model tentang rencana bertahap adalah
 * transkrip, dan transkrip sekarang diringkas otomatis, DI TENGAH GILIRAN,
 * persis pada giliran panjang di mana rencana paling berarti.
 *
 * Karena itu tool ini bukan "daftar todo". Nilainya bukan pada daftarnya,
 * melainkan pada tempat menyimpannya: tabel `plan` di luar `model_message`,
 * satu-satunya tabel yang disentuh pemadatan.
 *
 * Ganti-seluruhnya, bukan tambah/centang/urutkan per butir. Butir bergranular
 * berarti mesin keadaan kedua di sebelah `ToolState`, dan yang dibelinya —
 * status per langkah — sudah terlihat di transkrip. Dokumen markdown yang
 * ditulis ulang model adalah bentuk yang sudah ia kuasai.
 */

/**
 * Batas keras, dalam byte.
 *
 * Rencana ikut dikirim di SETIAP request, jadi ia bersaing dengan percakapan
 * yang sedang berjalan. 4 KB cukup untuk rencana dua puluh langkah beserta
 * catatannya, dan terlalu kecil untuk menampung potongan kode — yang memang
 * bukan tempatnya.
 */
export const MAX_PLAN_BYTES = 4096

/**
 * Batas kedua, relatif jendela — dan ini yang sebenarnya menggigit pada model
 * kecil.
 *
 * Pada jendela 8192 token, rencana 4 KB memakan seperdelapan anggaran sebelum
 * satu kata percakapan pun ada. Bentuknya sengaja sama dengan `effectiveReserved`
 * (`compact.ts`): seperempat jendela, memakai `RESERVE_FRACTION` yang sama,
 * supaya pembaca yang sudah memahami satu angka ini sudah memahami semuanya.
 *
 * Dibagi lagi dengan 4: `reserved` boleh mengambil seperempat jendela karena ia
 * menampung SELURUH jawaban berikutnya; rencana hanya salah satu penumpang di
 * dalamnya, dan tidak boleh menghabiskan jatah itu sendirian.
 */
const PLAN_FRACTION = RESERVE_FRACTION * 4

/**
 * Catatan tentang PENGHITUNGAN, bukan pembatasan.
 *
 * Store terlindungi yang dikecualikan dari anggaran adalah masalah konteks tak
 * terbatas kedua yang memakai topi batas. Rencana ini tidak dikecualikan, dan
 * tidak butuh kode untuk itu: `autoCompact` mengukur dari token yang DILAPORKAN
 * provider untuk request sebelumnya, dan rencana memang ikut di request itu
 * lewat `listModelMessages`. Ia terhitung karena yang diukur adalah permintaan
 * sungguhan, bukan rekonstruksinya.
 *
 * Satu giliran setelah rencana ditulis, angka itu masih dari sebelum rencana
 * ada — jeda satu giliran yang sama persis dengan yang sudah berlaku untuk
 * setiap isi lain, dan bukan sifat khusus rencana.
 */
export function planBudgetBytes(contextWindow: number | undefined): number {
  if (contextWindow === undefined) return MAX_PLAN_BYTES
  // REAL_BYTES_PER_TOKEN sengaja tidak diimpor: yang dibutuhkan di sini cuma
  // urutan besarannya, dan menautkan dua angka yang berubah karena alasan
  // berbeda justru membuat keduanya lebih sulit diubah.
  const fromWindow = Math.floor((contextWindow / PLAN_FRACTION) * 4)
  return Math.min(MAX_PLAN_BYTES, fromWindow)
}

const inputSchema = z.object({
  text: z
    .string()
    .describe(
      "The complete plan, as markdown. This REPLACES the previous plan entirely — " +
        "send the whole document every time, not a diff. An empty string clears it.",
    ),
})

export const planTool: TitahTool<typeof inputSchema> = {
  name: "plan",
  description:
    "Record your working plan for this session. It is carried across context compaction, " +
    "so it is the one place a multi-step plan survives a long turn. Replaces the plan " +
    "entirely on every call; send an empty string to clear it. Update it as steps " +
    "complete — a stale plan is worse than no plan.\n\n" +
    "Write the steps as markdown checkboxes — `- [ ]` for pending, `- [x]` for done. " +
    "That is not decoration: it is the only part of the plan Titah itself can read, and it " +
    "is what tells it whether work remains when a turn runs out of room.",
  inputSchema,
  // Tidak ada `permission`, dan tidak ada `mutates`. Menulis rencana tidak
  // menyentuh filesystem maupun shell — ia menulis ke database Titah sendiri,
  // dengan batas. Sumbu izin yang belum ada (task, delegasi, jaringan) semuanya
  // tentang membelanjakan sesuatu milik user; yang ini tidak membelanjakan apa
  // pun. Karena itu ia juga tidak butuh snapshot: `/undo` mengembalikan
  // perubahan berkas, dan rencana bukan berkas.
  async execute(input, ctx) {
    const text = input.text.trim()

    if (text === "") {
      savePlan(ctx.sessionID, "")
      return { title: "plan cleared", output: "Plan cleared." }
    }

    const bytes = Buffer.byteLength(text, "utf8")
    const budget = planBudgetBytes(ctx.contextWindow)
    if (bytes > budget) {
      // Menolak, bukan memotong. Rencana yang dipotong diam-diam adalah rencana
      // yang salah dan terlihat benar — kegagalan yang sama persis dengan
      // ringkasan yang dipotong provider, dan alasan seluruh siklus #1 ada.
      throw new ToolError(
        `Plan is ${bytes} bytes, over the ${budget}-byte limit${
          ctx.contextWindow === undefined ? "" : ` for this ${ctx.contextWindow}-token window`
        }. Shorten it and write again — keep the steps, drop the prose.`,
      )
    }

    const previous = readPlan(ctx.sessionID)
    savePlan(ctx.sessionID, text)
    const steps = text.split("\n").filter((line) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line)).length
    return {
      title: `plan ${previous ? "updated" : "set"}${steps > 0 ? ` (${steps} steps)` : ""}`,
      output:
        `Plan ${previous ? "updated" : "recorded"} (${bytes}/${budget} bytes). ` +
        "It will be included in every request for this session until you change it.",
    }
  },
}
