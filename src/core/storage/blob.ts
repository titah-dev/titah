import fs from "node:fs"
import path from "node:path"
import { toolOutputDir } from "../paths.ts"

/**
 * Output tool yang besar (isi file, hasil grep, log build) ditulis ke
 * filesystem, bukan ke DB. Yang masuk konteks LLM dan DB hanyalah potongan
 * awalnya plus pointer.
 *
 * Ini keputusan Q11, dan alasannya konkret: transkrip agent didominasi output
 * tool yang tidak pernah dibaca lagi setelah turn-nya lewat.
 */

export const INLINE_LIMIT = 32 * 1024

export interface StoredOutput {
  /** Yang aman dimasukkan ke konteks. Dipotong kalau aslinya melebihi batas. */
  output: string
  /** Path ke isi penuh, hanya diisi kalau dipotong. */
  outputRef?: string
  truncated: boolean
  bytes: number
}

export function storeOutput(id: string, content: string): StoredOutput {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes <= INLINE_LIMIT) return { output: content, truncated: false, bytes }

  const dir = toolOutputDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.txt`)
  fs.writeFileSync(file, content)

  const head = content.slice(0, INLINE_LIMIT)
  return {
    output:
      `${head}\n\n[truncated: ${bytes} bytes total, first ${INLINE_LIMIT} bytes shown. ` +
      `Full contents: ${file}]`,
    outputRef: file,
    truncated: true,
    bytes,
  }
}

export function readOutput(ref: string): string | undefined {
  return fs.existsSync(ref) ? fs.readFileSync(ref, "utf8") : undefined
}
