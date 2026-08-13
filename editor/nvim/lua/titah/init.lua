--- Titah di dalam Neovim.
---
--- Dua jalur, dan keduanya sengaja berbeda sifatnya.
---
--- `:Titah` membuka TUI-nya apa adanya di dalam terminal Neovim. Ia bukan
--- kompromi: TUI itu sudah punya izin, gulir, panel sub-agent, dan semua yang
--- dibangun berbulan-bulan. Menggambar ulang semuanya sebagai antarmuka
--- Neovim berarti membangun hal yang sama untuk kedua kalinya, lebih buruk.
---
--- `:TitahAsk` untuk yang TIDAK bisa dilakukan TUI: mengirim potongan yang
--- sedang dilihat — berkas ini, baris ini, seleksi ini — tanpa mengetik ulang
--- path dan nomor barisnya. Itu satu-satunya hal yang benar-benar hanya bisa
--- diberikan editor, dan itulah yang dikerjakan bagian ini.
---
--- HTTP lewat `curl`. Neovim tidak punya klien HTTP bawaan, dan `curl` ada di
--- setiap mesin yang menjalankan Neovim.

local M = {}

local defaults = {
  --- Server yang dipakai `:TitahAsk`. Kosong berarti dinyalakan sendiri saat
  --- pertama dibutuhkan, lalu dimatikan waktu Neovim ditutup.
  server = nil,
  --- Perintah titah. Ganti kalau ia tidak ada di PATH.
  cmd = "titah",
  --- Ukuran split TUI, sebagai pecahan tinggi/lebar layar.
  size = 0.4,
  --- "horizontal" | "vertical" | "tab"
  split = "vertical",
}

M.config = vim.deepcopy(defaults)

local state = {
  --- job id `titah serve` yang kita nyalakan sendiri, kalau ada.
  serve_job = nil,
  server = nil,
  session = nil,
  --- Buffer terminal TUI, supaya `:Titah` kedua kali kembali ke sana alih-alih
  --- membuka yang baru — dua TUI pada satu proyek saling menimpa riwayatnya.
  term_buf = nil,
}

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  if M.config.server then state.server = M.config.server end
end

-- ---------------------------------------------------------------------------
-- Bagian murni: bisa diuji tanpa server, tanpa jaringan, tanpa proses
-- ---------------------------------------------------------------------------

--- Rentang baris seleksi visual yang TERAKHIR, sudah diurutkan.
---
--- `'<` dan `'>` tidak dijamin urut: menyeleksi dari bawah ke atas menaruh
--- baris yang lebih besar di `'<`. Tanpa penyortiran ini, seleksi ke atas
--- menghasilkan rentang kosong dan yang terkirim bukan apa-apa.
function M.selection_range()
  local a = vim.fn.line("'<")
  local b = vim.fn.line("'>")
  if a > b then a, b = b, a end
  return a, b
end

--- Konteks berkas sebagai satu baris yang bisa dibaca model.
---
--- Path-nya RELATIF terhadap cwd. Path absolut membocorkan nama user ke dalam
--- transkrip, dan model tidak bisa berbuat apa pun dengan `/Users/<nama>/`
--- yang tidak bisa ia lakukan dengan `src/x.ts`.
function M.context_line(name, first, last)
  local rel = vim.fn.fnamemodify(name, ":.")
  if rel == "" then return "(unsaved buffer)" end
  if first == nil then return rel end
  if first == last then return rel .. ":" .. first end
  return rel .. ":" .. first .. "-" .. last
end

--- Menyusun prompt dari apa yang sedang dilihat.
---
--- Kode dibungkus pagar berlabel bahasa, bukan ditempel telanjang: tanpa
--- pagar, kode yang mengandung baris kosong dan tanda pagar terbaca sebagai
--- markdown dan sebagian isinya hilang sebelum sampai ke model.
function M.build_prompt(question, ctx, lines, filetype)
  local parts = {}
  -- Baris kosong hanya dipakai untuk MEMISAHKAN pertanyaan dari konteks. Tanpa
  -- pertanyaan tidak ada yang perlu dipisahkan, dan prompt yang diawali baris
  -- kosong terkirim apa adanya ke model.
  if question and question ~= "" then
    table.insert(parts, question)
    table.insert(parts, "")
  end
  table.insert(parts, "--- " .. ctx .. " ---")
  if lines and #lines > 0 then
    table.insert(parts, "```" .. (filetype or ""))
    table.insert(parts, table.concat(lines, "\n"))
    table.insert(parts, "```")
  end
  return table.concat(parts, "\n")
end

--- Mengambil URL server dari keluaran `titah serve`.
---
--- Portnya acak secara bawaan, jadi ia HARUS dibaca dari keluarannya. Menebak
--- 8080 berarti menabrak apa pun yang kebetulan ada di sana.
function M.parse_server_url(text)
  return text:match("(https?://[%d%.]+:%d+)")
end

-- ---------------------------------------------------------------------------
-- TUI di dalam terminal Neovim
-- ---------------------------------------------------------------------------

local function open_split()
  if M.config.split == "tab" then
    vim.cmd("tabnew")
  elseif M.config.split == "horizontal" then
    vim.cmd("botright split")
    vim.api.nvim_win_set_height(0, math.floor(vim.o.lines * M.config.size))
  else
    vim.cmd("botright vsplit")
    vim.api.nvim_win_set_width(0, math.floor(vim.o.columns * M.config.size))
  end
