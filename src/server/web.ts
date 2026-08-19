/**
 * Klien web, satu berkas, tanpa build step.
 *
 * # Kenapa disematkan sebagai string, bukan aset yang dibundel
 *
 * Titah dipasang lewat npm dan dijalankan sebagai satu biner. Aset yang harus
 * disalin, ditemukan lewat path relatif, lalu disajikan adalah tiga cara baru
 * untuk gagal pada mesin orang lain — dan ketiganya gagal dengan gejala yang
 * sama: halaman kosong tanpa satu pun petunjuk. String tidak bisa hilang.
 *
 * # Kenapa tanpa framework
 *
 * Yang dibutuhkan halaman ini: daftar, aliran teks, dan satu kotak ketik.
 * Tidak ada satu pun dari itu yang lebih mudah dengan build step, dan build
 * step adalah hal yang harus dijaga tetap bekerja selamanya.
 *
 * # Batasnya, dinyatakan
 *
 * Ini bukan TUI di dalam browser. Yang ada: daftar sesi, riwayat, aliran
 * jawaban, kirim prompt, jawab izin, dan hentikan giliran. Yang TIDAK ada:
 * panel sub-agent, /undo, pemilih model, pemilih skill. Semuanya masih ada di
 * TUI dan di CLI.
 */

export const WEB_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Titah</title>
<style>
  :root {
    --ground: #0e1413; --surface: #151d1b; --raised: #1b2523;
    --ink: #e4eae7; --muted: #93a19d; --faint: #6f7d79;
    --rule: #26332f; --accent: #45b6a9;
    --ok: #58c288; --bad: #e08872; --warn: #d9b25f;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    height: 100vh; display: grid; grid-template-columns: 260px 1fr;
  }
  @media (max-width: 720px) { body { grid-template-columns: 1fr; } aside { display: none; } }

  aside {
    border-right: 1px solid var(--rule); background: var(--surface);
    display: flex; flex-direction: column; overflow: hidden;
  }
  aside header {
    padding: 14px 16px; border-bottom: 1px solid var(--rule);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .brand { font-family: var(--mono); font-weight: 600; color: var(--accent); letter-spacing: .04em; }
  #sessions { overflow-y: auto; flex: 1; }
  .session {
    padding: 10px 16px; border-bottom: 1px solid var(--rule);
    cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  }
  .session:hover { background: var(--raised); }
  .session[aria-current="true"] { background: var(--raised); box-shadow: inset 3px 0 0 var(--accent); }
  .session .t { color: var(--ink); font-size: 13px; }
  .session .d { color: var(--faint); font-size: 11px; font-family: var(--mono); }

  main { display: flex; flex-direction: column; overflow: hidden; }
  #log { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }

  .msg { display: flex; flex-direction: column; gap: 4px; max-width: 82ch; }
  .msg .who {
    font-family: var(--mono); font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--faint);
  }
  .msg.user .who { color: var(--accent); }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  .msg.user .body {
    background: var(--surface); border-left: 2px solid var(--accent);
    padding: 8px 12px; border-radius: 0 3px 3px 0;
  }
  .tool {
    font-family: var(--mono); font-size: 12.5px; color: var(--muted);
    display: flex; gap: 8px; align-items: baseline;
  }
  .tool .g { color: var(--ok); }
  .tool.bad .g, .tool.bad { color: var(--bad); }
  .tool.run .g { color: var(--warn); }

  .panel {
    margin: 0 24px; padding: 12px 14px; border: 1px solid var(--warn);
    border-radius: 4px; background: var(--surface);
    display: flex; flex-direction: column; gap: 8px;
  }
  .panel h3 { margin: 0; font-size: 13px; color: var(--warn); font-family: var(--mono); }
  .panel pre {
    margin: 0; font-family: var(--mono); font-size: 12px; color: var(--muted);
    white-space: pre-wrap; max-height: 160px; overflow: auto;
  }
  .panel .row { display: flex; gap: 8px; flex-wrap: wrap; }

  button {
    font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 3px;
    border: 1px solid var(--rule); background: var(--raised); color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.primary { background: var(--accent); color: #08110f; border-color: var(--accent); font-weight: 600; }

  form {
    border-top: 1px solid var(--rule); padding: 12px 24px 16px;
    display: flex; gap: 10px; align-items: flex-end; background: var(--surface);
  }
  textarea {
    flex: 1; resize: none; font: inherit; padding: 9px 12px; min-height: 44px; max-height: 200px;
    background: var(--ground); color: var(--ink); border: 1px solid var(--rule); border-radius: 3px;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .status {
    font-family: var(--mono); font-size: 11px; color: var(--faint);
    padding: 0 24px 8px; background: var(--surface);
  }
  .empty { color: var(--faint); padding: 40px 24px; }
</style>
</head>
<body>
<aside>
  <header>
    <span class="brand">titah</span>
    <button id="new" title="Start a new session">new</button>
  </header>
  <div id="sessions"></div>
</aside>

<main>
  <div id="log"><p class="empty">Pick a session, or start a new one.</p></div>
  <div id="panels"></div>
  <div class="status" id="status"></div>
  <form id="composer">
    <textarea id="prompt" placeholder="Ask Titah…  (Enter to send, Shift+Enter for a newline)" rows="1"></textarea>
    <button type="submit" class="primary" id="send">Send</button>
    <button type="button" id="stop" hidden>Stop</button>
  </form>
</main>

<script>
const api = (p, o) => fetch(p, o).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(t) }))
const el = id => document.getElementById(id)
const log = el("log"), panels = el("panels"), status = el("status")
let current = null, source = null, working = false

