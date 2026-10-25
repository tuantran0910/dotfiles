return {
  "github/copilot.vim",
  enabled = true,
  lazy = false, -- Ensures it loads on startup so the :Copilot command is available
  config = function()
    -- Optional: Change the mapping for accepting suggestions
    -- vim.g.copilot_no_tab_map = true
    -- vim.api.nvim_set_keymap("i", "<C-J>", 'copilot#Accept("<CR>")', { silent = true, expr = true })
  end,
}
