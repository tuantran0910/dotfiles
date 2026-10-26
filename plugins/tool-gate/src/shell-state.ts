/**
 * Does a bash command change what later commands in omp's session shell run?
 *
 * omp runs foreground bash calls in one persistent shell: functions, aliases,
 * variables and options outlive the call (only the working directory is reset).
 * After `ls() { …; }`, `alias cat=…` or `export PATH=/tmp/bin:$PATH`, a later
 * "read" no longer runs the program the fast path vetted, so such a call needs a
 * person's confirmation, and the gate stops trusting the shell afterwards.
 *
 * Ordinary helpers (`S=/tmp/x; …`, `q() { …; }`, `export APP_ENV=local`) cannot
 * change what a fast-path program name means, so they are not flagged. Quoted
 * text and heredoc bodies are ignored: neither can define anything in the
 * session shell without `eval`, `source` or `.`, which are flagged themselves.
 */

import { FAST_PATH_PROGRAMS } from "./classify-input.ts";

/** Variables that steer how the fast-path programs or the shell itself behave. */
const SENSITIVE_VARIABLE = String.raw`(?:PATH|HOME|IFS|ENV|BASH_ENV|ZDOTDIR|CDPATH|FPATH|PS4|PROMPT_COMMAND|PAGER|MANPAGER|SHELL|TMPDIR|POSIXLY_CORRECT|GIT_\w+|RIPGREP_\w+|GREP_\w+|LESS\w*|LD_\w+|DYLD_\w+|BASH_\w+|ZSH_\w+|JQ_\w+)`;

/** Functions the shell calls on its own. */
const HOOKS = String.raw`(?:chpwd|precmd|preexec|periodic|zshexit|zshaddhistory|command_not_found_handler|command_not_found_handle|TRAP\w+)`;

/** A command-position boundary: line start, an operator, a group or a keyword. */
const AT = String.raw`(?:^|[;&|(){}\n]|\b(?:then|do|else)\b)[ \t]*`;

const names = String.raw`(?:${[...FAST_PATH_PROGRAMS, "rtk", "command", "builtin", "exec", "test"].join("|")}|${HOOKS})`;

const PATTERNS = [
  // Evaluation, hooks, aliases, option changes and command lookup tables.
  new RegExp(String.raw`${AT}(?:alias|trap|eval|source|setopt|unsetopt|shopt|enable|disable|hash|autoload|zmodload|emulate)\b`, "m"),
  new RegExp(String.raw`${AT}\.[ \t]+[^\s|;&]`, "m"),
  /\b(?:functions|aliases|galiases|saliases|builtins|commands|options|dis_\w+)\[/,
  // Redefining a fast-path program or a hook: `ls() {`, `function git {`.
  new RegExp(String.raw`(?:^|[\s;&|(){}])(?:function[ \t]+)?${names}[ \t]*\([ \t]*\)`, "m"),
  new RegExp(String.raw`${AT}function[ \t]+${names}\b`, "m"),
  // Setting, exporting, declaring or unsetting a sensitive variable. `IFS=: read`
  // only sets it for that one command, so a bare assignment must end the command.
  new RegExp(String.raw`${AT}${SENSITIVE_VARIABLE}(?:\[[^\]]*\])?\+?=[^\s;&|]*[ \t]*(?:$|[;&|\n)}])`, "m"),
  new RegExp(String.raw`${AT}(?:export|typeset|declare|local|readonly|unset)\b[^;&|\n]*\b${SENSITIVE_VARIABLE}\b`, "m"),
  new RegExp(String.raw`${AT}(?:export|typeset|declare)\b[^;&|\n]*[ \t]-[A-Za-z]*f`, "m"),
];

/** `set` is fine for errexit/nounset/pipefail; any other option (xtrace with PS4, …) is not. */
function setChangesBehaviour(text: string): boolean {
  for (const match of text.matchAll(new RegExp(String.raw`${AT}set\b([^;&|\n]*)`, "gm"))) {
    const tokens = match[1]!.trim().split(/[ \t]+/).filter(Boolean);
    // `set -- …` only sets positional parameters.
    if (tokens[0] === "--") continue;
    const routine = tokens.every((token, index) => /^[-+][euo]+$/.test(token) || (["pipefail", "errexit", "nounset"].includes(token) && /o$/.test(tokens[index - 1] ?? "")));
    if (!routine || tokens.length === 0) return true;
  }
  return false;
}

/** The command with quoted text and heredoc bodies removed. */
function shellCode(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    kept.push(line);
    for (const heredoc of line.matchAll(/<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      const end = lines.findIndex((body, at) => at > index && body.replace(/^\t+/, "") === heredoc[2]);
      index = end === -1 ? lines.length : end;
    }
  }
  return kept.join("\n").replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** A Python virtualenv activation: it prepends the venv's bin to PATH, nothing else. */
const ACTIVATE = new RegExp(String.raw`${AT}(?:source|\.)[ \t]+[^\s;&|]*/bin/activate(?=$|[ \t;&|\n])`, "gm");

/**
 * "redefines": a function, alias, option, hook or sensitive variable changes
 * what later commands run, so a person confirms it.
 * "environment": a virtualenv activation; routine, but later commands may now
 * resolve programs from the venv, so the shell is no longer trusted.
 */
export function shellStateChange(command: string): "redefines" | "environment" | null {
  const code = shellCode(command);
  const activated = ACTIVATE.test(code);
  ACTIVATE.lastIndex = 0;
  const rest = activated ? code.replace(ACTIVATE, "") : code;
  if (PATTERNS.some(pattern => pattern.test(rest)) || setChangesBehaviour(rest)) return "redefines";
  return activated ? "environment" : null;
}

export function changesShellState(command: string): boolean {
  return shellStateChange(command) !== null;
}
