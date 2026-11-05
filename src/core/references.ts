import fs from "node:fs"
import path from "node:path"
import type { ModelMessage } from "ai"
import { REAL_BYTES_PER_TOKEN } from "./compact.ts"
import { database } from "./storage/db.ts"
import { protectedPair } from "./storage/session.ts"
import { resolveInside, ToolError } from "./tool/types.ts"

/**
 * Berkas acuan yang disematkan user ke sesi — biasanya folder template HTML/CSS
 * yang harus ditiru model persis.
 *
 * Isinya menumpang di blok terlindung SETIAP permintaan, bukan di riwayat:
 * pemadatan tidak bisa meringkasnya, dan karena itu model tidak pelan-pelan
 * lupa nama kelas atau warna template setelah ringkasan pertama.
 */

/**
 * Satu pintu untuk `/pin` dan `plan.references`, supaya keduanya menolak hal
 * yang sama dengan pesan yang sama.
 *
 * Batas proyek diserahkan ke `resolveInside` apa adanya — pesannya sudah
 * menyebut kunci config yang perlu ditambah. Keberadaan path diperiksa di sini
 * karena referensi yang tidak ada akan diam-diam menjadi bagian kosong di setiap
 * permintaan, dan user mengira template-nya terkirim.
 */
export function resolveReference(cwd: string, target: string): string {
  const resolved = resolveInside(cwd, target)
  if (!fs.existsSync(resolved)) {
    throw new ToolError(`Path "${target}" does not exist (looked for ${resolved}). Nothing was pinned.`)
  }
  return resolved
}

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
/**
 * Batas KERJA penelusuran, terpisah dari anggaran byte. Anggaran membatasi apa
 * yang dikirim; ini membatasi berapa `stat` yang dibayar tiap permintaan ketika
 * user menyematkan folder yang ternyata seluruh repo.
 */
const MAX_WALK_FILES = 2000

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
 *
 * Dibatasi total byte dan dibuang yang paling lama tak dipakai (urutan sisip
 * `Map`, disegarkan tiap kena). Server hidup berhari-hari: tanpa batas, setiap
 * referensi yang pernah dilepas dan setiap berkas yang sudah dihapus tetap
 * tinggal di memori. LRU, bukan "buang yang tidak terlihat di lintasan ini",
 * karena satu server melayani banyak sesi — membuang milik sesi lain di tiap
 * permintaan berarti cache-nya tidak pernah kena.
 */
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const cache = new Map<string, CachedFile>()
let cachedBytes = 0

function remember(file: string, entry: CachedFile): void {
  const old = cache.get(file)
  if (old) {
    cache.delete(file)
    cachedBytes -= old.size
  }
  cache.set(file, entry)
  cachedBytes += entry.size
  for (const [key, value] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break
    cache.delete(key)
    cachedBytes -= value.size
  }
}

function readText(file: string, stat: fs.Stats): string | undefined {
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    remember(file, cached)
    return cached.text
  }
  const buffer = fs.readFileSync(file)
  const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
  const text = binary ? undefined : buffer.toString("utf8")
  remember(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return text
}

/** Ukuran cache saat ini — hanya untuk test yang memaku batasnya. */
export function referenceCacheBytes(): number {
  return cachedBytes
}

interface Candidate {
  file: string
  /** Path yang ditampilkan ke model — relatif ke direktori sesi, supaya bisa langsung dibaca. */
  label: string
  /** Path relatif ke akar referensi, untuk manifest. */
  relative: string
  stat: fs.Stats
}

/**
 * Daftar berkas di bawah `dir`, TERURUT. Urutan readdir bergantung sistem
 * berkas, dan pasangan ini harus identik byte demi byte antar permintaan —
 * kalau tidak, cache provider untuknya tidak pernah cocok.
 *
 * Melebar dulu, bukan mendalam: semua berkas satu tingkat sebelum turun ke
 * tingkat berikutnya. "assets/" berurut sebelum "index.html", dan penelusuran
 * mendalam bisa menghabiskan `MAX_WALK_FILES` di dalam folder gambar sebelum
 * sempat melihat berkas akar yang justru paling penting.
 *
 * Mengembalikan `true` bila berhenti di `MAX_WALK_FILES`.
 */
function walk(dir: string, out: string[]): boolean {
  let level = [dir]
  while (level.length > 0) {
    const next: string[] = []
    for (const current of level) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) next.push(full)
        } else if (entry.isFile()) {
          if (out.length >= MAX_WALK_FILES) return true
          out.push(full)
        }
      }
    }
    level = next
  }
  return false
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
  truncated: boolean
}

