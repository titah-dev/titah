import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

/**
 * `cmdDoctor` di src/cli.ts memanggil renderSkillReport secara langsung, dan
 * tidak ada seam untuk mengimpornya tanpa menjalankan `main()` di ujung file
 * (cli.ts punya `await main(...)` di top level). Jalan yang jujur untuk
 * membuktikan pemanggilan itu sungguh terpasang — bukan cuma ada di source —
 * adalah menjalankan biner hasil build sungguhan dan membaca stdout-nya,
 * persis seperti "Manual verification" di brief melakukannya.
 */

const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js")

function isolatedProject(titahJson: unknown, skillFiles: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "titah-doctor-proj-"))
  for (const [relative, content] of Object.entries(skillFiles)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  fs.writeFileSync(path.join(root, "titah.json"), JSON.stringify(titahJson))
  return root
}

function runDoctor(cwd: string): string {
  // HOME dan XDG_* diisolasi supaya test ini tidak pernah membaca ~/.claude
  // atau ~/.config/opencode sungguhan di mesin manapun ia berjalan.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "titah-doctor-home-"))
  return execFileSync(process.execPath, [CLI, "doctor"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    },
  })
}

test("titah doctor menampilkan bagian Skills dengan hitungan, konflik, dan sumber nihil", () => {
  const root = isolatedProject(
    {
      skills: {
        discover: [],
        paths: [
          { path: "a/skills", as: "ns" },
          { path: "b/skills", as: "ns" }, // sengaja sama persis, memicu konflik
          { path: "tidak-ada", as: "typo" }, // path yang tidak pernah dibuat
        ],
        always: ["ns:hilang"],
      },
    },
    {
      "a/skills/sama/SKILL.md": "---\nname: sama\n---\nsatu",
      "b/skills/sama/SKILL.md": "---\nname: sama\n---\ndua",
    },
  )

  const output = runDoctor(root)

  assert.match(output, /Skills/)
  assert.match(output, /ns\s+1 skill/)
  assert.match(output, /1 conflict/)
  assert.match(output, /sources with no skills/)
  assert.match(output, /ns:hilang/)
})

test("doctor menyebut model yang belum punya contextWindow beserta jalur confignya", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "llama3:8b": {} },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  // Positif dulu: buktikan bagian Context windows benar-benar dirender,
  // supaya assertion berikutnya tidak lolos pada output kosong.
  assert.match(output, /Context windows/)
  assert.match(output, /ollama\/llama3:8b/)
  assert.match(output, /provider\.ollama\.models/)
})

test("doctor tidak mengeluh saat semua model sudah punya contextWindow", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      // reserved diset EKSPLISIT di bawah seperempat jendela ini. Task 10 membuat
      // `reserved` bawaan (8192) bertabrakan dengan jendela 8k ini juga, dan
      // tabrakan itu punya peringatannya sendiri (test di bawah) — bukan urusan
      // test ini, yang mengecek warning "contextWindow belum dideklarasikan".
      compaction: { reserved: 2048 },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "llama3:8b": { contextWindow: 8192 } },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /Context windows/)
  assert.match(output, /all configured models declare one/)
  assert.doesNotMatch(output, /ollama\/llama3:8b/)
})

test("doctor menyebut smallModel yang jendelanya belum dideklarasikan", () => {
  // Acceptance ketiga issue #1: batas prompt peringkas tidak bisa ditegakkan
  // pada angka yang tidak ada. Ia jatuh ke jendela model giliran — aman, tapi
  // lebih longgar dari yang user maksud, dan satu-satunya cara ia bisa tahu
  // adalah kalau ada yang menyebutkannya. Bedanya dengan peringatan
  // "contextWindow belum dideklarasikan" biasa: yang ini soal model yang MENULIS
  // ringkasan, bukan model yang menjalankan giliran.
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      compaction: { reserved: 2048 },
      smallModel: "ollama/kecil",
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "llama3:8b": { contextWindow: 8192 }, kecil: {} },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /Context windows/)
  assert.match(output, /smallModel/)
  assert.match(output, /ollama\/kecil/)
  // Menyebut akibatnya, bukan cuma faktanya: yang penting bagi user adalah
  // batas mana yang jadi berlaku.
  assert.match(output, /summariser/i)
})

test("doctor diam soal smallModel yang jendelanya sudah dideklarasikan", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      compaction: { reserved: 2048 },
      smallModel: "ollama/kecil",
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: {
            "llama3:8b": { contextWindow: 8192 },
            kecil: { contextWindow: 4096 },
          },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /all configured models declare one/)
  assert.doesNotMatch(output, /smallModel/)
})

test("doctor tidak menegur angka reserved yang tidak pernah ditulis user", () => {
  // Bawaan `reserved` (8192) lebih besar dari seperempat SETIAP jendela di
  // bawah 32768, jadi peringatan yang tidak membedakan asal angkanya akan
  // menandai temuan pada config yang bahkan tidak punya blok `compaction`.
  // Satu-satunya yang user pelajari dari situ adalah bahwa Titah tidak
  // menyetujui bawaannya sendiri — dan tidak ada yang bisa ia perbuat.
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      // SENGAJA tanpa blok `compaction` sama sekali.
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "kecil": { contextWindow: 8192 } },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  // Positif dulu: baris tentang model ini memang dirender, lengkap dengan
  // angka yang benar-benar dipakai — informasinya tidak hilang, hanya
  // berhenti berpura-pura sebagai temuan.
  assert.match(output, /ollama\/kecil/)
  assert.match(output, /using 2048/)
  assert.match(output, /the default compaction\.reserved/)
  assert.match(output, /Nothing to fix/)

  // Baru negatif: tidak ada penanda temuan `!` untuk model ini.
  assert.doesNotMatch(output, /! ollama\/kecil/)
})

test("doctor bilang kalau reserved dijinakkan lantainya", () => {
  const project = isolatedProject(
    {
      skills: { discover: [], paths: [] },
      compaction: { reserved: 8192 },
      provider: {
        ollama: {
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "kecil": { contextWindow: 8192 } },
        },
      },
    },
    {},
  )
  const output = runDoctor(project)

  assert.match(output, /Context windows/)
  assert.match(output, /ollama\/kecil/)
  assert.match(output, /using 2048/)
  // Angka yang user TULIS SENDIRI tetap ditandai sebagai temuan — pasangan
  // dari test di atas, yang membuktikan bawaan tidak ditandai.
  assert.match(output, /! ollama\/kecil/)
})
