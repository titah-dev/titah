import os from "node:os"
import path from "node:path"

/**
 * Semua path lewat helper ini. Tidak ada separator yang di-hardcode, supaya
 * dukungan Windows nanti (Q30) jadi pekerjaan sehari, bukan penulisan ulang.
 */

const APP = "titah"

function xdg(envVar: string, fallback: string[]): string {
  const fromEnv = process.env[envVar]
  if (fromEnv && fromEnv.trim() !== "") return path.join(fromEnv, APP)
  return path.join(os.homedir(), ...fallback, APP)
}

/** ~/.config/titah — konfigurasi yang boleh dibaca manusia dan di-commit. */
export const configDir = (): string => xdg("XDG_CONFIG_HOME", [".config"])

/** ~/.local/share/titah — state: DB sesi, auth, snapshot, output tool. */
export const dataDir = (): string => xdg("XDG_DATA_HOME", [".local", "share"])

/** ~/.cache/titah */
export const cacheDir = (): string => xdg("XDG_CACHE_HOME", [".cache"])

export const globalConfigFile = (): string => path.join(configDir(), "titah.json")

/** Kredensial hidup terpisah dari config (Q19) dan selalu bermode 0600. */
export const authFile = (): string => path.join(dataDir(), "auth.json")

/**
 * Sesi akun titah-web. Terpisah dari auth.json karena isinya berbeda jenis:
 * auth.json memegang kunci provider milikmu, account.json memegang identitasmu.
 */
export const accountFile = (): string => path.join(dataDir(), "account.json")

export const sessionDbFile = (): string => path.join(dataDir(), "titah.db")

/** Blob besar tidak masuk DB (Q11) — lihat DESIGN.md §2. */
export const toolOutputDir = (): string => path.join(dataDir(), "tool-output")

export const snapshotDir = (): string => path.join(dataDir(), "snapshot")

export const logDir = (): string => path.join(dataDir(), "log")

/** Config per-proyek, di-merge di atas config global. */
export const projectConfigFile = (cwd: string = process.cwd()): string =>
  path.join(cwd, "titah.json")