end

function M.open(args)
  if state.term_buf and vim.api.nvim_buf_is_valid(state.term_buf) and not args then
    local win = vim.fn.bufwinid(state.term_buf)
    if win ~= -1 then
      vim.api.nvim_set_current_win(win)
      return
    end
    open_split()
    vim.api.nvim_win_set_buf(0, state.term_buf)
    vim.cmd("startinsert")
    return
  end

  open_split()
  vim.fn.termopen(M.config.cmd .. " " .. (args or ""), {
    on_exit = function()
      state.term_buf = nil
    end,
  })
  state.term_buf = vim.api.nvim_get_current_buf()
  vim.bo.bufhidden = "hide"
  vim.cmd("startinsert")
end

-- ---------------------------------------------------------------------------
-- Server: dipakai bersama, dinyalakan hanya kalau perlu
-- ---------------------------------------------------------------------------

local function ensure_server(callback)
  if state.server then return callback(state.server) end

  local buffer = ""
  state.serve_job = vim.fn.jobstart({ M.config.cmd, "serve" }, {
    on_stdout = function(_, data)
      if state.server then return end
      buffer = buffer .. table.concat(data or {}, "\n")
      local url = M.parse_server_url(buffer)
      if url then
        state.server = url
        callback(url)
      end
    end,
    on_exit = function()
      state.serve_job = nil
      state.server = nil
    end,
  })

  if state.serve_job <= 0 then
    vim.notify("titah: could not start `" .. M.config.cmd .. " serve`", vim.log.levels.ERROR)
  end
end

local function post(url, body, callback)
  local payload = vim.json.encode(body)
  local out = {}
  vim.fn.jobstart({
    "curl", "-sS", "-X", "POST", "-H", "Content-Type: application/json", "-d", payload, url,
  }, {
    on_stdout = function(_, data) vim.list_extend(out, data or {}) end,
    on_exit = function(_, code)
      local text = table.concat(out, "")
      if code ~= 0 or text == "" then
        return vim.notify("titah: request failed (" .. url .. ")", vim.log.levels.ERROR)
      end
      local ok, decoded = pcall(vim.json.decode, text)
      callback(ok and decoded or nil)
    end,
  })
end

-- ---------------------------------------------------------------------------
-- Buffer jawaban
-- ---------------------------------------------------------------------------

local function answer_buffer()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].filetype = "markdown"
  vim.bo[buf].bufhidden = "wipe"
  open_split()
  vim.api.nvim_win_set_buf(0, buf)
  return buf
end

local function append(buf, text)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local lines = vim.split(text, "\n", { plain = true })
  local last = vim.api.nvim_buf_line_count(buf)
  local tail = vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1] or ""
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, last - 1, last, false, { tail .. lines[1] })
  if #lines > 1 then
    vim.api.nvim_buf_set_lines(buf, -1, -1, false, vim.list_slice(lines, 2))
  end
  vim.bo[buf].modifiable = false
end

--- Mengalirkan jawaban ke buffer, satu potongan teks per event SSE.
---
--- `curl -N` mematikan buffering; tanpanya jawaban muncul sekaligus di akhir,
--- yang menghapus seluruh gunanya streaming pada giliran yang berjalan menit.
local function stream(server, session, buf)
  local pending = ""
  vim.fn.jobstart({ "curl", "-sS", "-N", server .. "/event?session=" .. session }, {
    on_stdout = function(_, data)
      for _, line in ipairs(data or {}) do
        if line:sub(1, 6) == "data: " then
          local ok, event = pcall(vim.json.decode, line:sub(7))
          if ok and type(event) == "table" then
            if event.type == "message.part" and event.part and event.part.type == "text" then
              pending = event.part.text or ""
              vim.schedule(function() append(buf, pending) end)
            elseif event.type == "turn.end" or event.type == "session.idle" then
              vim.schedule(function() append(buf, "\n\n— selesai —\n") end)
            end
          end
        end
      end
    end,
  })
end

-- ---------------------------------------------------------------------------
-- Perintah
-- ---------------------------------------------------------------------------

--- Mengirim pertanyaan bersama potongan yang sedang dilihat.
function M.ask(question, range)
  local bufname = vim.api.nvim_buf_get_name(0)
  local filetype = vim.bo.filetype
  local lines, ctx

  if range then
    local first, last = M.selection_range()
    lines = vim.api.nvim_buf_get_lines(0, first - 1, last, false)
    ctx = M.context_line(bufname, first, last)
  else
    lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    ctx = M.context_line(bufname)
  end

  local prompt = M.build_prompt(question, ctx, lines, filetype)
  local buf = answer_buffer()
  append(buf, "# " .. (question ~= "" and question or ctx) .. "\n\n")

  ensure_server(function(server)
    local function send(session)
      state.session = session
      stream(server, session, buf)
      post(server .. "/session/" .. session .. "/message", { text = prompt }, function() end)
    end

    if state.session then return send(state.session) end
    post(server .. "/session", { directory = vim.fn.getcwd() }, function(created)
      if not created or not created.id then
        return vim.notify("titah: could not create a session", vim.log.levels.ERROR)
      end
      send(created.id)
    end)
  end)
end

function M.stop()
  if state.serve_job then vim.fn.jobstop(state.serve_job) end
  state.serve_job = nil
  state.server = M.config.server
  state.session = nil
end

return M
