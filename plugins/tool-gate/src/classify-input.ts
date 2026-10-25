/**
 * Which calls are worth a model round-trip.
 *
 * Rules run first and stay authoritative; the classifier only sees calls that
 * matched no rule. Even then, read-only work and the obvious local edit case are
 * skipped, because paying a model to approve `ls` is waste.
 */

/** omp tools that cannot change state. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "search", "skill", "rule"]);

/** First words of shell commands that only read. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "bat", "wc", "stat", "file", "du", "df",
  "pwd", "whoami", "date", "which", "type", "echo", "printf", "rg", "grep", "ag", "ack", "git",
  "tree", "jq", "tr", "cut", "sort", "uniq", "diff", "comm", "realpath", "basename", "dirname",
  "node", "bun", "npm", "pnpm", "yarn", "cargo", "go", "python3", "pip", "uv", "ruff",
]);

/** Shell metacharacters that turn a read into a write or a nested execution. */
const MUTATING_SYNTAX = /[>|<;&`]|\$\(|\|\||&&/;

/** Flags that make a read-only-looking command write. */
const MUTATING_FLAGS = /(?:^|\s)(?:-i|--in-place|-delete|-exec|-execdir|--output|--fix)(?:\s|=|$)/;

/** Subcommands that write despite a read-only first word. */
const MUTATING_SUBCOMMANDS =
  /^(?:git\s+(?:push|commit|tag|reset|checkout|switch|clean|merge|rebase|apply|am|stash|remote|config|branch\s+-[dD]|worktree)|npm\s+(?:install|i|publish|uninstall|ci)|bun\s+(?:install|add|remove|publish)|cargo\s+(?:publish|install)|pip\s+install|uv\s+(?:pip|add)|go\s+install)/;

/** True when a bash command only reads. Deliberately conservative. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return true;
  if (MUTATING_SYNTAX.test(trimmed)) return false;
  if (MUTATING_FLAGS.test(trimmed)) return false;
  if (MUTATING_SUBCOMMANDS.test(trimmed)) return false;

  const [first, second] = trimmed.split(/\s+/);
  if (first === undefined) return true;
  const program = first.replace(/^.*\//, "");
  if (!READ_ONLY_COMMANDS.has(program)) return false;

  // `git`/`npm`-style tools need their read-only subcommand checked explicitly.
  if (program === "git") {
    return ["status", "diff", "log", "show", "branch", "remote", "rev-parse", "blame", "describe", "ls-files"].includes(
      (second ?? "").replace(/^-.*/, ""),
    );
  }
  return true;
}

/** True when this call should be escalated to the classifier if no rule matched. */
export function needsClassification(tool: string, input: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(tool)) return false;
  if (tool === "bash") {
    const command = input["command"];
    return typeof command !== "string" || !isReadOnlyCommand(command);
  }
  // write/edit and every MCP tool can change state.
  return true;
}
