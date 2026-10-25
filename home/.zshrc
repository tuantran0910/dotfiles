# Start configuration added by Zim Framework install {{{
#
# User configuration sourced by interactive shells
#

# -----------------
# Zsh configuration
# -----------------

#
# History
#

# Remove older command from the history if a duplicate is to be added.
setopt HIST_IGNORE_ALL_DUPS

#
# Input/output
#

# Set editor default keymap to emacs (`-e`) or vi (`-v`)
bindkey -e

# Prompt for spelling correction of commands.
#setopt CORRECT

# Customize spelling correction prompt.
#SPROMPT='zsh: correct %F{red}%R%f to %F{green}%r%f [nyae]? '

# Remove path separator from WORDCHARS.
WORDCHARS=${WORDCHARS//[\/]}

# --------------------
# Module configuration
# --------------------

#
# git
#

# Set a custom prefix for the generated aliases. The default prefix is 'G'.
#zstyle ':zim:git' aliases-prefix 'g'

#
# input
#

# Append `../` to your input for each `.` you type after an initial `..`
#zstyle ':zim:input' double-dot-expand yes

#
# termtitle
#

# Set a custom terminal title format using prompt expansion escape sequences.
# See http://zsh.sourceforge.net/Doc/Release/Prompt-Expansion.html#Simple-Prompt-Escapes
# If none is provided, the default '%n@%m: %~' is used.
#zstyle ':zim:termtitle' format '%1~'

#
# zsh-autosuggestions
#

# Disable automatic widget re-binding on each precmd. This can be set when
# zsh-users/zsh-autosuggestions is the last module in your ~/.zimrc.
ZSH_AUTOSUGGEST_MANUAL_REBIND=1

# Customize the style that the suggestions are shown with.
# See https://github.com/zsh-users/zsh-autosuggestions/blob/master/README.md#suggestion-highlight-style
#ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=242'

#
# zsh-syntax-highlighting
#

# Set what highlighters will be used.
# See https://github.com/zsh-users/zsh-syntax-highlighting/blob/master/docs/highlighters.md
ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets)

# Customize the main highlighter styles.
# See https://github.com/zsh-users/zsh-syntax-highlighting/blob/master/docs/highlighters/main.md#how-to-tweak-it
#typeset -A ZSH_HIGHLIGHT_STYLES
#ZSH_HIGHLIGHT_STYLES[comment]='fg=242'

# ------------------
# Initialize modules
# ------------------

ZIM_HOME=${ZDOTDIR:-${HOME}}/.zim
# Disable Spaceship's async worker (avoids "no such async worker" errors).
export SPACESHIP_PROMPT_ASYNC=false
# Only initialize the prompt framework in a real interactive terminal. Captured
# shells (e.g. opencode's `!` chat command, scripts) skip it to avoid prompt and
# async-worker errors; PATH/env exports further below still apply.
if [[ -t 1 ]]; then
  # Download zimfw plugin manager if missing.
  if [[ ! -e ${ZIM_HOME}/zimfw.zsh ]]; then
    if (( ${+commands[curl]} )); then
      curl -fsSL --create-dirs -o ${ZIM_HOME}/zimfw.zsh \
          https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh
    else
      mkdir -p ${ZIM_HOME} && wget -nv -O ${ZIM_HOME}/zimfw.zsh \
          https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh
    fi
  fi
  # Install missing modules, and update ${ZIM_HOME}/init.zsh if missing or outdated.
  if [[ ! ${ZIM_HOME}/init.zsh -nt ${ZIM_CONFIG_FILE:-${ZDOTDIR:-${HOME}}/.zimrc} ]]; then
    source ${ZIM_HOME}/zimfw.zsh init
  fi
  # Initialize modules.
  source ${ZIM_HOME}/init.zsh

  # ------------------------------
  # Post-init module configuration
  # ------------------------------

  #
  # zsh-history-substring-search
  #

  zmodload -F zsh/terminfo +p:terminfo
  # Bind ^[[A/^[[B manually so up/down works both before and after zle-line-init
  for key ('^[[A' '^P' ${terminfo[kcuu1]}) bindkey ${key} history-substring-search-up
  for key ('^[[B' '^N' ${terminfo[kcud1]}) bindkey ${key} history-substring-search-down
  for key ('k') bindkey -M vicmd ${key} history-substring-search-up
  for key ('j') bindkey -M vicmd ${key} history-substring-search-down
  unset key
  # }}} End configuration added by Zim Framework install
