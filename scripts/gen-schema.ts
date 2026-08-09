import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { Config } from "../src/core/schema.ts"

/**
 * config.schema.json digenerate dari zod, tidak ditulis tangan — supaya schema
 * yang dipublikasikan tidak pernah melenceng dari validasi runtime.
 */
const schema = z.toJSONSchema(Config, { io: "input" })
const withMeta = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Titah configuration",
  ...schema,
}

const target = path.join(import.meta.dirname, "..", "config.schema.json")
fs.writeFileSync(target, `${JSON.stringify(withMeta, null, 2)}\n`)
process.stdout.write(`Ditulis: ${target}\n`)
