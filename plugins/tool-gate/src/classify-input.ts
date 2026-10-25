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
]);

/** Shell metacharacters that turn a read into a write or a nested execution. */
const MUTATING_SYNTAX = /[>|<;&`$\\\r\n\x00*?\[\]{}]/;

/** Flags that make a read-only-looking command write. */
const MUTATING_FLAGS = /(?:^|\s)(?:-[A-Za-z]*[io][A-Za-z]*|--(?:in-place|output|fix|fix-only|pre|pre-glob|hostname-bin|ext-diff|textconv|run-tests|upload|set|date|compile))(?:\s|=|$)/;

/** Subcommands that write despite a read-only first word. */
const GIT_READ_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "blame", "describe", "ls-files"]);

/** Decode literal shell words only. Expansion, escapes and operators are
 * rejected separately; unmatched quotes are never guessed at. */
function literalWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** True when a bash command only reads. Deliberately conservative. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return true;
  if (MUTATING_SYNTAX.test(trimmed)) return false;
  const words = literalWords(trimmed);
  if (words === null) return false;
  const normalized = words.join(" ");
  if (MUTATING_FLAGS.test(normalized)) return false;

  const [first, second] = words;
  if (first === undefined) return true;
  const program = first.replace(/^.*\//, "");
  // An arbitrary executable named /tmp/ls or ./cat is not the system reader.
  if (first.includes("/") && !["/bin", "/usr/bin"].some(dir => first === `${dir}/${program}`)) return false;
  if (!READ_ONLY_COMMANDS.has(program)) return false;

  // `git`/`npm`-style tools need their read-only subcommand checked explicitly.
  if (program === "git") {
    return GIT_READ_COMMANDS.has(second ?? "");
  }
  // These programs accept expressions or system-changing options; only their
  // narrow, familiar read forms belong in the fast path.
  if (program === "date") return words.length === 1;
  if (program === "file" && /(?:^|\s)-[A-Za-z]*C/.test(normalized)) return false;
  if (program === "jq" && second !== ".") return false;
  return true;
}

/** Candidate literal file operands for a single fast-path command. Uncertain
 * shell syntax never reaches here. Checking extra operands is conservative. */
export function readOnlyPaths(command: string): string[] {
  const words = literalWords(command.trim()) ?? [];
  return words.slice(1).map(word => {
    return word.startsWith("--") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  }).filter(word => word !== "" && !word.startsWith("-"));
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
