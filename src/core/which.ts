import fs from "node:fs"
import path from "node:path"

/**
 * Mencari executable di PATH tanpa men-spawn shell.
 *
 * Dipakai untuk deteksi agent eksternal saat startup (Q24): CLI yang tidak
 * terpasang tetap ditampilkan sebagai "tidak tersedia", tidak disembunyikan.
 */
export function which(command: string): string | undefined {
  if (command.includes(path.sep) || command.includes("/")) {
    return isExecutable(command) ? path.resolve(command) : undefined
  }

  const pathVar = process.env.PATH ?? ""
  const dirs = pathVar.split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""]

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
