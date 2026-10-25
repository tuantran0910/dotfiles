# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a Neovim configuration based on [LazyVim](https://github.com/LazyVim/LazyVim), a plugin distribution built on lazy.nvim.

### Entry Points

- `init.lua` - Entry point that bootstraps lazy.nvim via `require("config.lazy")`
- `lua/config/lazy.lua` - Sets up lazy.nvim, loads LazyVim core plugins, then imports all files under `lua/plugins/`

### Directory Structure

- `lua/config/` - Core configuration files loaded automatically by LazyVim
  - `options.lua` - Neovim options (also loads LSP config like `ruff`)
  - `keymaps.lua` - Custom keymaps (merged with LazyVim defaults)
  - `autocmds.lua` - Autocommands (merged with LazyVim defaults)
- `lua/plugins/` - Plugin specifications loaded by lazy.nvim
  - `example.lua` - Template file (disabled via early return) showing common patterns
  - `telescope.lua` - Fuzzy finder configuration
  - `lazygit.lua` - Git UI (`<leader>lg`)
  - `lazydocker.lua` - Docker UI (`<leader>ld`)
  - `copilot.lua` - GitHub Copilot (enabled)
  - `supermaven.lua` - Supermaven AI (disabled)
  - `claudecode.lua` - Claude Code integration with snacks.nvim terminal UI
  - `neotree.lua` - File explorer with window-picker and lsp-file-operations
  - `snacks.lua` - Snacks.nvim (explorer/picker disabled)

### Plugin Patterns

Plugins are defined as Lua tables returned from plugin files. Common patterns:

```lua
return {
  "plugin/repo",
  dependencies = { "other/repo" },
  opts = { ... },           -- Merged with parent spec defaults
  keys = { { "<leader>x", cmd, desc = "..." } },
  config = function() ... end,
}
```

### LazyVim Extras

The configuration uses several LazyVim extras (configured in `lazyvim.json`):

- Language support: cmake, docker, go, helm, json, markdown, python, rust, sql, terraform, toml, yaml
- Editor: telescope
- Utilities: gh (GitHub)

## Code Style

Run `stylua` to format Lua files. Configuration in `stylua.toml`:

- 2-space indentation
- 120 character column width

## LSP Configuration

Ruff LSP is enabled globally in `lua/config/options.lua` with a line length of 100.

## Key Keymaps

- `<Space>e` - Toggle Neo-tree file explorer
- `\` - Reveal current file in Neo-tree
- `<leader>lg` - Open LazyGit
- `<leader>ld` - Toggle LazyDocker
- `<leader>ff/fg/fb/fh` - Telescope (files, grep, buffers, help)
- `<leader>a` - AI/Claude Code prefix (`<leader>ac` to focus, `<C-,>` to toggle)

## Notes

- The `example.lua` file contains extensive documentation but is disabled (returns early)
- Neo-tree hides common directories (node_modules, .venv, .git) but shows dotfiles
- Snacks.nvim explorer and picker are explicitly disabled
- Supermaven is disabled; Copilot and Claude Code are the active AI assistants
