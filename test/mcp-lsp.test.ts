import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import {
  applyEdits,
  diagnoseFile,
  formatFile,
  renderDiagnostics,
  stopAllLanguageServers,
} from "../src/core/lsp.ts"
import { loadMcpTools, McpServer, stopAllMcpServers } from "../src/core/mcp.ts"
import { MessageBuffer, encode } from "../src/core/rpc.ts"
import { Config } from "../src/core/schema.ts"
import { ToolError } from "../src/core/tool/types.ts"

/**
 * MCP dan LSP, di atas transport JSON-RPC yang sama.
 *
 * Test di sini menjalankan SERVER SUNGGUHAN — skrip node kecil yang bicara
 * protokolnya — bukan mock dari klien yang sedang diuji. Mock akan membuktikan
 * klien berbicara dengan dirinya sendiri; yang perlu dibuktikan adalah ia
 * berbicara dengan proses lain lewat stdio, karena di situlah pembingkaian,
 * pemotongan potongan, dan kematian proses benar-benar terjadi.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titah-rpc-"))

after(() => {
  stopAllMcpServers()
  stopAllLanguageServers()
})

function script(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

// ---------- pembingkaian ----------

test("Content-Length dihitung dalam BYTE, bukan karakter", () => {
  // Teks non-ASCII membuat keduanya berbeda, dan server yang membaca terlalu
  // sedikit akan menggeser SELURUH aliran sesudahnya tanpa pernah pulih.
  const framed = encode("content-length", { pesan: "π ölçü" })
  const header = /Content-Length: (\d+)/.exec(framed)
  const body = framed.slice(framed.indexOf("\r\n\r\n") + 4)
  assert.equal(Number(header?.[1]), Buffer.byteLength(body, "utf8"))
  assert.notEqual(Buffer.byteLength(body, "utf8"), body.length, "prasyarat: memang ada non-ASCII")
})

test("satu pesan yang terbelah beberapa potongan tetap dirakit utuh", () => {
  // Stdio datang dalam potongan sembarang. Ini satu-satunya alasan MessageBuffer
  // ada, jadi ia diuji dengan pembelahan yang paling menyusahkan: per byte.
  const buffer = new MessageBuffer("content-length")
  const framed = Buffer.from(encode("content-length", { a: 1, b: "dua" }), "utf8")
  const out: unknown[] = []
  for (const byte of framed) out.push(...buffer.push(Buffer.from([byte])))
  assert.deepEqual(out, [{ a: 1, b: "dua" }])
})

test("dua pesan dalam satu potongan keluar dua-duanya", () => {
  const buffer = new MessageBuffer("ndjson")
  const chunk = Buffer.from(encode("ndjson", { n: 1 }) + encode("ndjson", { n: 2 }), "utf8")
  assert.deepEqual(buffer.push(chunk), [{ n: 1 }, { n: 2 }])
})

test("baris yang bukan JSON dibuang, tidak menjatuhkan koneksi", () => {
  // Server yang menulis catatan ke stdout adalah kesalahan yang umum, dan
  // mematikan integrasi karenanya membuat satu baris cerewet menjatuhkan
  // semuanya.
  const buffer = new MessageBuffer("ndjson")
  assert.deepEqual(buffer.push(Buffer.from('starting up...\n{"ok":true}\n')), [{ ok: true }])
})

// ---------- MCP ----------

const MCP_SERVER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let i
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } })
    if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "boom", description: "Always fails" },
    ] } })
    if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "it broke" }] } })
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } })
      }
    }
  }
})
`

test("server MCP sungguhan: jabat tangan, daftar tool, panggil", async () => {
  const file = script("mcp-ok.mjs", MCP_SERVER)
  const config = Config.parse({ mcp: { demo: { command: process.execPath, args: [file] } } })

  const { tools, failures } = await loadMcpTools(config, dir)
  assert.deepEqual(failures, [])
  // Diberi awalan nama server: dua server yang sama-sama menawarkan `search`
  // adalah kejadian biasa, dan tanpa awalan yang kedua menimpa yang pertama.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["demo_boom", "demo_echo"])

  const echo = tools.find((tool) => tool.name === "demo_echo")
  const result = await echo!.execute({ text: "halo" }, {} as never)
  assert.match(result.output, /echo: halo/)
})

test("skema aslinya ikut dikirim ke model, meski validasinya longgar", async () => {
  const file = script("mcp-ok2.mjs", MCP_SERVER)
  const config = Config.parse({ mcp: { demo2: { command: process.execPath, args: [file] } } })
  const { tools } = await loadMcpTools(config, dir)
  const echo = tools.find((tool) => tool.name === "demo2_echo")

  // Menerjemahkan JSON Schema sembarang ke Zod dengan setia adalah proyek
  // tersendiri, dan terjemahan yang tidak setia MENOLAK panggilan yang sah.
  // Jadi skemanya diteruskan sebagai teks, dan validasinya diserahkan ke server.
  assert.match(echo!.description, /Input schema/)
  assert.match(echo!.description, /"text"/)
})

test("isError dari MCP jadi ToolError, bukan hasil yang terlihat sukses", async () => {
  const file = script("mcp-ok3.mjs", MCP_SERVER)
  const config = Config.parse({ mcp: { demo3: { command: process.execPath, args: [file] } } })
  const { tools } = await loadMcpTools(config, dir)
  const boom = tools.find((tool) => tool.name === "demo3_boom")

  await assert.rejects(() => boom!.execute({}, {} as never), (error: unknown) => {
    assert.ok(error instanceof ToolError)
    assert.match(error.message, /it broke/)
    return true
  })
})

test("server MCP yang tidak ada TIDAK menjatuhkan giliran", async () => {
  // Server MCP dipasang user dan bisa rusak karena hal yang sama sekali tidak
  // berhubungan dengan Titah. Satu server rusak kehilangan tool-nya; ia tidak
  // boleh menghentikan pekerjaan.
  const config = Config.parse({
    mcp: { hilang: { command: path.join(dir, "tidak-ada-binernya"), args: [] } },
  })
  const { tools, failures } = await loadMcpTools(config, dir)

  assert.deepEqual(tools, [])
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.id, "hilang")
  assert.ok((failures[0]?.reason ?? "").length > 0, "alasannya harus disebut, bukan dikosongkan")
})

test("server yang mati saat jabat tangan melaporkan stderr-nya", async () => {
  const file = script("mcp-crash.mjs", 'process.stderr.write("config file missing\\n"); process.exit(2)')
  const config = Config.parse({ mcp: { rusak: { command: process.execPath, args: [file] } } })
  const { failures } = await loadMcpTools(config, dir)

  // Tanpa stderr, satu-satunya yang user lihat adalah "tidak merespons" — dan
  // penjelasannya selalu ada di sana.
  assert.match(failures[0]?.reason ?? "", /config file missing/)
})

test("server yang dimatikan lewat enabled: false tidak pernah dinyalakan", async () => {
  const config = Config.parse({
    mcp: { mati: { command: path.join(dir, "tidak-ada"), args: [], enabled: false } },
  })
  const { tools, failures } = await loadMcpTools(config, dir)
  assert.deepEqual(tools, [])
  assert.deepEqual(failures, [], "yang dimatikan bukan kegagalan")
})

test("tool MCP memakai sumbu izin `mcp`, dan dialognya menyatakan ia pihak ketiga", async () => {
  const file = script("mcp-ok4.mjs", MCP_SERVER)
  const config = Config.parse({ mcp: { demo4: { command: process.execPath, args: [file] } } })
  const { tools } = await loadMcpTools(config, dir)
  const need = tools[0]?.permission?.({ text: "x" }, {} as never)

  assert.equal(need?.kind, "mcp")
  assert.match(need?.detail ?? "", /third-party code/)
  assert.match(need?.detail ?? "", /cannot see what it does/)
})

test("McpServer.connect kedua kali memakai hasil yang sudah ada", async () => {
  const file = script("mcp-once.mjs", MCP_SERVER)
  const server = McpServer.stdio("sekali", { command: process.execPath, args: [file], cwd: dir })
  const first = await server.connect()
  const second = await server.connect()
  assert.equal(first, second, "daftar yang sama, bukan permintaan kedua")
  server.stop()
})

// ---------- LSP ----------

const LSP_SERVER = `
let buf = Buffer.alloc(0)
const send = (m) => {
  const body = JSON.stringify(m)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body)
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n")
    if (sep === -1) break
    const len = Number(/content-length:\\s*(\\d+)/i.exec(buf.subarray(0, sep).toString())[1])
    if (buf.length < sep + 4 + len) break
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"))
    buf = buf.subarray(sep + 4 + len)
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })
    if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
      const uri = msg.params.textDocument.uri
      const text = msg.method === "textDocument/didOpen" ? msg.params.textDocument.text : msg.params.contentChanges[0].text
      const diagnostics = text.includes("RUSAK")
        ? [{ range: { start: { line: 2, character: 4 } }, severity: 1, message: "type mismatch", source: "uji" }]
        : []
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } })
    }
  }
})
`

const lspConfig = (file: string) =>
  Config.parse({ lsp: { uji: { command: process.execPath, args: [file], extensions: [".uji"] } } })

test("language server sungguhan: berkas rusak melaporkan diagnostics", async () => {
  const server = script("lsp.mjs", LSP_SERVER)
  const target = path.join(dir, "a.uji")
  fs.writeFileSync(target, "baris\nbaris\nRUSAK di sini\n")

  const found = await diagnoseFile(lspConfig(server), dir, target)
  assert.equal(found?.length, 1)
  // LSP memakai baris/kolom berbasis nol; manusia dan compiler tidak.
  assert.equal(found?.[0]?.line, 3)
  assert.equal(found?.[0]?.column, 5)
  assert.equal(found?.[0]?.severity, "error")
  assert.match(found?.[0]?.message ?? "", /type mismatch/)
})

test("berkas bersih memberi array KOSONG, bukan undefined", async () => {
  // Bedanya menentukan: kosong berarti "sudah diperiksa dan bersih", undefined
  // berarti "tidak tahu". Menyamakannya membuat yang belum diperiksa terbaca
  // sebagai tidak ada masalah.
  const server = script("lsp2.mjs", LSP_SERVER)
  const target = path.join(dir, "b.uji")
  fs.writeFileSync(target, "semuanya baik\n")

  assert.deepEqual(await diagnoseFile(lspConfig(server), dir, target), [])
})

test("berkas yang tidak ditangani server mana pun memberi undefined", async () => {
  const server = script("lsp3.mjs", LSP_SERVER)
  const target = path.join(dir, "c.lain")
  fs.writeFileSync(target, "RUSAK")

  assert.equal(await diagnoseFile(lspConfig(server), dir, target), undefined)
})

test("tanpa lsp yang dikonfigurasi, hasilnya undefined dan tidak ada proses dinyalakan", async () => {
  assert.equal(await diagnoseFile(Config.parse({}), dir, path.join(dir, "a.uji")), undefined)
})

test("suntingan KEDUA pada berkas yang sama tetap terpantau", async () => {
  // Server menolak didOpen kedua untuk URI yang sama, dan penolakan itu DIAM:
  // diagnostics berhenti diperbarui tanpa ada yang tahu. Karena itu yang kedua
  // harus didChange.
  const server = script("lsp4.mjs", LSP_SERVER)
  const config = lspConfig(server)
  const target = path.join(dir, "d.uji")

  fs.writeFileSync(target, "bersih\n")
  assert.deepEqual(await diagnoseFile(config, dir, target), [])

  fs.writeFileSync(target, "\n\nRUSAK sekarang\n")
  const after = await diagnoseFile(config, dir, target)
  assert.equal(after?.length, 1, "perubahan kedua harus terlihat")
})

test("render diagnostics menyebut path, posisi, dan jumlahnya", () => {
  const text = renderDiagnostics("src/a.ts", [
    { line: 3, column: 5, severity: "error", message: "boom", source: "tsc" },
  ])
  assert.match(text, /diagnostics \(1\)/)
  assert.match(text, /src\/a\.ts:3:5 error: boom \(tsc\)/)
})

test("nol diagnostics tidak menambahkan apa pun ke hasil tool", () => {
  // Menempelkan "0 diagnostics" ke setiap suntingan adalah baris yang tidak
  // pernah berubah, dan baris yang tidak pernah berubah berhenti dibaca.
  assert.equal(renderDiagnostics("a.ts", []), "")
})

// ---------- LSP: formatter ----------

/**
 * Server yang MENGAKUI bisa memformat, dan menjawab dengan dua TextEdit yang
 * sengaja diberikan dalam urutan maju.
 *
 * Urutan itu yang diuji. Spesifikasi LSP menjamin edit tidak tumpang tindih
 * tapi tidak menjamin urutannya, dan menerapkannya dari depan menggeser setiap
 * posisi sesudahnya sebanyak selisih panjang teks pengganti.
 */
