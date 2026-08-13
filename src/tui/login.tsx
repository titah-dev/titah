import { Box, Text } from "ink"
import type { DeviceAuthorization } from "../core/account.ts"
import { formatUserCode } from "../core/account.ts"

/**
 * Panel `/login` di dalam TUI.
 *
 * Login memakan waktu yang dihabiskan DI TEMPAT LAIN — di browser, mungkin di
 * mesin lain. Selama itu terminal tidak boleh terlihat menggantung, dan kode
 * verifikasinya harus tetap terbaca sepanjang waktu, bukan lewat sekali sebagai
 * baris riwayat yang langsung tergulir hilang.
 *
 * `loginLines` dipisah dari komponennya supaya isinya bisa diuji tanpa merender
 * Ink sama sekali — pola yang sama dengan `panelLines` di subagent-panel.tsx.
 */

export interface LoginProgress {
  phase: "starting" | "waiting" | "done" | "failed"
  server: string
  authorization?: DeviceAuthorization
  /** Apakah browser benar-benar terbuka. Menentukan apakah URL perlu dicetak. */
  browserOpened?: boolean
  email?: string
  error?: string
  slowedDown?: boolean
}

export function loginLines(progress: LoginProgress): string[] {
  const lines: string[] = []

  if (progress.phase === "starting") {
    lines.push(`Asking ${progress.server} for a login code…`)
    return lines
  }

  if (progress.phase === "failed") {
    lines.push(progress.error ?? "Sign-in failed.")
    return lines
  }

  if (progress.phase === "done") {
    lines.push(`Signed in as ${progress.email ?? "?"}.`)
    return lines
  }

  const authorization = progress.authorization
  if (!authorization) return ["Waiting…"]

  lines.push(`Code: ${formatUserCode(authorization.userCode)}`)
  if (progress.browserOpened === true) {
    lines.push("A browser window should have opened — confirm the code there.")
    lines.push(authorization.verificationUri)
  } else {
    lines.push("Open this in any browser, on any machine:")
    lines.push(authorization.verificationUriComplete ?? authorization.verificationUri)
  }
  // Disebutkan, tidak disembunyikan: polling yang tiba-tiba melambat tanpa
  // penjelasan terbaca persis seperti macet.
  if (progress.slowedDown === true) lines.push("The server asked us to poll more slowly.")
  lines.push("Esc cancels.")
  return lines
}

export function LoginPanel({ progress }: { progress: LoginProgress }) {
  const lines = loginLines(progress)
  const colour =
    progress.phase === "failed" ? "red" : progress.phase === "done" ? "green" : "yellow"

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colour} paddingX={1}>
      <Text color={colour} bold>
        {progress.phase === "done"
          ? "Signed in"
          : progress.phase === "failed"
            ? "Sign-in failed"
            : "Sign in to Titah"}
      </Text>
      {lines.map((line, index) => (
        <Text key={index} dimColor={index > 0}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
