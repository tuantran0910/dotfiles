return {
  "crnvl96/lazydocker.nvim",
  event = "VeryLazy",
  opts = {
    window = {
      settings = {
        width = 0.8,
        height = 0.8,
        border = "rounded",
      },
    },
  },
  keys = {
    {
      "<leader>ld",
      function()
        require("lazydocker").toggle({ engine = "docker" })
      end,
      desc = "LazyDocker",
      mode = { "n" }, -- Works in Normal and Terminal mode
    },
  },
}
