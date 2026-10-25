# Neovim Configuration

A personal Neovim configuration built on [LazyVim](https://github.com/LazyVim/LazyVim), a full-featured IDE-like layer powered by lazy.nvim.

## Installation

### Prerequisites

- [Neovim](https://neovim.io/) 0.9+ (preferably latest stable)
- [Git](https://git-scm.com/)
- A [Nerd Font](https://www.nerdfonts.com/) for icons (recommended: [JetBrains Mono Nerd Font](https://github.com/ryanoasis/nerd-fonts))
- [LazyGit](https://github.com/jesseduffield/lazygit) for git integration
- [Node.js](https://nodejs.org/) & npm (for some LSP servers)
- [Python](https://www.python.org/) 3.9+ with pip (for python tooling)
- [Go](https://go.dev/) (for go tooling)
- [Rust](https://www.rust-lang.org/) (for rust tooling)

### Setup

1. Backup your existing Neovim config:

   ```bash
   mv ~/.config/nvim ~/.config/nvim.backup
   ```

2. Clone this repository:

   ```bash
   git clone <your-repo-url> ~/.config/nvim
   ```

3. Open Neovim. Lazy.nvim will automatically install plugins on first launch:

   ```bash
   nvim
   ```

### Language Server Installation

After opening Neovim, language servers will be automatically installed by Mason. You can also manually install tools:

```vim
:Mason
```

Key tools that will be installed:

- **Python**: pyright, ruff, black
- **Go**: gopls, gofumpt, golines
- **Rust**: rust-analyzer
- **General**: terraform-ls, yamlls, jsonls, dockerls, helm_ls
- **Typescript**: tsserver (via typescript.nvim)

## Features

### File Management

- **Neo-tree** (`<Space>e` or `\`) - File explorer with git status, diagnostics, and icons
  - Toggle with `<Space>e`
  - Reveal current file with `\`
  - Hidden files shown (except node_modules, .venv, .git, .DS_Store)
  - Integrated LSP file operations (rename/delete)

### Fuzzy Finding

- **Telescope** - Fast fuzzy finder
  - `<leader>ff` - Find files
  - `<leader>fg` - Live grep
  - `<leader>fb` - Find buffers
  - `<leader>fh` - Help tags

### Git Integration

- **LazyGit** (`<leader>lg`) - Terminal UI for Git
- **gitsigns** - Git signs in the gutter (blame, hunk navigation, preview)

### Docker

- **LazyDocker** (`<leader>ld`) - Terminal UI for Docker containers/images
- Docker LSP and syntax support

### AI Assistance

- **GitHub Copilot** - AI code completion (enabled)
- **Claude Code** (`<leader>ac` or `<C-,>`) - AI assistant integration
  - `<leader>ac` - Focus Claude Code
  - `<leader>ar` - Resume Claude
  - `<leader>aC` - Continue Claude
  - `<leader>am` - Select model
  - `<leader>ab` - Add current buffer
  - `<leader>as` - Send selection (visual mode)
  - `<leader>aa` - Accept diff
  - `<leader>ad` - Deny diff

## Language Support

This configuration includes extras for:

| Language | Tools |
|----------|-------|
| **Python** | pyright, ruff, black |
| **Go** | gopls, gofumpt, golines |
| **Rust** | rust-analyzer |
| **C/C++** | clangd |
| **CMake** | cmake-language-server |
| **Docker** | dockerls |
| **Helm** | helm_ls |
| **YAML** | yamlls |
| **TOML** | taplo |
| **JSON** | jsonls |
| **SQL** | sqlls |
| **Terraform** | terraform-ls |
| **Markdown** | marksman, glow preview |
| **TypeScript** | tsserver via typescript.nvim |

## Configuration Structure

```
~/.config/nvim
├── init.lua              # Entry point
├── lazy-lock.json        # Plugin lock file
├── lazyvim.json          # LazyVim extras config
├── stylua.toml           # Lua formatter config
└── lua/
    ├── config/
    │   ├── lazy.lua      # Plugin manager setup
    │   ├── options.lua   # Neovim options & LSP
    │   ├── keymaps.lua   # Custom keymaps
    │   └── autocmds.lua  # Autocommands
    └── plugins/
        ├── telescope.lua     # Fuzzy finder
        ├── neotree.lua       # File explorer
        ├── lazygit.lua       # Git UI
        ├── lazydocker.lua    # Docker UI
        ├── copilot.lua       # GitHub Copilot
        ├── supermaven.lua    # Supermaven (disabled)
        ├── claudecode.lua    # Claude Code integration
        ├── snacks.lua        # Snacks.nvim config
        └── example.lua       # Plugin examples (disabled)
```

## Customization

### Adding Plugins

Create a new file in `lua/plugins/`:

```lua
return {
  "author/plugin",
  opts = {
    -- plugin options
  },
  keys = {
    { "<leader>x", "<cmd>PluginCommand<cr>", desc = "Description" }
  }
}
```

### Overriding Plugins

To override a LazyVim plugin's configuration:

```lua
return {
  "LazyVim/LazyVim",
  opts = {
    -- your options
  },
}
```

### Changing Colorscheme

Edit `lua/config/lazy.lua` and modify the `colorscheme` option:

```lua
install = { colorscheme = { "tokyonight", "habamax" } },
```

Available schemes: tokyonight, catppuccin, gruvbox, nord, etc.

## Keymaps

### General

| Key | Mode | Description |
|-----|------|-------------|
| `<Space>` | Leader key | |
| `<Space>e` | Normal | Toggle Neo-tree |
| `\` | Normal | Reveal current file in Neo-tree |
| `<leader>lg` | Normal | Open LazyGit |
| `<leader>ld` | Normal | Toggle LazyDocker |

### Telescope

| Key | Description |
|-----|-------------|
| `<leader>ff` | Find files |
| `<leader>fg` | Live grep |
| `<leader>fb` | Find buffers |
| `<leader>fh` | Help tags |

### LSP

| Key | Description |
|-----|-------------|
| `gd` | Go to definition |
| `gr` | Find references |
| `K` | Hover documentation |
| `<leader>ca` | Code actions |
| `<leader>cf` | Format code |

## Troubleshooting

### Plugins not loading

Run `:Lazy` to check plugin status and update plugins.

### LSP not working

Run `:Mason` to ensure language servers are installed. Check `:LspInfo` for active LSP clients.

### Health check

Run `:checkhealth` to verify Neovim and plugin health.

## Resources

- [LazyVim Documentation](https://lazyvim.github.io/)
- [Lazy.nvim Documentation](https://github.com/folke/lazy.nvim)
- [Neovim Documentation](https://neovim.io/doc/)
- [Neovim From Scratch](https://github.com/nvim-lua/kickstart.nvim)

## Credits

**Author:** [tuantran0910](https://github.com/tuantran0910)

Built with [LazyVim](https://github.com/LazyVim/LazyVim) and powered by [lazy.nvim](https://github.com/folke/lazy.nvim).