const escape = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))

async function loadSessions() {
  const list = await api("/session")
  const box = el("sessions")
  box.innerHTML = ""
  for (const s of list) {
    const row = document.createElement("div")
    row.className = "session"
    row.tabIndex = 0
    if (s.id === current) row.setAttribute("aria-current", "true")
    row.innerHTML = '<span class="t">' + escape(s.title || "(untitled)") +
      '</span><span class="d">' + escape(s.id.slice(4, 12)) + "</span>"
    const open = () => select(s.id)
    row.onclick = open
    row.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open() } }
    box.append(row)
  }
}

function line(cls, who, body) {
  const wrap = document.createElement("div")
  wrap.className = "msg " + cls
  wrap.innerHTML = '<span class="who">' + escape(who) + '</span><div class="body">' + escape(body) + "</div>"
  log.append(wrap)
  return wrap.querySelector(".body")
}

function toolLine(part) {
  const st = part.state || {}
  const done = st.status === "completed"
  const bad = st.status === "error" || st.status === "denied" || st.outcome === "failed"
  const glyph = bad ? "✗" : done ? "✓" : "◐"
  const row = document.createElement("div")
  row.className = "tool" + (bad ? " bad" : done ? "" : " run")
  row.dataset.call = part.callID
  row.innerHTML = '<span class="g">' + glyph + "</span><span>" +
    escape(st.title || part.tool) + (st.reason ? " — " + escape(st.reason) : "") + "</span>"
  return row
}

/**
 * Riwayat digambar ulang SELURUHNYA dari snapshot.
 *
 * \`message.updated\` membawa seluruh part tiap kali dikirim, jadi menambal
 * satu per satu berarti melacak apa yang sudah tergambar — pembukuan yang
 * pernah salah di TUI dan menghasilkan tool tercetak berkali-kali.
 */
function render(messages) {
  log.innerHTML = ""
  if (messages.length === 0) {
    log.innerHTML = '<p class="empty">Nothing here yet. Say something.</p>'
    return
  }
  for (const m of messages) {
    const text = (m.parts || []).filter(p => p.type === "text").map(p => p.text).join("")
    if (m.role === "user") { line("user", "you", text); continue }
    const holder = document.createElement("div")
    holder.className = "msg"
    holder.innerHTML = '<span class="who">' + escape(m.agent || "titah") + "</span>"
    const body = document.createElement("div")
    body.className = "body"
    for (const part of m.parts || []) {
      if (part.type === "tool") body.append(toolLine(part))
    }
    if (text) {
      const t = document.createElement("div")
      t.textContent = text
      body.append(t)
    }
    if (m.error) {
      const e = document.createElement("div")
      e.className = "tool bad"
      e.textContent = "⚠ " + m.error
      body.append(e)
    }
    holder.append(body)
    log.append(holder)
  }
  log.scrollTop = log.scrollHeight
}

