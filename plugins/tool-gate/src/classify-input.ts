/**
 * Which calls are worth a model round-trip.
 *
 * Rules run first and stay authoritative; the classifier only sees calls that
 * matched no rule. Even then, read-only work and the obvious local edit case are
 * skipped, because paying a model to approve `ls` is waste.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { posix } from "node:path";

import { resolveTarget } from "./match.ts";
import { isWorkspaceEdit } from "./workspace.ts";

/** omp tools that cannot change state outside the agent's own session. `task`
 * only starts subagents: omp re-binds this extension in each one, so every call
 * they make is gated on its own (without a UI, so a prompt there is a denial). */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "find", "search", "skill", "rule", "todo", "ask", "task"]);

/** First words of shell commands that only read. Programs with a pager,
 * preprocessor, compressor or output-file operand stay out on purpose. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df",
  "pwd", "whoami", "date", "which", "type", "echo", "printf", "rg", "grep", "git",
  "jq", "tr", "cut", "diff", "comm", "realpath", "basename", "dirname", "find", "sed",
]);

/** `find` options and primaries that only select or print. Anything else
 * (`-exec`, `-ok`, `-delete`, `-fprint`, BSD `-f`, unknown primaries) is out. */
const FIND_READ_OPTIONS = new Set([
  "-H", "-L", "-P", "-E", "-x", "-s",
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname",
  "-type", "-xtype", "-maxdepth", "-mindepth", "-depth", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin",
  "-newer", "-size", "-empty", "-perm", "-user", "-group", "-uid", "-gid", "-links", "-inum", "-nouser", "-nogroup",
  "-readable", "-writable", "-executable", "-follow", "-xdev", "-mount",
  "-print", "-print0", "-printf", "-ls", "-prune", "-quit", "-true", "-false",
  "-o", "-or", "-a", "-and", "-not",
]);

/** Flags that make a read-only-looking command write. */
const MUTATING_FLAGS = /(?:^|\s)(?:--(?:in-place|output|fix|fix-only|pre|pre-glob|hostname-bin|ext-diff|textconv|run-tests|upload|set|date|compile))(?:\s|=|$)/;

/** Subcommands that write despite a read-only first word. */
const GIT_READ_COMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "blame", "describe", "ls-files"]);

/** `git add` options that stage tracked or named paths. `-f` (ignored files such
 * as `.env`) and interactive modes stay out. */
const GIT_ADD_OPTIONS = new Set(["-A", "--all", "-u", "--update", "-N", "--intent-to-add", "-v", "--verbose", "--"]);
/** `git commit` options for an ordinary local commit. `--no-verify`/`-n` skip
 * the user's hooks, so they stay with the classifier. */
const GIT_COMMIT_OPTIONS = new Set(["-a", "--all", "--amend", "--no-edit", "-s", "--signoff", "-q", "--quiet", "-v", "--verbose", "--allow-empty", "--allow-empty-message"]);
const GIT_COMMIT_VALUE_OPTIONS = new Set(["-m", "--message", "-F", "--file", "--author", "--date"]);

/** Local commits are routine task work by the user's policy; they are not
 * reads, but they change nothing outside the repository. */
function isRoutineGitWrite(subcommand: string, args: string[]): boolean {
  if (subcommand === "add") {
    const separator = args.indexOf("--");
    return args.every((arg, index) => (separator !== -1 && index > separator) || !arg.startsWith("-") || GIT_ADD_OPTIONS.has(arg));
  }
  if (subcommand !== "commit") return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const takesValue = GIT_COMMIT_VALUE_OPTIONS.has(arg) || /^-[as]*[mF]$/.test(arg);
    if (takesValue) {
      if (index + 1 >= args.length) return false;
      index++;
    } else if (!(GIT_COMMIT_OPTIONS.has(arg) || /^-[as]+$/.test(arg) || /^--(?:message|file|author|date)=/.test(arg))) {
      return false;
    }
  }
  return true;
}

/** Unquoted characters that the shell passes through as a literal word. */
const LITERAL_CHAR = /[A-Za-z0-9_.\/:=@%+,-]/;

