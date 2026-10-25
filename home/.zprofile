
# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :

eval "$(/opt/homebrew/bin/brew shellenv)"

# Keep rustup shims ahead of Homebrew's cargo (brew prepends /opt/homebrew/bin above)
export PATH="$HOME/.cargo/bin:$PATH"

# >>> Codex installer >>>
export PATH="/Users/tranngoctuan0910/.local/bin:$PATH"
# <<< Codex installer <<<
