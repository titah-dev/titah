import { chordOwner, type Keymap } from "../tui/keybinds.ts"
import type { RegistryEntry } from "./extension-registry.ts"

/**
 * Model data picker extension. Sengaja tanpa Ink supaya bisa diuji utuh.
 *
 * # Tiga keadaan, dan kenapa harus dibedakan tampilannya
 *
 * `I` berarti hal yang berbeda pada masing-masing:
 *
 *   installed  → tidak ada yang perlu dilakukan
 *   configured → ada di config, belum terunduh; unduh
 *   available  → ada di registry, belum dipilih; tulis ke config LALU unduh
 *
 * Tombol yang artinya berubah tergantung baris yang tersorot, tanpa tampilan
 * yang membedakan barisnya, adalah tombol yang orang tekan lalu menyesal —
 * terutama yang ketiga, karena ia menulis ke config user.
 */

export type PickerState = "installed" | "configured" | "available"

export interface PickerRow {
  /** Spec seperti yang ada (atau akan ada) di config. */
  spec: string
  /** Nama paket npm. Sama dengan `spec` untuk entri npm biasa. */
  packageName: string
  state: PickerState
  title: string
  description?: string
  version?: string
  /** Tombol yang berlaku, sesudah tabrakan diselesaikan. */
  key?: string
  /** Aksi yang sudah memakai tombol yang diusulkan, kalau ada. */
  keyConflict?: string
}

export interface PickerInput {
  /** Kunci `config.extension`, apa adanya — urutannya urutan user. */
  configured: string[]
  /** Paket yang benar-benar ada di disk. */
  installed: string[]
  registry: RegistryEntry[]
  /** Tombol yang diusulkan per spec, dari manifest atau config. */
  proposedKeys?: Record<string, string>
  keymap?: Keymap
  query?: string
}

/**
 * Menyusun baris picker.
 *
 * Urutannya: yang ada di config lebih dulu (dalam urutan config), lalu sisa
 * registry. Alasannya sama dengan alasan urutan config menentukan pemenang
 * sisi: itu satu-satunya urutan yang user bisa lihat dan ubah, dan barisnya
 * tidak boleh berpindah-pindah saat registry di-update dari jauh.
 */
export function pickerRows(input: PickerInput): PickerRow[] {
  const installed = new Set(input.installed)
  const byPackage = new Map(input.registry.map((entry) => [entry.package, entry]))
  const byId = new Map(input.registry.map((entry) => [entry.id, entry]))
  const rows: PickerRow[] = []
  const seen = new Set<string>()

  for (const spec of input.configured) {
    const entry = spec.startsWith("market:") ? byId.get(spec.slice("market:".length)) : byPackage.get(spec)
    const packageName = entry?.package ?? spec
    seen.add(packageName)
    rows.push(
      decorate(
        {
          spec,
          packageName,
          /*
           * "configured" untuk apa pun yang belum ada di disk, TERMASUK spec
           * `./lokal` yang tidak pernah diunduh. Menyebutnya "installed" karena
           * ia ada di config akan membuat `I` tidak melakukan apa pun pada
           * baris yang justru paling butuh sesuatu dilakukan.
           */
          state: installed.has(packageName) ? "installed" : "configured",
          title: entry?.title ?? spec,
          ...(entry?.description !== undefined ? { description: entry.description } : {}),
          ...(entry?.version !== undefined ? { version: entry.version } : {}),
        },
        input,
      ),
    )
  }

  for (const entry of input.registry) {
    if (seen.has(entry.package)) continue
    rows.push(
      decorate(
        {
          spec: entry.package,
          packageName: entry.package,
          state: installed.has(entry.package) ? "installed" : "available",
          title: entry.title ?? entry.package,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          version: entry.version,
        },
        input,
      ),
    )
  }

  return filter(rows, input.query)
}

function decorate(row: PickerRow, input: PickerInput): PickerRow {
  const proposed = input.proposedKeys?.[row.spec]
  if (proposed === undefined || input.keymap === undefined) return row
  const owner = chordOwner(input.keymap, proposed)
  return {
    ...row,
    key: proposed,
    ...(owner !== undefined ? { keyConflict: owner } : {}),
  }
}

/**
 * Pencarian pada spec, judul, dan keterangan sekaligus.
 *
 * Ketiganya dan bukan hanya nama: orang mencari "git" untuk menemukan panel
 * yang judulnya "Branches", dan pencarian yang hanya melihat nama paket
 * mengembalikan nol untuk kueri yang jelas-jelas cocok.
 */
function filter(rows: PickerRow[], query: string | undefined): PickerRow[] {
  const needle = query?.trim().toLowerCase() ?? ""
  if (needle === "") return rows
  return rows.filter((row) =>
    [row.spec, row.title, row.description ?? ""].some((field) => field.toLowerCase().includes(needle)),
  )
}

/**
 * Apa yang akan dilakukan `I` pada baris ini, sebagai kalimat.
 *
 * Ditulis di sini dan bukan di komponen supaya kalimat yang dibaca user dan
 * cabang yang dieksekusi datang dari satu tempat. Kalimat yang disusun di sisi
 * render akan menjanjikan hal yang berbeda dari yang terjadi begitu salah satu
 * dari keduanya berubah.
 */
export function installLabel(row: PickerRow): string {
  if (row.state === "installed") return "already installed"
  if (row.state === "configured") return `download ${row.packageName}`
  return `add ${row.packageName} to your config, then download it`
}