/** Characters that expand or escape inside double quotes. */
const DOUBLE_QUOTE_SPECIAL = /[$`\\!]/;

/** Control characters end a command or hide one, in any quoting. */
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

/** The only redirections accepted: discarding output, or merging stderr into
 * stdout. Each must stand alone as a word; `>|`, `>>` and other targets are
 * rejected with every other redirection. */
const DISCARD_REDIRECT = /^(?:(?:[12]|&)?> ?\/dev\/null|2>&1)(?=[ \t;|&]|$)/;

/**
 * Split a script into the literal words of each simple command, or return null.
 *
 * The accepted grammar is deliberately tiny: literal words, single quotes,
 * double quotes without expansion, the operators `&&`, `||`, `;` and `|`, and
 * output discarded to /dev/null. Everything else (other redirection, expansion,
 * globbing, grouping, background jobs,
 * comments, zsh `=cmd` and `~user`) is rejected rather than interpreted, so a
 * gap in this parser sends a call to the classifier instead of past it.
 */
export function parseSegments(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";

  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (CONTROL_CHAR.test(char) && char !== "\t") return null;
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else if (DOUBLE_QUOTE_SPECIAL.test(char)) return null;
      else word += char;
      continue;
    }
    const redirect = started ? null : DISCARD_REDIRECT.exec(command.slice(index));
    if (redirect !== null) {
      index += redirect[0].length - 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "&") {
      if (next !== "&" || !endSegment()) return null;
      index += 1;
    } else if (char === "|") {
      if (!endSegment()) return null;
      if (next === "|") index += 1;
    } else if (char === ";") {
      if (!endSegment()) return null;
    } else if (char === "~") {
      // A leading tilde only in its plain home forms (`~user` names another
      // home). Mid-word it is literal (`HEAD~1`), except after `=` or `:`,
      // where zsh and bash assignments expand it.
      const boundary = next === undefined || next === "/" || next === " " || next === "\t";
      if (started ? command[index - 1] === "=" || command[index - 1] === ":" : !boundary) return null;
      word += char;
      started = true;
    } else if (LITERAL_CHAR.test(char)) {
      // zsh expands a leading `=name` to the path of a command.
      if (char === "=" && !started) return null;
      word += char;
      started = true;
    } else {
      return null;
    }
  }
  if (quote) return null;
  endWord();
  if (words.length > 0) segments.push(words);
  else if (segments.length > 0) return null; // trailing operator
  return segments;
}

/** A `cd` whose destination does not depend on CDPATH, OLDPWD or options. */
function cdTarget(words: string[]): string | null {
  if (words[0] !== "cd" || words.length !== 2) return null;
  const target = words[1]!;
  return /^(?:\/|~\/|\.\/|\.\.\/)/.test(target) || ["~", ".", ".."].includes(target) ? target : null;
}

export function isReadOnlySegment(words: string[]): boolean {
  if (cdTarget(words) !== null) return true;
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
    return GIT_READ_COMMANDS.has(second ?? "") || isRoutineGitWrite(second ?? "", words.slice(2));
  }
  // These programs accept expressions or system-changing options; only their
  // narrow, familiar read forms belong in the fast path.
  if (program === "date") return words.length === 1;
  if (program === "file" && /(?:^|\s)-[A-Za-z]*C/.test(normalized)) return false;
  if (program === "jq" && second !== ".") return false;
  // zsh's printf evaluates `-v` targets and numeric arguments (`%d`, `*`
  // widths) as arithmetic, where an array subscript runs `$(...)`. Only string
  // conversions with literal flags, width and precision stay.
  if (program === "printf") return second !== undefined && !second.startsWith("-") && !second.replace(/%(?:%|[-+ #0]*\d*(?:\.\d*)?[sbcq])/g, "").includes("%");
  // Only `sed -n N[,M]p [file...]`: any other script can write (`w`) or run (`e`).
  if (program === "sed") return second === "-n" && /^\d+(?:,\d+)?p$/.test(words[2] ?? "") && words.slice(3).every(arg => !arg.startsWith("-"));
  // Numeric values such as `-mtime -7` or `-size -10k` are arguments, not primaries.
  if (program === "find" && words.slice(1).some(arg => arg.startsWith("-") && !FIND_READ_OPTIONS.has(arg) && !/^[-+]\d+[A-Za-z]?$/.test(arg))) return false;
  // `-z`/`--search-zip` hand each file to an external decompressor.
  if (program === "rg" && words.some(arg => arg === "--search-zip" || /^-[A-Za-z]*z/.test(arg))) return false;
  return true;
}

/** Repository config that makes `git status`/`diff`/`log` run a program. */
const GIT_EXECUTING_CONFIG = String.raw`^(core\.fsmonitor|diff\.external|diff\..+\.(command|textconv)|filter\..+\.(clean|smudge|process)|gpg\.program|gpg\..+\.program)$`;

/**
 * True when the repository at `dir` configures a program that a git read would
 * run. Only repository scopes count: global and system config belong to the
 * user. Any failure to inspect the repository fails closed.
 */
function gitConfigRunsCommands(dir: string): boolean {
  let output: string;
  try {
    output = execFileSync("git", ["-C", dir, "config", "--show-scope", "--get-regexp", GIT_EXECUTING_CONFIG], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    // Exit 1 with no output is git's "no matching key".
    return !(failure.status === 1 && !failure.stdout);
  }
  return output.split("\n").some(line => {
    const match = /^(\S+)\t(\S+)(?: (.*))?$/.exec(line);
    if (match === null) return line.trim() !== "";
    const [, scope, key, value = ""] = match;
    if (scope !== "local" && scope !== "worktree") return false;
    // A boolean selects git's built-in monitor; any other value is a hook command.
    if (key === "core.fsmonitor" && /^(?:true|false|yes|no|on|off|1|0)$/i.test(value)) return false;
    return true;
  });
}

/** Directories a segment may run in: a failed `cd` before `;` or `||` leaves the old one. */
function nextDirs(dirs: string[], target: string): string[] {
  const moved = dirs.map(dir => target.startsWith("/") || target.startsWith("~") || dir === "" ? target : posix.join(dir, target));
  return [...new Set([...dirs, ...moved])];
}

/**
 * True when a bash command only reads. Deliberately conservative.
 *
 * With `cwd`, git segments are also checked against the repository they would
 * run in, because repository config can attach commands to plain reads.
 */
export function isReadOnlyCommand(command: string, options: { cwd?: string; home?: string } = {}): boolean {
  if (command.trim() === "") return true;
  const segments = parseSegments(command);
  if (segments === null) return false;
  if (!segments.every(isReadOnlySegment)) return false;
  if (options.cwd === undefined) return true;

  const home = options.home ?? homedir();
  let dirs = [""];
  for (const words of segments) {
    const target = cdTarget(words);
    if (target !== null) dirs = nextDirs(dirs, target);
    else if (words[0]?.replace(/^.*\//, "") === "git" && dirs.some(dir => gitConfigRunsCommands(resolveTarget(dir || ".", options.cwd!, home)))) return false;
  }
  return true;
}

/** Candidate literal file operands of every segment, including `cd` targets.
 * After a `cd`, relative operands are listed against each directory they may
 * resolve in. Checking extra operands is conservative. */
export function readOnlyPaths(command: string): string[] {
  const paths = new Set<string>();
  let dirs = [""];
  for (const words of parseSegments(command.trim()) ?? []) {
    const target = cdTarget(words);
    const operands = words.slice(1).map(word => {
      return word.startsWith("--") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
    }).filter(word => word !== "" && !word.startsWith("-"));
    for (const operand of operands) {
      for (const dir of dirs) {
        paths.add(operand.startsWith("/") || operand.startsWith("~") || dir === "" ? operand : posix.join(dir, operand));
      }
    }
    if (target !== null) dirs = nextDirs(dirs, target);
  }
  return [...paths];
}

/** True when this call should be escalated to the classifier if no rule matched. */
/** Literal words only: no quoting, expansion or other shell syntax. */
const PLAIN_WORD = String.raw`[A-Za-z0-9_.\/:@%+,~-]+`;
const HEREDOC_HEADER = new RegExp(String.raw`^(?:cd[ \t]+(${PLAIN_WORD})[ \t]*&&[ \t]*)?cat[ \t]*(?:>>?[ \t]*(${PLAIN_WORD})[ \t]*<<(['"])([A-Za-z_][A-Za-z0-9_]*)\3|<<(['"])([A-Za-z_][A-Za-z0-9_]*)\5[ \t]*>>?[ \t]*(${PLAIN_WORD}))[ \t]*$`);

/**
 * The file a heredoc write creates or appends to, or null.
 *
 * Accepted: `[cd DIR &&] cat >|>> FILE <<'EOF'` (or the delimiter first) with a
 * quoted delimiter, so the body is literal and never expanded, and nothing after
 * the terminator. The caller still checks the target like an edit.
 */
export function heredocWrite(command: string): { path: string } | null {
  const newline = command.indexOf("\n");
  if (newline === -1) return null;
  const header = HEREDOC_HEADER.exec(command.slice(0, newline));
  if (header === null) return null;
  const [, dir, before, , beforeDelimiter, , afterDelimiter, after] = header;
  const delimiter = beforeDelimiter ?? afterDelimiter!;
  const file = before ?? after!;
  const lines = command.slice(newline + 1).split("\n");
  const end = lines.indexOf(delimiter);
  // The terminator must close the command: only one trailing newline may follow.
  if (end === -1 || lines.length - end > 2 || (lines.length - end === 2 && lines.at(-1) !== "")) return null;
  // `~user`, a leading `=` (zsh) and option-like names are not plain files.
  if (/^(?:~[^/]|=|-)/.test(file)) return null;
  if (dir === undefined) return { path: file };
  if (cdTarget(["cd", dir]) === null) return null;
  return { path: file.startsWith("/") || file.startsWith("~") ? file : posix.join(dir, file) };
}

export function needsClassification(tool: string, input: Record<string, unknown>, options: { cwd?: string; home?: string } = {}): boolean {
  if (READ_ONLY_TOOLS.has(tool)) return false;
  if (tool === "bash") {
    const command = input["command"];
    if (typeof command !== "string") return true;
    if (isReadOnlyCommand(command, options)) return false;
    // A literal heredoc into an ordinary project file is an in-project write.
    const heredoc = options.cwd === undefined ? null : heredocWrite(command);
    return heredoc === null || !isWorkspaceEdit("write", { path: heredoc.path }, options.cwd!, options.home ?? homedir());
  }
  if (options.cwd !== undefined && isWorkspaceEdit(tool, input, options.cwd, options.home ?? homedir())) return false;
  // Other writes and every MCP tool can change state.
  return true;
}
