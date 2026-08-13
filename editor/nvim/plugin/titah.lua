-- Perintah didaftarkan di sini, konfigurasi tetap di `require("titah").setup`.
--
-- Modulnya sendiri dimuat MALAS: `require` di berkas ini akan menambah waktu
-- start Neovim untuk setiap orang yang memasang plugin ini, termasuk yang hari
-- itu tidak menyentuh Titah sama sekali.

if vim.g.loaded_titah == 1 then return end
vim.g.loaded_titah = 1

local function titah()
  return require("titah")
end

vim.api.nvim_create_user_command("Titah", function(opts)
  titah().open(opts.args ~= "" and opts.args or nil)
end, { nargs = "*", desc = "Buka TUI Titah di terminal split" })

vim.api.nvim_create_user_command("TitahAsk", function(opts)
  -- `range` menandai apakah perintahnya dipanggil atas seleksi. Tanpa itu,
  -- `:TitahAsk` biasa akan mengirim satu baris tempat kursor berada dan
  -- terlihat seperti seluruh berkasnya hilang.
  titah().ask(opts.args, opts.range ~= 0)
end, { nargs = "*", range = true, desc = "Tanyakan tentang berkas atau seleksi ini" })

vim.api.nvim_create_user_command("TitahStop", function()
  titah().stop()
end, { desc = "Hentikan server yang dinyalakan plugin ini" })
