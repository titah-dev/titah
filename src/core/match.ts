/**
 * Pencocokan pola, dipisah ke modulnya sendiri.
 *
 * Dipakai `permission.ts` (yang bertanya) DAN `decide.ts` (yang memutuskan).
 * Kalau ia tinggal di salah satunya, yang lain harus mengimpornya balik dan
 * grafik modulnya melingkar — dan siklus di jalur izin adalah tempat terakhir
 * yang boleh punya urutan-muat yang halus.
 */

/**
 * Pencocokan pola gaya glob sederhana: `*` cocok dengan apa saja.
 * Dipakai untuk allowlist bash seperti `git *` atau `npm test`.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

