import fs from "node:fs"
import path from "node:path"
import type { ModelMessage } from "ai"
import { REAL_BYTES_PER_TOKEN } from "./compact.ts"
import { database } from "./storage/db.ts"
import { protectedPair } from "./storage/session.ts"

/**
 * Berkas acuan yang disematkan user ke sesi — biasanya folder template HTML/CSS
 * yang harus ditiru model persis.
 *
 * Isinya menumpang di blok terlindung SETIAP permintaan, bukan di riwayat:
 * pemadatan tidak bisa meringkasnya, dan karena itu model tidak pelan-pelan
 * lupa nama kelas atau warna template setelah ringkasan pertama.
 */

export function addReference(sessionID: string, absPath: string): void {
  // OR IGNORE, bukan OR REPLACE: menyematkan ulang tidak boleh memindah
  // urutannya, karena urutan itulah yang menentukan siapa dapat anggaran dulu.
  database()
    .prepare("INSERT OR IGNORE INTO reference (session_id, path, added) VALUES (?, ?, ?)")
    .run(sessionID, absPath, Date.now())
}

export function removeReference(sessionID: string, absPath: string): boolean {
  const result = database()
    .prepare("DELETE FROM reference WHERE session_id = ? AND path = ?")
    .run(sessionID, absPath)
  return Number(result.changes) > 0
}

export function listReferences(sessionID: string): string[] {
  // `rowid` sebagai pemecah seri: dua referensi yang ditambahkan dalam
  // milidetik yang sama tetap punya urutan yang sama di setiap permintaan.
  const rows = database()
    .prepare("SELECT path FROM reference WHERE session_id = ? ORDER BY added ASC, rowid ASC")
    .all(sessionID) as { path: string }[]
  return rows.map((row) => row.path)
}

/** Seperempat ambang pemadatan — sisanya untuk percakapan yang justru sedang dikerjakan. */
const REFERENCE_FRACTION = 0.25
/** Anggaran ketika model tidak menyatakan jendela: cukup untuk satu template kecil. */
const DEFAULT_BUDGET_BYTES = 64 * 1024

