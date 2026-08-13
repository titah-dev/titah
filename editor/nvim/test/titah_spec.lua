-- Uji bagian MURNI plugin, dijalankan oleh `nvim --headless -l`.
--
-- Yang diuji di sini hanya yang tidak butuh server, jaringan, atau proses:
-- penyusunan prompt, rentang seleksi, pembacaan URL. Sisanya — streaming SSE,
-- pembuatan sesi — tidak diuji di sini karena yang akan terbukti hanyalah
-- tiruan curl-nya bekerja, bukan plugin-nya.

local gagal = 0

local function periksa(nama, benar, detail)
  if benar then
    io.write("  ok   " .. nama .. "\n")
  else
    gagal = gagal + 1
    io.write("  GAGAL " .. nama .. (detail and ("  → " .. tostring(detail)) or "") .. "\n")
  end
end

local titah = require("titah")

-- ---------- context_line ----------

local cwd = vim.fn.getcwd()

periksa("path dibuat relatif terhadap cwd", titah.context_line(cwd .. "/src/a.ts") == "src/a.ts")

periksa(
  "satu baris ditulis tanpa rentang",
  titah.context_line(cwd .. "/src/a.ts", 12, 12) == "src/a.ts:12"
)

periksa(
  "rentang ditulis sebagai awal-akhir",
  titah.context_line(cwd .. "/src/a.ts", 12, 30) == "src/a.ts:12-30"
)

periksa("buffer tanpa nama disebut apa adanya", titah.context_line("") == "(unsaved buffer)")

-- ---------- build_prompt ----------

local prompt = titah.build_prompt("kenapa ini gagal?", "src/a.ts:1-2", { "const a = 1", "" }, "typescript")

periksa("pertanyaannya ada di depan", prompt:match("^kenapa ini gagal%?") ~= nil)
periksa("konteksnya disebut", prompt:find("src/a.ts:1-2", 1, true) ~= nil)
periksa("kodenya dipagari dengan label bahasa", prompt:find("```typescript", 1, true) ~= nil)
periksa("pagarnya ditutup", select(2, prompt:gsub("```", "")) == 2)

local tanpa_tanya = titah.build_prompt("", "src/a.ts", { "x" }, "")
periksa(
  "tanpa pertanyaan, tidak ada baris kosong menggantung di depan",
  tanpa_tanya:sub(1, 1) ~= "\n"
)

-- ---------- parse_server_url ----------

periksa(
  "URL dibaca dari keluaran serve",
  titah.parse_server_url("titah serve 0.1.0\n  http://127.0.0.1:58065\n") == "http://127.0.0.1:58065"
)

periksa(
  "port acak tidak ditebak: keluaran tanpa URL menghasilkan nil",
  titah.parse_server_url("titah serve 0.1.0\n") == nil
)

-- ---------- selection_range ----------

vim.api.nvim_buf_set_lines(0, 0, -1, false, { "satu", "dua", "tiga", "empat" })
vim.api.nvim_buf_set_mark(0, "<", 3, 0, {})
vim.api.nvim_buf_set_mark(0, ">", 1, 0, {})
local a, b = titah.selection_range()
periksa("seleksi ke ATAS tetap menghasilkan rentang yang urut", a == 1 and b == 3, a .. "-" .. b)

-- ---------- setup ----------

titah.setup({ cmd = "titah-lain", size = 0.5 })
periksa("setup menimpa yang disebut", titah.config.cmd == "titah-lain")
periksa("setup tidak menghapus yang tidak disebut", titah.config.split == "vertical")

io.write(gagal == 0 and "\nSEMUA LULUS\n" or ("\n" .. gagal .. " GAGAL\n"))
vim.cmd(gagal == 0 and "qall!" or "cquit!")
