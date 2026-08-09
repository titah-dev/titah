import { parseArgs } from "node:util"
import { generateText } from "ai"
import { loadConfig } from "../src/core/config.ts"
import { resolveModel } from "../src/core/provider.ts"

/**
 * Definition of Done untuk M0: satu panggilan LLM nyata yang berhasil, lewat
 * jalur config + kredensial + provider yang sesungguhnya — bukan mock.
 *
 *   node scripts/smoke.ts
 *   node scripts/smoke.ts --model 9router/ocode --prompt "name three colours"
 */

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    prompt: { type: "string", short: "p" },
  },
})

const prompt =
  values.prompt ?? "Reply with exactly one word: OK. Add nothing else."

const loaded = loadConfig()
const target = values.model ?? loaded.config.model
process.stderr.write(`model   : ${target ?? "(default from config)"}\n`)
process.stderr.write(`sources : ${loaded.sources.join(", ") || "(no config file)"}\n`)
process.stderr.write(`prompt  : ${prompt}\n\n`)

const started = process.hrtime.bigint()
const result = await generateText({
  model: resolveModel(loaded.config, values.model),
  prompt,
})
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

process.stdout.write(`${result.text.trim()}\n`)
process.stderr.write(
  `\ndone    : ${elapsedMs.toFixed(0)} ms · ` +
    `${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out\n`,
)
