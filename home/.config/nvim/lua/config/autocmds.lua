-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

---@diagnostic disable: undefined-global

-- Auto-reload buffers when file changes are detected externally
vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter" }, {
  callback = function()
    vim.cmd("checktime")
  end,
  desc = "Check for external file changes when Neovim gains focus or buffer is entered",
})

-- Handle file changed events more gracefully
vim.api.nvim_create_autocmd("FileChangedShell", {
  callback = function()
    vim.notify("File changed externally, reloading...", vim.log.levels.INFO)
    vim.cmd("checktime")
  end,
  desc = "Auto-reload when file changes are detected",
})