export function referenceBudgetBytes(compactWindow: number | undefined): number {
  if (compactWindow === undefined) return DEFAULT_BUDGET_BYTES
  return Math.floor(compactWindow * REFERENCE_FRACTION) * REAL_BYTES_PER_TOKEN
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"])
/** Berkas sebesar ini hampir pasti hasil build atau vendor, bukan template yang ditulis tangan. */
const MAX_FILE_BYTES = 256 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024

interface CachedFile {
  mtimeMs: number
  size: number
  /** `undefined` berarti biner — dicatat juga supaya tidak diendus ulang tiap permintaan. */
  text: string | undefined
}

/**
 * Cache baca tingkat modul. Referensi dibaca pada SETIAP permintaan, termasuk
 * tiap langkah di dalam satu giliran, jadi membaca ulang folder template yang
 * tidak berubah adalah I/O yang sia-sia. Dikunci pada `mtimeMs` DAN `size`:
 * sistem berkas dengan resolusi mtime kasar bisa melewatkan suntingan cepat
 * kalau hanya mtime yang dilihat.
 */
const cache = new Map<string, CachedFile>()

function readText(file: string, stat: fs.Stats): string | undefined {
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text
  const buffer = fs.readFileSync(file)
  const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  const text = binary ? undefined : buffer.toString("utf8")
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return text
}

interface Candidate {
  /** Path yang ditampilkan ke model — relatif ke direktori sesi, supaya bisa langsung dibaca. */
  label: string
  /** Path relatif ke akar referensi, untuk manifest. */
  relative: string
  size: number
  text: string
}

/**
 * Daftar berkas di bawah `dir`, TERURUT. Urutan readdir bergantung sistem
 * berkas, dan pasangan ini harus identik byte demi byte antar permintaan —
 * kalau tidak, cache provider untuknya tidak pernah cocok.
 */
function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

/** Berkas yang dirujuk `index.html` lewat `href`/`src` relatif, urut kemunculan. */
function linkedFromIndex(rootDir: string, index: string): string[] {
  const out: string[] = []
  for (const match of index.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1]?.split(/[?#]/)[0] ?? ""
    // Skema (`https:`, `data:`) dan `//host` bukan berkas di folder ini; `/x`
    // relatif ke akar SITUS, yang tidak kita ketahui di mana.
    if (raw === "" || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) continue
    out.push(path.resolve(rootDir, raw))
  }
  return out
}

interface Root {
  /** Label akar untuk manifest. */
  label: string
  candidates: Candidate[]
}

/**
 * Satu referensi menjadi daftar kandidat TERURUT menurut prioritas pengisian:
 * `index.html` dan yang dirujuknya, lalu CSS, lalu HTML, lalu sisanya.
 *
 * CSS sebelum HTML karena drift yang paling sering justru di sana — warna,
 * jarak, nama kelas — dan satu stylesheet biasanya melayani semua halaman.
 */
function collect(reference: string, sessionDir: string | undefined): Root | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(reference)
  } catch {
    return undefined
  }
  const rootDir = stat.isDirectory() ? reference : path.dirname(reference)
  const files: string[] = []
  if (stat.isDirectory()) walk(reference, files)
  else if (stat.isFile()) files.push(reference)

  const display = (file: string): string => {
    const rel = sessionDir === undefined ? file : path.relative(sessionDir, file)
    return rel === "" ? "." : rel.startsWith("..") || path.isAbsolute(rel) ? file : rel
  }

  const readable = new Map<string, Candidate>()
  for (const file of files) {
    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(file)
    } catch {
      continue
    }
    if (fileStat.size > MAX_FILE_BYTES) continue
    const text = readText(file, fileStat)
    if (text === undefined) continue
    readable.set(file, {
      label: display(file),
      relative: path.relative(rootDir, file),
      size: fileStat.size,
      text,
    })
  }

  const ordered: Candidate[] = []
  const take = (file: string): void => {
    const candidate = readable.get(file)
    if (!candidate) return
    ordered.push(candidate)
    readable.delete(file)
  }
  const indexFile = path.join(rootDir, "index.html")
  const index = readable.get(indexFile)
  if (index) {
    take(indexFile)
    for (const linked of linkedFromIndex(rootDir, index.text)) take(linked)
  }
  for (const file of [...readable.keys()]) if (file.endsWith(".css")) take(file)
  for (const file of [...readable.keys()]) if (file.endsWith(".html")) take(file)
  for (const file of [...readable.keys()]) take(file)

  return { label: display(rootDir), candidates: ordered }
}

function fileBlock(candidate: Candidate): string {
  return `<file path="${candidate.label}">\n${candidate.text}\n</file>`
}

export function referencePair(sessionID: string, budgetBytes: number): ModelMessage[] {
  const references = listReferences(sessionID)
  if (references.length === 0) return []
  const session = database().prepare("SELECT directory FROM session WHERE id = ?").get(sessionID) as
    | { directory: string }
    | undefined

  const roots = references
    .map((reference) => collect(reference, session?.directory))
    .filter((root): root is Root => root !== undefined)

  // Anggaran dibagi ANTAR akar dalam urutan penyematan: akar pertama mengisi
  // dulu. Manifest tidak dihitung — ia kecil, dan tanpanya model tidak tahu
  // berkas mana yang harus ia baca sendiri.
  let remaining = budgetBytes
  const included = new Set<Candidate>()
  const blocks: string[] = []
  for (const root of roots) {
    for (const candidate of root.candidates) {
      const block = fileBlock(candidate)
      const bytes = Buffer.byteLength(block, "utf8")
      // Lanjut, bukan berhenti: satu berkas besar tidak boleh menggugurkan
      // berkas-berkas kecil sesudahnya yang masih muat.
      if (bytes > remaining) continue
      remaining -= bytes
      included.add(candidate)
      blocks.push(block)
    }
  }

  const manifests = roots.map((root) => {
    const lines = root.candidates.map(
      (candidate) =>
        `${candidate.relative} (${candidate.size} bytes${included.has(candidate) ? "" : ", not included"})`,
    )
    return `<manifest root="${root.label}">\n${lines.join("\n")}\n</manifest>`
  })

  return protectedPair(
    `<references>\n${[...manifests, ...blocks].join("\n")}\n</references>\n\n` +
      "These are the reference files the user pinned. Match them exactly — structure, class names, " +
      "colours, spacing. Files listed without content did not fit: read them before writing the matching UI.",
    "Understood. I will follow these references.",
  )
}