const LSP_FORMATTER = `
let buf = Buffer.alloc(0)
const send = (m) => {
  const body = JSON.stringify(m)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body)
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n")
    if (sep === -1) break
    const len = Number(/content-length:\\s*(\\d+)/i.exec(buf.subarray(0, sep).toString())[1])
    if (buf.length < sep + 4 + len) break
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"))
    buf = buf.subarray(sep + 4 + len)
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { documentFormattingProvider: true } } })
    }
    if (msg.method === "textDocument/formatting") {
      send({ jsonrpc: "2.0", id: msg.id, result: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "satu" },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: "dua" },
      ] })
    }
    if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
             params: { uri: msg.params.textDocument.uri, diagnostics: [] } })
    }
  }
})
`

test("berkas diformat di tempat, dan id servernya dilaporkan", async () => {
  const server = script("fmt1.mjs", LSP_FORMATTER)
  const target = path.join(dir, "f1.uji")
  fs.writeFileSync(target, "AAAA\nBBBB\n")

  const by = await formatFile(lspConfig(server), dir, target)
  assert.equal(by, "uji", "yang memformat disebut namanya")
  assert.equal(fs.readFileSync(target, "utf8"), "satu\ndua\n")
})

test("format: false dihormati, servernya tidak pernah ditanyai", async () => {
  const server = script("fmt2.mjs", LSP_FORMATTER)
  const config = Config.parse({
    lsp: { uji: { command: process.execPath, args: [server], extensions: [".uji"], format: false } },
  })
  const target = path.join(dir, "f2.uji")
  fs.writeFileSync(target, "AAAA\nBBBB\n")

  assert.equal(await formatFile(config, dir, target), undefined)
  assert.equal(fs.readFileSync(target, "utf8"), "AAAA\nBBBB\n", "berkas tidak disentuh")
})