function setWorking(on) {
  working = on
  el("send").disabled = on
  el("stop").hidden = !on
  status.textContent = on ? "working…" : ""
}

async function select(id) {
  current = id
  panels.innerHTML = ""
  await loadSessions()
  render(await api("/session/" + id + "/message"))
  const state = await api("/session/" + id + "/status")
  setWorking(state.running)
  listen()
}

/**
 * Satu stream pengamat per sesi, dan yang lama SELALU ditutup.
 *
 * Berpindah sesi tanpa menutupnya meninggalkan EventSource yang masih
 * menggambar ke layar yang sudah menampilkan sesi lain — dua percakapan
 * bercampur, dan tidak ada di layar yang menjelaskan kenapa.
 */
function listen() {
  if (source) source.close()
  source = new EventSource("/event?session=" + encodeURIComponent(current))
  source.onmessage = async ev => {
    const e = JSON.parse(ev.data)
    if (e.type === "message.updated" || e.type === "text.delta") {
      render(await api("/session/" + current + "/message"))
    }
    if (e.type === "session.idle") { setWorking(false); loadSessions() }
    if (e.type === "session.notice") status.textContent = "· " + e.message
    if (e.type === "session.error") status.textContent = "error: " + e.message
    if (e.type === "permission.request") askPermission(e.request)
    if (e.type === "question.request") askQuestion(e.request)
  }
}

function panel(title, detail, buttons) {
  const box = document.createElement("div")
  box.className = "panel"
  box.innerHTML = "<h3>" + escape(title) + "</h3>" +
    (detail ? "<pre>" + escape(detail) + "</pre>" : "") + '<div class="row"></div>'
  const row = box.querySelector(".row")
  for (const [label, fn] of buttons) {
    const b = document.createElement("button")
    b.textContent = label
    b.onclick = () => { box.remove(); fn() }
    row.append(b)
  }
  panels.append(box)
  box.querySelector("button")?.focus()
}

function askPermission(request) {
  const send = decision =>
    api("/session/" + current + "/permission/" + request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    })
  panel(
    (request.agent ? request.agent + " · " : "") + request.kind + " — " + request.title,
    request.detail,
    [["Allow once", () => send("once")], ["Always (" + request.pattern + ")", () => send("always")], ["Deny", () => send("reject")]],
  )
}

function askQuestion(request) {
  const answer = text =>
    api("/session/" + current + "/question/" + request.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: text }),
    })
  const buttons = (request.options || []).map(o => [o, () => answer(o)])
  buttons.push(["Skip", () => answer("")])
  panel("Question", request.question, buttons)
}

el("new").onclick = async () => {
  const session = await api("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  await select(session.id)
}

el("stop").onclick = () => api("/session/" + current + "/abort", { method: "POST" })

el("prompt").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el("composer").requestSubmit() }
})

el("composer").onsubmit = async e => {
  e.preventDefault()
  const box = el("prompt")
  const text = box.value.trim()
  if (text === "" || working) return
  if (!current) {
    const session = await api("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    await select(session.id)
  }
  box.value = ""
  setWorking(true)
  /*
   * \`auto: true\` — di browser tidak ada terminal yang bisa menjawab dialog
   * izin, tapi ADA panel di halaman ini. Jadi yang dikirim bukan auto-approve:
   * permintaan izin tetap datang lewat stream dan dijawab lewat panel itu.
   */
  await api("/session/" + current + "/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(err => { status.textContent = "error: " + err.message; setWorking(false) })
}

loadSessions()
</script>
</body>
</html>`
