-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Only works on Neovim 0.11+
vim.lsp.enable("ruff")

vim.lsp.config("ruff", {
  init_options = {
    settings = {
      -- Your Ruff language server settings
      lineLength = 100,
    },
  },
})