test("server yang TIDAK mengaku bisa memformat tidak pernah diminta", async () => {
  /*
   * Kapabilitasnya dibaca dari jawaban `initialize`, bukan diasumsikan.
   * Mengirim `textDocument/formatting` ke server yang tidak mendukungnya bukan
   * sekadar sia-sia: sebagian menjawab error, dan error itu terbaca seperti
   * suntingannya yang bermasalah.
   */
  const server = script("fmt3.mjs", LSP_SERVER)
  const target = path.join(dir, "f3.uji")
  fs.writeFileSync(target, "AAAA\nBBBB\n")

  assert.equal(await formatFile(lspConfig(server), dir, target), undefined)
  assert.equal(fs.readFileSync(target, "utf8"), "AAAA\nBBBB\n")
})

test("TextEdit diterapkan dari BELAKANG, supaya posisinya tidak bergeser", () => {
  /*
   * Ini inti perbaikannya, dan ia bisa diuji tanpa proses sama sekali.
   * Edit pertama memanjangkan teks; kalau diterapkan lebih dulu, offset edit
   * kedua meleset sebanyak selisihnya dan hasilnya berkas yang rusak dengan
   * cara yang terlihat acak.
   */
  const text = "ab\ncd\n"
  const edits = [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "PANJANG" },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: "XY" },
  ]

  assert.equal(applyEdits(text, edits), "PANJANG\nXY\n")
  assert.equal(applyEdits(text, [...edits].reverse()), "PANJANG\nXY\n", "urutan masukan tidak berpengaruh")
})

test("posisi di luar berkas dijepit, bukan merusak isinya", () => {
  // Server yang salah hitung satu baris tidak boleh membuat berkas orang hilang.
  const text = "satu\ndua\n"
  const jauh = [
    { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 9 } }, newText: "X" },
  ]
  assert.equal(applyEdits(text, jauh), "satu\ndua\nX")

  const kolomLewat = [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 999 } }, newText: "Z" },
  ]
  assert.equal(applyEdits(text, kolomLewat), "Z\ndua\n", "kolom dijepit di ujung barisnya")
})

test("berkas yang sudah rapi tidak ditulis ulang", async () => {
  // Menulis ulang berkas dengan isi yang sama tetap mengubah mtime, dan itu
  // memicu watcher, rebuild, dan test runner tanpa ada yang berubah.
  const server = script("fmt4.mjs", LSP_FORMATTER)
  const target = path.join(dir, "f4.uji")
  fs.writeFileSync(target, "satu\ndua\n")
  const sebelum = fs.statSync(target).mtimeMs

  assert.equal(await formatFile(lspConfig(server), dir, target), undefined)
  assert.equal(fs.statSync(target).mtimeMs, sebelum, "mtime tidak berubah")
})