fi


. "$HOME/.local/bin/env"

# fnm
FNM_PATH="/opt/homebrew/opt/fnm/bin"
if [ -d "$FNM_PATH" ]; then
  eval "`fnm env`"
fi

# Completion UI (compinit is handled by zim's `completion` module)
zstyle ':completion:*' menu no
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}

alias cls='clear'
alias python='python3'
alias pip='pip3'

export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

# Added by Antigravity
export PATH="/Users/tranngoctuan0910/.antigravity/antigravity/bin:$PATH"

# Opencode
export PATH=/Users/tranngoctuan0910/.opencode/bin:$PATH
export EDITOR="cursor"
export VISUAL="cursor"
export TERMINAL="ghostty"

export PATH=$PATH:/usr/local/go/bin
export PATH=$PATH:$HOME/go/bin

export ENABLE_LSP_TOOL=1

# bun completions
[ -s "/Users/tranngoctuan0910/.bun/_bun" ] && source "/Users/tranngoctuan0910/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

alias claude-mem='/Users/tranngoctuan0910/.bun/bin/bun "/Users/tranngoctuan0910/.claude/plugins/cache/thedotmack/claude-mem/10.5.2/scripts/worker-service.cjs"'

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/tranngoctuan0910/Downloads/google-cloud-sdk/path.zsh.inc' ]; then . '/Users/tranngoctuan0910/Downloads/google-cloud-sdk/path.zsh.inc'; fi

# Enable shell command completion for gcloud, deferred off the startup path.
if [ -f '/Users/tranngoctuan0910/Downloads/google-cloud-sdk/completion.zsh.inc' ]; then
  zmodload -F zsh/sched b:sched
  _gcloud_load_completion() {
    unset -f _gcloud_load_completion
    . '/Users/tranngoctuan0910/Downloads/google-cloud-sdk/completion.zsh.inc'
  }
  sched +1 _gcloud_load_completion
fi

# Auto-activate nearest .venv/venv on cd
_auto_venv() {
  local dir="$PWD" venv=""
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.venv/bin/activate" ]]; then
      venv="$dir/.venv"; break
    elif [[ -f "$dir/venv/bin/activate" ]]; then
      venv="$dir/venv"; break
    fi
    dir="${dir:h}"
  done

  if [[ -n "$venv" ]]; then
    [[ "$VIRTUAL_ENV" != "$venv" ]] && { [[ -n "$VIRTUAL_ENV" ]] && deactivate; source "$venv/bin/activate"; }
  elif [[ "$VIRTUAL_ENV" == *"/.venv" || "$VIRTUAL_ENV" == *"/venv" ]]; then
    deactivate
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _auto_venv
_auto_venv

# opencode sandbox wrappers (opencode-sandbox, opencode-docker)
export PATH="$HOME/.config/opencode/sandbox:$PATH"

# Added by anfra installer
export PATH="/Users/tranngoctuan0910/.anfra/bin:$PATH"

# omp (oh-my-pi) shell completions — generated from live command/flag metadata
if command -v omp >/dev/null 2>&1; then
  eval "$(omp completions zsh)"
fi

# local-only secrets (gitignored); see dotfiles/secrets/env.sh
[ -f "$HOME/.config/secrets/env.sh" ] && . "$HOME/.config/secrets/env.sh"