/**
 * Satu referensi menjadi daftar kandidat TERURUT menurut prioritas pengisian:
 * `index.html` dan yang dirujuknya, lalu CSS, lalu HTML, lalu sisanya.
 *
 * CSS sebelum HTML karena drift yang paling sering justru di sana — warna,
 * jarak, nama kelas — dan satu stylesheet biasanya melayani semua halaman.
 *
 * Hanya `stat` di sini. Isi dibaca belakangan, dan hanya untuk berkas yang
 * memang akan dikirim — kecuali `index.html`, yang harus dibaca untuk tahu apa
 * yang dirujuknya.
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
  let truncated = false
  if (stat.isDirectory()) truncated = walk(reference, files)
  else if (stat.isFile()) files.push(reference)

  const display = (file: string): string => {
    const rel = sessionDir === undefined ? file : path.relative(sessionDir, file)
    return rel === "" ? "." : rel.startsWith("..") || path.isAbsolute(rel) ? file : rel
  }

  const remaining = new Map<string, Candidate>()
  for (const file of files) {
    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(file)
    } catch {
      continue
    }
    if (fileStat.size > MAX_FILE_BYTES) continue
    remaining.set(file, { file, label: display(file), relative: path.relative(rootDir, file), stat: fileStat })
  }

  const ordered: Candidate[] = []
  const take = (file: string): void => {
    const candidate = remaining.get(file)
    if (!candidate) return
    ordered.push(candidate)
    remaining.delete(file)
  }
  const indexFile = path.join(rootDir, "index.html")
  const index = remaining.get(indexFile)
  if (index) {
    take(indexFile)
    const text = readText(indexFile, index.stat)
    if (text !== undefined) for (const linked of linkedFromIndex(rootDir, text)) take(linked)
  }
  for (const file of [...remaining.keys()]) if (file.endsWith(".css")) take(file)
  for (const file of [...remaining.keys()]) if (file.endsWith(".html")) take(file)
  for (const file of [...remaining.keys()]) take(file)

  return { label: display(rootDir), candidates: ordered, truncated }
}

const OPENING = "<references>\n"
const CLOSING =
  "</references>\n\n" +
  "These are the reference files the user pinned. Match them exactly — structure, class names, " +
  "colours, spacing. Files listed without content did not fit: read them before writing the matching UI."
/** Ruang yang selalu disisihkan untuk baris "… more files not listed". */
const MORE_LINE_RESERVE = 64

/**
 * Bagian pesan user yang TIDAK ditagihkan ke anggaran: pembuka, kalimat
 * penutup, dan sisihan baris "lebih banyak". Ukurannya tetap, tidak tumbuh
 * bersama folder — semua yang tumbuh (manifest maupun isi) ditagihkan.
 */
export const REFERENCE_OVERHEAD_BYTES = Buffer.byteLength(OPENING + CLOSING, "utf8")

function manifestLine(candidate: Candidate, included: boolean): string {
  return `${candidate.relative} (${candidate.stat.size} bytes${included ? "" : ", not included"})\n`
}

function fileBlock(candidate: Candidate, text: string): string {
  return `<file path="${candidate.label}">\n${text}\n</file>\n`
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

  /*
   * Anggaran menanggung manifest DAN isi. Pasangan ini menumpang di awalan
   * terlindung yang tidak bisa dipadatkan, jadi apa pun yang tumbuh bersama
   * ukuran folder harus dibatasi di sini — folder yang ternyata seluruh repo
   * tidak boleh meluapkan setiap permintaan sesudahnya.
   *
   * Dibagi antar akar dalam urutan penyematan: akar pertama mengisi dulu.
   * `MORE_LINE_RESERVE` disisihkan sejak awal supaya baris penutup manifest
   * selalu muat.
   */
  let remaining = budgetBytes - MORE_LINE_RESERVE
  const manifests: string[] = []
  const blocks: string[] = []
  let unlisted = 0
  let truncated = false
  for (const root of roots) {
    truncated ||= root.truncated
    const open = `<manifest root="${root.label}">\n`
    const close = "</manifest>\n"
    const frame = Buffer.byteLength(open + close, "utf8")
    if (frame > remaining) {
      unlisted += root.candidates.length
      continue
    }
    remaining -= frame
    let lines = ""
    for (const candidate of root.candidates) {
      const listed = Buffer.byteLength(manifestLine(candidate, false), "utf8")
      if (listed > remaining) {
        unlisted++
        continue
      }
      // Ukuran dari `stat` dulu: berkas yang jelas tidak muat tidak dibaca sama
      // sekali. Ukuran sebenarnya dihitung ulang dari teks sesudah dibaca.
      const estimate = Buffer.byteLength(manifestLine(candidate, true), "utf8") + candidate.stat.size
      const text = estimate <= remaining ? readText(candidate.file, candidate.stat) : undefined
      if (estimate <= remaining && text === undefined) continue // biner — tidak didaftar sama sekali
      if (text !== undefined) {
        const line = manifestLine(candidate, true)
        const block = fileBlock(candidate, text)
        const bytes = Buffer.byteLength(line + block, "utf8")
        if (bytes <= remaining) {
          remaining -= bytes
          lines += line
          blocks.push(block)
          continue
        }
      }
      // Lanjut, bukan berhenti: satu berkas besar tidak boleh menggugurkan
      // berkas-berkas kecil sesudahnya yang masih muat.
      remaining -= listed
      lines += manifestLine(candidate, false)
    }
    manifests.push(open + lines + close)
  }

  let more = ""
  if (unlisted > 0 || truncated) {
    more = truncated
      ? "… and more files not listed (folder too large to scan)\n"
      : `… and ${unlisted} more files not listed\n`
  }

  return protectedPair(
    OPENING + manifests.join("") + more + blocks.join("") + CLOSING,
    "Understood. I will follow these references.",
  )
}
