#!/usr/bin/env node
/**
 * CLI agent eksternal palsu untuk test.
 *
 * Q25 menuntut adapter delegasi diuji dengan CLI yang di-stub: test yang
 * memanggil Claude Code sungguhan akan membakar token setiap kali dijalankan,
 * dan test seperti itu tidak akan pernah dijalankan orang.
 *
 * Mode diatur lewat env TITAH_STUB_MODE:
 *   claude   – meniru `claude -p --output-format stream-json --verbose`
 *   opencode – meniru `opencode run --format json`
 *   crash    – keluar dengan kode 1 dan pesan di stderr
 *   garbage  – mencetak sampah yang bukan JSON
 *   slow     – menggantung sampai dibunuh
 *   empty    – keluar 0 tanpa output sama sekali
 */

const args = process.argv.slice(2)
const mode = process.env.TITAH_STUB_MODE ?? "claude"

function argAfter(...names) {
  for (const name of names) {
    const index = args.indexOf(name)
    if (index !== -1 && args[index + 1] !== undefined) return args[index + 1]
  }
  return undefined
}

const prompt = args.find((arg) => !arg.startsWith("-") && arg !== "run") ?? ""

if (mode === "crash") {
  process.stderr.write("stub: something exploded\n")
  process.exit(1)
}

if (mode === "garbage") {
  process.stdout.write("bukan json sama sekali\n<html>halo</html>\n")
  process.exit(0)
}

if (mode === "empty") {
  process.exit(0)
}

if (mode === "slow") {
  setInterval(() => {}, 1000)
} else if (mode === "opencode") {
  const session = argAfter("--session", "-s") ?? "ses_stub_baru"
  const line = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)

  line({ type: "step_start", sessionID: session, part: { type: "step-start" } })
  line({ type: "tool", sessionID: session, part: { tool: "read" } })
  line({
    type: "text",
    sessionID: session,
    part: { type: "text", text: `opencode menjawab: ${prompt}` },
  })
  line({
    type: "step_finish",
    sessionID: session,
    part: { type: "step-finish", tokens: { input: 120, output: 7 }, cost: 0.0012 },
  })
} else {
  // mode claude
  const session = argAfter("--session-id", "--resume") ?? "00000000-0000-0000-0000-000000000000"
  const resuming = args.includes("--resume")
  const line = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)

  line({ type: "system", subtype: "init", session_id: session })
  line({
    type: "assistant",
    session_id: session,
    message: { content: [{ type: "tool_use", name: "Read" }] },
  })
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    duration_ms: 42,
    result: `${resuming ? "lanjutan" : "awal"}: ${prompt}`,
    total_cost_usd: 0.0345,
    usage: { input_tokens: 200, output_tokens: 11 },
  })
}
