return {
  "coder/claudecode.nvim",
  branch = "main",
  dependencies = { "folke/snacks.nvim" },
  cmd = { "ClaudeCode", "ClaudeCodeFocus" },
  opts = {
    port_range = { min = 10000, max = 65535 },
    auto_start = true,
    log_level = "info",
    track_selection = true,
    visual_demotion_delay_ms = 50,
    focus_after_send = false,
    diff_opts = {
      auto_close_on_accept = true,
      show_diff_stats = true,
      vertical_split = true,
      open_in_current_tab = true,
      keep_terminal_focus = true,
    },
    terminal = {
      snacks_win_opts = {
        position = "float",
        width = 0.8,
        height = 0.8,
        border = "rounded",
        backdrop = false,
        win_opts = {
          winblend = 20,
        },
        keys = {
          claude_hide = {
            "<C-,>",
            function(self)
              self:hide()
            end,
            mode = "t",
            desc = "Hide Claude",
          },
        },
      },
      -- cwd_provider = function(ctx)
      --   -- Returns the directory of the current file
      --   return ctx.file_dir or ctx.cwd
      -- end,
    },
  },
  keys = {
    { "<leader>a", nil, desc = "AI/Claude Code" },
    { "<leader>ac", "<cmd>ClaudeCodeFocus<cr>", desc = "Claude Code" },
    { "<leader>ar", "<cmd>ClaudeCode --resume<cr>", desc = "Resume Claude" },
    { "<leader>aC", "<cmd>ClaudeCode --continue<cr>", desc = "Continue Claude" },
    { "<leader>am", "<cmd>ClaudeCodeSelectModel<cr>", desc = "Select Claude model" },
    { "<leader>ab", "<cmd>ClaudeCodeAdd %<cr>", desc = "Add current buffer" },
    { "<leader>as", "<cmd>ClaudeCodeSend<cr>", mode = "v", desc = "Send selection to Claude" },
    { "<C-,>", "<cmd>ClaudeCodeFocus<cr>", desc = "Toggle Claude", mode = { "n", "x" } },
    {
      "<leader>as",
      "<cmd>ClaudeCodeTreeAdd<cr>",
      desc = "Add file",
      ft = { "NvimTree", "neo-tree", "oil", "minifiles", "netrw" },
    },
    -- Diff management
    { "<leader>aa", "<cmd>ClaudeCodeDiffAccept<cr>", desc = "Accept diff" },
    { "<leader>ad", "<cmd>ClaudeCodeDiffDeny<cr>", desc = "Deny diff" },
  },
}
