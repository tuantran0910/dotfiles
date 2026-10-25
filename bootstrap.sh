#!/usr/bin/env bash
# Bootstrap this machine from the dotfiles repo.
#
#   ./bootstrap.sh --dry-run   show the plan, change nothing
#   ./bootstrap.sh             link configs (existing files are backed up, never overwritten)
#   ./bootstrap.sh --brew      also install Homebrew packages from Brewfile
#   ./bootstrap.sh --omp       also register the plugin marketplace and install its plugins
#
set -euo pipefail

DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/.dotfiles-backup/$STAMP"
DRY_RUN=0 BREW=0 OMP=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --brew)    BREW=1 ;;
    --omp)     OMP=1 ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY_RUN" -eq 1 ]; then echo "    would run: $*"; else "$@"; fi; }

# link <path relative to repo> <path relative to $HOME>
link() {
  local src="$DOTFILES/$1" dest="$HOME/$2"
  if [ ! -e "$src" ] && [ ! -L "$src" ]; then
    echo "  skip      ~/$2 (not in repo)"; return
  fi
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    echo "  ok        ~/$2"; return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "  backup    ~/$2"
    run mkdir -p "$BACKUP/$(dirname "$2")"
    run mv "$dest" "$BACKUP/$2"
  fi
  echo "  link      ~/$2 -> $1"
  run mkdir -p "$(dirname "$dest")"
  run ln -s "$src" "$dest"
}

# symlink_to <absolute target> <path relative to $HOME>: for links that cross repos areas
symlink_to() {
  local target="$1" dest="$HOME/$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    echo "  ok        ~/$2"; return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "  backup    ~/$2"
    run mkdir -p "$BACKUP/$(dirname "$2")"
    run mv "$dest" "$BACKUP/$2"
  fi
  echo "  link      ~/$2 -> $target"
  run mkdir -p "$(dirname "$dest")"
  run ln -s "$target" "$dest"
}

MANIFEST=(
  "home/.zshrc|.zshrc"
  "home/.zprofile|.zprofile"
  "home/.gitconfig|.gitconfig"
  "home/.agents|.agents"
  "home/.config/agents|.config/agents"
  "home/.config/opencode/opencode.json|.config/opencode/opencode.json"
  "home/.config/opencode/tui.jsonc|.config/opencode/tui.jsonc"
  "home/.config/opencode/package.json|.config/opencode/package.json"
  "home/.config/opencode/herdr-tui-session.js|.config/opencode/herdr-tui-session.js"
  "home/.config/opencode/commands|.config/opencode/commands"
  "home/.config/opencode/plugins|.config/opencode/plugins"
  "home/.config/gh/config.yml|.config/gh/config.yml"
  "home/.config/git/ignore|.config/git/ignore"
  "home/.config/lazygit/config.yml|.config/lazygit/config.yml"
  "home/.config/ghostty/config.ghostty|.config/ghostty/config.ghostty"
  "home/.config/alacritty/alacritty.toml|.config/alacritty/alacritty.toml"
  "home/.config/cmux/settings.json|.config/cmux/settings.json"
  "home/.config/fish/conf.d|.config/fish/conf.d"
  "home/.config/herdr/config.toml|.config/herdr/config.toml"
  "home/.config/nvim|.config/nvim"
  "home/.claude/RTK.md|.claude/RTK.md"
  "home/.claude/settings.json|.claude/settings.json"
  "home/.claude/rules|.claude/rules"
  "home/.claude/commands|.claude/commands"
  "home/.claude/hooks|.claude/hooks"
  "home/.claude/agents|.claude/agents"
  "home/.codex/config.toml|.codex/config.toml"
  "home/.codex/hooks.json|.codex/hooks.json"
  "home/.codex/herdr-agent-state.sh|.codex/herdr-agent-state.sh"
  "omp/config.yml|.omp/agent/config.yml"
  "omp/extensions|.omp/agent/extensions"
)

echo "== configs"
for entry in "${MANIFEST[@]}"; do link "${entry%%|*}" "${entry##*|}"; done

echo "== shared agent instructions (one source, many consumers)"
for consumer in ".config/opencode/AGENTS.md" ".codex/AGENTS.md"; do
  symlink_to "$HOME/.config/agents/AGENTS.md" "$consumer"
done

if [ -f "$DOTFILES/secrets/env.sh" ]; then
  echo "== secrets"
  chmod 600 "$DOTFILES/secrets/env.sh"
  symlink_to "$DOTFILES/secrets/env.sh" ".config/secrets/env.sh"
fi

if [ "$BREW" -eq 1 ]; then
  echo "== homebrew bundle"
  run brew bundle --file "$DOTFILES/Brewfile"
fi

if [ "$OMP" -eq 1 ]; then
  echo "== omp plugins"
  if command -v omp >/dev/null 2>&1; then
    MARKETPLACE="tuantran0910/dotfiles"
    MARKETPLACE_NAME="tuantran0910-dotfiles"
    # add is idempotent; update is what makes an existing machine see new versions
    run omp plugin marketplace add "$MARKETPLACE" || true
    run omp plugin marketplace update "$MARKETPLACE_NAME" || true
    while IFS= read -r plugin; do
      [ -n "$plugin" ] || continue
      # always qualify with the marketplace: an unqualified name can resolve to an
      # unrelated npm package that happens to share the name
      run omp plugin install "$plugin@$MARKETPLACE_NAME" --force || true
    done < <(python3 -c "import json;d=json.load(open('$DOTFILES/.omp-plugin/marketplace.json'));print('\n'.join(p['name'] for p in d['plugins']))")

    # omp symlinks marketplace plugins but never runs their install step, so any
    # plugin that declares dependencies arrives without node_modules. Install them.
    echo "== omp plugin dependencies"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "    would run: bun install --production for every cached plugin with dependencies"
    else
      for dir in "$HOME"/.omp/plugins/cache/plugins/*/*/; do
        [ -f "$dir/package.json" ] || continue
        if python3 -c "import json,sys;sys.exit(0 if json.load(open('$dir/package.json')).get('dependencies') else 1)" 2>/dev/null; then
          if [ ! -d "$dir/node_modules" ]; then
            echo "  install   $(basename "$dir")"
            (cd "$dir" && bun install --production >/dev/null 2>&1) || echo "  FAILED    $(basename "$dir")"
          else
            echo "  ok        $(basename "$dir")"
          fi
        fi
      done
    fi
  else
    echo "  skip      omp not installed (brew install can1357/tap/omp)"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "dry run: nothing changed."
elif [ -d "$BACKUP" ]; then
  echo
  echo "existing files were moved to: ${BACKUP/#$HOME/~}"
fi
