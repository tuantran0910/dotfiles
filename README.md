# dotfiles

Personal machine configuration, centralized. One repo for coding-agent setup, shell, terminal, editors, git, and my own [omp](https://omp.sh) plugin marketplace.

## Layout

```
dotfiles/
├── bootstrap.sh              link everything; idempotent, backs up instead of overwriting
├── Brewfile                  Homebrew snapshot (formulae + casks + taps)
├── home/                     mirrors $HOME 1:1 — every file here becomes a symlink
│   ├── .zshrc .zprofile .gitconfig
│   ├── .agents/skills/       shared agent skills
│   ├── .claude/              CLAUDE.md, settings.json, rules/, commands/, hooks/, agents/
│   ├── .codex/               config.toml, hooks.json
│   └── .config/
│       ├── agents/AGENTS.md  THE global instruction file (single source of truth)
│       ├── opencode/         opencode.json, tui.jsonc, commands/, plugins/
│       ├── nvim/ fish/ lazygit/ ghostty/ alacritty/ cmux/ herdr/ gh/ git/
├── omp/                      ~/.omp/agent/config.yml mirror (modelRoles, default model, extensions)
├── .omp-plugin/marketplace.json   my omp plugin marketplace catalog
├── plugins/                  my omp plugins — all first-party
├── scripts/validate-marketplace.ts   pre-commit check
└── secrets/                  gitignored; env.sh for local-only exports
```

`home/` mirrors `$HOME`, so a file at `home/.config/ghostty/config.ghostty` lands at `~/.config/ghostty/config.ghostty`. The manifest in `bootstrap.sh` is explicit — nothing is symlinked implicitly.

## Usage

```sh
git clone https://github.com/tuantran0910/dotfiles.git ~/Workspaces/PersonalRepo/dotfiles
cd ~/Workspaces/PersonalRepo/dotfiles

./bootstrap.sh --dry-run     # review the plan first
./bootstrap.sh               # link configs
./bootstrap.sh --brew        # also install Homebrew packages
./bootstrap.sh --omp         # also register the marketplace and install plugins
```

Rules the script follows:

- **Never overwrites.** Anything already on disk is moved to `~/.dotfiles-backup/<timestamp>/` first.
- **Idempotent.** Re-running reports `ok` for links already in place.
- **Explicit.** Symlinks come from the `MANIFEST` array, not directory scanning.

## Global agent instructions

`home/.config/agents/AGENTS.md` is the single source. The bootstrap script wires every consumer to it:

| Consumer | Link |
| --- | --- |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Codex | `~/.codex/AGENTS.md` |
| Claude Code | `~/.claude/rules/00-global-safety.md` |

Edit the one file; all three agents pick it up.

## omp plugins

The repo root is itself an omp marketplace, so one clone serves both purposes:

```sh
omp plugin marketplace add tuantran0910/dotfiles
omp plugin list
```

Currently published:

| Plugin | Category | What it does |
| --- | --- | --- |
| `pr-wording-review` | productivity | interrupts PR text that reads as machine-generated, so the agent checks its own wording |
| `tool-gate` | security | argument-level rules: denies destructive shell commands and protected paths, prompts for infrastructure actions, logs every decision |
| `worktree-kit` | development | the `worktree` tool: placement owned by the plugin, stray direct commands flagged |

Every plugin here is first-party: no third-party plugin code is vendored or installed. `tool-gate` is the permission layer: omp decides which *tools* prompt, tool-gate decides which *arguments* are allowed. `pr-wording-review` and `worktree-kit` reimplement behaviour that was previously third-party (`unslop-pr`, `worktree-manager`). `github-comment-guard`, `git-commit-linter`, `omp-plugin-mcps` and `omp-permission-guard` were dropped without replacement.

**Lockfiles are deliberately not committed** (`bun.lock` is gitignored). A committed lock resolved against a private registry is exactly what broke installs upstream; dependencies are installed by whoever installs the plugin.

## Secrets

Nothing sensitive is tracked. `secrets/` is gitignored and `secrets/env.sh` is mode `600`; `~/.zshrc` sources it when present:

```sh
[ -f "$HOME/.config/secrets/env.sh" ] && . "$HOME/.config/secrets/env.sh"
```

On a new machine, create it by hand from your password manager. Keys that tools persist themselves (`~/.omp/agent/agent.db`, `~/.codex/auth.json`, `~/.config/gh` keyring entries) stay out of the repo by design.

## Conventions

Adapted from the marketplace conventions this setup borrows from:

- Plugin names match their directory and `package.json` name.
- Versions live in `package.json`, never duplicated in the catalog.
- Bump the version whenever installed plugin content changes.
- Conventional Commits; the plugin name as scope for plugin-specific changes.
- Update this README when catalog entries are added, removed, or renamed.
- Verify before committing: `bun scripts/validate-marketplace.ts` (vendored script, Unlicense).

## Not tracked here

| Excluded | Why |
| --- | --- |
| `~/.basic-memory` (77 MB) | knowledge base, belongs in its own repo |
| `~/.config/opencode/skills` (19 MB), `node_modules` | bulky, installable |
| `~/.claude` caches, `~/.codex` history (~2.8 GB) | state, not config |
| `auth.json`, `agent.db`, `.credentials.json`, tokens | secrets — `secrets/` is gitignored |
| `bun.lock`, `package-lock.json` | see above |

## License

MIT.
