return {
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    requires = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons", -- Not strictly required, but recommended
      "MunifTanjim/nui.nvim",
      "3rd/image.nvim", -- Optional image support in preview window (See `# Preview Mode` for more information)
      {
        "s1n7ax/nvim-window-picker",
        version = "2.*",
        config = function()
          require("window-picker").setup({
            filter_rules = {
              include_current_win = false,
              autoselect_one = true,
              -- Filter using buffer options
              bo = {
                -- If the file type is one of following, the window will be ignored
                filetype = { "neo-tree", "neo-tree-popup", "notify" },
                -- If the buffer type is one of following, the window will be ignored
                buftype = { "terminal", "quickfix" },
              },
            },
          })
        end,
      },
    },
    config = function()
      ---@diagnostic disable: undefined-global
      -- Diagnostic sign icons definition
      vim.fn.sign_define("DiagnosticSignError", { text = " ", texthl = "DiagnosticSignError" })
      vim.fn.sign_define("DiagnosticSignWarn", { text = " ", texthl = "DiagnosticSignWarn" })
      vim.fn.sign_define("DiagnosticSignInfo", { text = " ", texthl = "DiagnosticSignInfo" })
      vim.fn.sign_define("DiagnosticSignHint", { text = "󰌵", texthl = "DiagnosticSignHint" })

      require("neo-tree").setup({
        close_if_last_window = false,
        popup_border_style = "rounded",
        enable_git_status = true,
        enable_diagnostics = true,
        open_files_do_not_replace_types = { "terminal", "trouble", "Trouble", "qf", "Outline" },
        sort_case_insensitive = false,
        default_component_configs = {
          container = {
            enable_character_fade = true,
          },
          indent = {
            indent_size = 2,
            padding = 1,
            with_markers = true,
            indent_marker = "│",
            last_indent_marker = "└",
            highlight = "NeoTreeIndentMarker",
            with_expanders = nil,
            expander_collapsed = "",
            expander_expanded = "",
            expander_highlight = "NeoTreeExpander",
          },
          icon = {
            folder_closed = "",
            folder_open = "",
            folder_empty = "󰜌",
            folder_empty_open = "󰜌",
            use_filtered_colors = false,
            provider = function(icon, node)
              ---@cast node { type: string, name: string }
              if node.type == "file" or node.type == "terminal" then
                local success, web_devicons = pcall(require, "nvim-web-devicons")
                local name = node.type == "terminal" and "terminal" or node.name
                if success then
                  local devicon, hl = web_devicons.get_icon(name)
                  icon.text = devicon or icon.text
                  icon.highlight = hl or icon.highlight
                end
              end
            end,
            -- The next two settings are only a fallback. If you use nvim-web-devicons
            -- and configure default icons there, then these will never be used.
            default = "*",
            highlight = "NeoTreeFileIcon",
          },
          modified = {
            symbol = "[+]",
            highlight = "NeoTreeModified",
          },
          name = {
            trailing_slash = false,
            use_git_status_colors = true,
            use_file_ls_colors = true,
            highlight = "NeoTreeFileName",
          },
          git_status = {
            symbols = {
              -- Change type
              added = "", -- Or "✚", but this is redundant info if you use git_status_colors on the name
              modified = "", -- Or "", but this is redundant info if you use git_status_colors on the name
              deleted = "✖", -- This can only be used in the git_status source
              renamed = "󰁕", -- This can only be used in the git_status source
              -- Status type
              untracked = "",
              ignored = "",
              unstaged = "󰄱",
              staged = "",
              conflict = "",
            },
          },
          -- If you don't want to use these columns, you can set `enabled = false` for each individually
          file_size = {
            enabled = true,
            required_width = 64,
          },
          type = {
            enabled = true,
            required_width = 122,
          },
          last_modified = {
            enabled = true,
            width = 20,
            required_width = 88,
            format = "%Y-%m-%d %H:%M",
          },
          created = {
            enabled = true,
            width = 20,
            required_width = 110,
            format = "%Y-%m-%d %H:%M",
          },
          symlink_target = {
            enabled = false,
          },
        },
        -- ===================================================================
        -- Custom commands
        -- A list of functions, each representing a global custom command that
        -- will be available in all sources (if not overridden in `opts[source_name].commands`)
        -- See `:h neo-tree-custom-commands-global`
        -- ===================================================================
        commands = {},
        window = {
          position = "left",
          width = 40,
          mapping_options = {
            noremap = true,
            nowait = true,
          },
          mappings = {
            ["<space>"] = "none",
            ["<2-LeftMouse>"] = "open",
            ["<cr>"] = "open",
            ["<esc>"] = "cancel",
            ["P"] = { "toggle_preview", config = { use_float = true, use_image_nvim = true } },
            ["L"] = { "focus_preview" },
            ["l"] = "open",
            ["h"] = "close_node",
            ["S"] = "open_split",
            ["s"] = "open_vsplit",
            -- ["S"] = "split_with_window_picker"
            -- ["s"] = "vsplit_with_window_picker"
            ["t"] = "open_tabnew",
            -- ["<cr>"] = "open_drop"
            -- ["t"] = "open_tab_drop"
            ["w"] = "open_with_window_picker",
            -- ["P"] = "toggle_preview"
            ["C"] = "close_node",
            -- ['C'] = 'close_all_subnodes'
            ["z"] = "close_all_nodes",
            -- ["Z"] = "expand_all_nodes"
            ["a"] = {
              "add",
              -- This command supports BASH style brace expansion ("x{a,b,c}" -> xa,xb,xc)
              -- See `:h neo-tree-file-actions` for details
              -- Some commands may take optional config options, see `:h neo-tree-mappings` for details
              config = {
                show_path = "relative", -- Options: "none", "relative", "absolute"
              },
            },
            ["A"] = "add_directory",
            ["d"] = "delete",
            ["r"] = "rename",
            ["y"] = "copy_to_clipboard",
            ["x"] = "cut_to_clipboard",
            ["p"] = "paste_from_clipboard",
            ["c"] = {
              "copy",
              config = {
                show_path = "relative", -- Options: "none", "relative", "absolute"
              },
            },
            ["m"] = "move",
            ["q"] = "close_window",
            ["R"] = "refresh",
            ["?"] = "show_help",
            ["<"] = "prev_source",
            [">"] = "next_source",
            ["i"] = "show_file_details",
            ["Y"] = {
              ---@diagnostic disable-next-line: assign-type-mismatch
              function(state)
                local node = state.tree:get_node()
                local path = node:get_id()
                vim.fn.setreg("+", path, "c")
              end,
              desc = "Copy Path to Clipboard",
            },
            ["O"] = {
              ---@diagnostic disable-next-line: assign-type-mismatch
              function(state)
                require("lazy.util").open(state.tree:get_node().path, { system = true })
              end,
              desc = "Open with System Application",
            },
          },
        },
        nesting_rules = {},
        filesystem = {
          filtered_items = {
            visible = true,
            hide_dotfiles = false,
            hide_gitignored = true,
            hide_hidden = false, -- Only works on Windows for hidden files/directories
            hide_by_name = {
              "node_modules",
              ".venv",
              ".gitkeep",
              ".idea",
            },
            hide_by_pattern = { -- Uses glob style patterns
              -- "*.meta",
              -- "*/src/*/tsconfig.json",
            },
            always_show = { -- Remains visible even if other settings would normally hide it
              ".gitignored",
              ".pre-commit-config.yaml",
            },
            always_show_by_pattern = { -- Uses glob style patterns
              ".env*",
            },
            never_show = { -- Remains hidden even if visible is toggled to true (overrides always_show)
              ".DS_Store",
              "thumbs.db",
              ".git",
            },
            never_show_by_pattern = { -- Uses glob style patterns
              ".null-ls_*",
            },
          },
          follow_current_file = {
            enabled = true, -- Disabled to prevent stealing focus from terminal (e.g., Claude Code)
            leave_dirs_open = true, -- `false` closes auto expanded dirs, such as with `:Neotree reveal`
          },
          bind_to_cwd = true,
          group_empty_dirs = false, -- When true, empty folders will be grouped together
          hijack_netrw_behavior = "open_default", -- Netrw disabled, opening a directory opens neo-tree
          -- in whatever position is specified in window.position
          -- "open_current" -- Netrw disabled, opening a directory opens within the
          -- window like netrw would, regardless of window.position
          -- "disabled" -- Netrw left alone, neo-tree does not handle opening dirs
          use_libuv_file_watcher = true, -- Use the OS level file watchers to detect changes
          -- instead of relying on nvim autocmd events
          window = {
            mappings = {
              ["<bs>"] = "navigate_up",
              ["."] = "set_root",
              ["H"] = "toggle_hidden",
              ["/"] = "fuzzy_finder",
              ["D"] = "fuzzy_finder_directory",
              ["#"] = "fuzzy_sorter", -- Fuzzy sorting using the fzy algorithm
              -- ["D"] = "fuzzy_sorter_directory"
              ["f"] = "filter_on_submit",
              ["<c-x>"] = "clear_filter",
              ["[g"] = "prev_git_modified",
              ["]g"] = "next_git_modified",
              ["o"] = { "show_help", nowait = false, config = { title = "Order by", prefix_key = "o" } },
              ["oc"] = { "order_by_created", nowait = false },
              ["od"] = { "order_by_diagnostics", nowait = false },
              ["og"] = { "order_by_git_status", nowait = false },
              ["om"] = { "order_by_modified", nowait = false },
              ["on"] = { "order_by_name", nowait = false },
              ["os"] = { "order_by_size", nowait = false },
              ["ot"] = { "order_by_type", nowait = false },
              -- ['<key>'] = function(state) ... end
            },
            fuzzy_finder_mappings = { -- Define keymaps for filter popup window in fuzzy_finder_mode
              ["<down>"] = "move_cursor_down",
              ["<C-n>"] = "move_cursor_down",
              ["<up>"] = "move_cursor_up",
              ["<C-p>"] = "move_cursor_up",
              -- ['<key>'] = function(state, scroll_padding) ... end
            },
          },
          commands = {}, -- Add a custom command or override a global one using the same function name
        },
        buffers = {
          follow_current_file = {
            enabled = true, -- Disabled to prevent stealing focus from terminal (e.g., Claude Code)
            leave_dirs_open = true, -- `false` closes auto expanded dirs, such as with `:Neotree reveal`
          },
          show_unloaded = true,
          window = {
            mappings = {
              ["bd"] = "buffer_delete",
              ["<bs>"] = "navigate_up",
              ["."] = "set_root",
              ["o"] = { "show_help", nowait = false, config = { title = "Order by", prefix_key = "o" } },
              ["oc"] = { "order_by_created", nowait = false },
              ["od"] = { "order_by_diagnostics", nowait = false },
              ["om"] = { "order_by_modified", nowait = false },
              ["on"] = { "order_by_name", nowait = false },
              ["os"] = { "order_by_size", nowait = false },
              ["ot"] = { "order_by_type", nowait = false },
            },
          },
        },
        sources = { "filesystem", "buffers" },
      })

      vim.cmd([[nnoremap \ :Neotree reveal<cr>]])
      vim.keymap.set("n", "<Space>e", "<Cmd>Neotree toggle<CR>", { desc = "Toggle Neo-tree" })
      vim.keymap.set("n", "<Space>E", "<Cmd>Neotree toggle<CR>", { desc = "Toggle Neo-tree" })
    end,
  },
  {
    "antosha417/nvim-lsp-file-operations",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-neo-tree/neo-tree.nvim", -- Makes sure that this loads after Neo-tree.
    },
    config = function()
      require("lsp-file-operations").setup()
    end,
  },
  {
    "s1n7ax/nvim-window-picker",
    version = "2.*",
    config = function()
      require("window-picker").setup({
        filter_rules = {
          include_current_win = false,
          autoselect_one = true,
          -- Filter using buffer options
          bo = {
            -- If the file type is one of following, the window will be ignored
            filetype = { "neo-tree", "neo-tree-popup", "notify" },
            -- If the buffer type is one of following, the window will be ignored
            buftype = { "terminal", "quickfix" },
          },
        },
      })
    end,
  },
}
