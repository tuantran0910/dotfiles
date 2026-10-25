return {
  "supermaven-inc/supermaven-nvim",
  enabled = false,
  config = function()
    require("supermaven-nvim").setup({
      keymaps = {
        accept_suggestion = "<Tab>",
        clear_suggestion = "<C-]>",
        accept_word = "<C-j>", -- Partially accept only the next word
      },
      ignore_filetypes = {
        -- Add filetypes you don't want AI in
        -- help = true,
      },
      color = {
        suggestion_color = "#808080", -- Grey ghost text
      },
      log_level = "info",
    })
  end,
}
