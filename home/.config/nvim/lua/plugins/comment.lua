return {
  "numToStr/Comment.nvim",
  event = { "BufReadPost", "BufNewFile" }, -- Lazy load when opening a file
  opts = {
    -- Add a space between comment and the line
    padding = true,
    -- Whether the cursor should stay at its position
    sticky = true,
    -- Lines to be ignored (e.g., empty lines)
    ignore = "^$",
    -- Normal mode mappings
    toggler = {
      line = "gcc", -- Toggle current line with //
      block = "gbc", -- Toggle current line with /* */
    },
    -- Visual/Operator-pending mappings
    opleader = {
      line = "gc",
      block = "gb",
    },
    -- Extra mappings (Add comment above/below/EOL)
    extra = {
      above = "gcO",
      below = "gco",
      eol = "gcA",
    },
    -- Enable all basic and extra mappings
    mappings = {
      basic = true,
      extra = true,
    },
  },
}
