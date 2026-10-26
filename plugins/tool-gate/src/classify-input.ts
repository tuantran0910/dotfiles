/**
 * Which calls are worth a model round-trip.
 *
 * Rules run first and stay authoritative; the classifier only sees calls that
 * matched no rule. Even then, read-only work and the obvious local edit case are
 * skipped, because paying a model to approve `ls` is waste.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
export const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df",
  "pwd", "whoami", "date", "which", "type", "echo", "printf", "rg", "grep", "git",
  "jq", "tr", "cut", "diff", "comm", "realpath", "basename", "dirname", "find", "sed", "gh",
]);

/** `gh pr` subcommands that only read. `--web` opens a browser and stays out. */
const GH_PR_READ_COMMANDS = new Set(["view", "checks", "diff"]);

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

/** Every program name the fast path can run, `cd` included. */
export const FAST_PATH_PROGRAMS: ReadonlySet<string> = new Set([...READ_ONLY_COMMANDS, "cd"]);

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
  // A new local branch: `git switch -c NAME [START]` or `git checkout -b NAME [START]`.
  // `-C`/`-B` reset an existing branch and `--force` discards changes; those stay out.
  if ((subcommand === "switch" && (args[0] === "-c" || args[0] === "--create")) || (subcommand === "checkout" && args[0] === "-b")) {
    return (args.length === 2 || args.length === 3) && args.slice(1).every(arg => !arg.startsWith("-"));
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
const DISCARD_REDIRECT = /^(?:(?:[12]|&)?> ?\/dev\/null|2>&1)(?=[ \t;|&\n]|$)/;

/** `$HOME` or `${HOME}` at the start of a word: the home directory, as `~`. */
const HOME_VARIABLE = /^\$(?:HOME(?![A-Za-z0-9_])|\{HOME\})/;

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
  // An operator waits for its right-hand command, possibly on a later line.
  let pending = false;

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
    pending = true;
    return true;
  };
  /** `$HOME` only where nothing precedes it in the word, and only up to `/` or the word's end. */
  const home = (index: number): number => {
    const match = word === "" ? HOME_VARIABLE.exec(command.slice(index)) : null;
    if (match === null) return 0;
    const after = command[index + match[0].length];
    return after === undefined || " \t\n/;|&\"".includes(after) ? match[0].length : 0;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (CONTROL_CHAR.test(char) && char !== "\t" && char !== "\n") return null;
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (quote === '"') {
      const length = char === "$" ? home(index) : 0;
      if (char === '"') quote = "";
      else if (length > 0) { word += "~"; index += length - 1; }
      else if (char === "\\") {
        // Inside double quotes a backslash escapes only `\` and `"` here (`$`,
        // backtick and newline stay rejected); before anything else it is a
        // literal backslash, as in `grep "a\|b"`. brush and zsh agree.
        if (next === "\\" || next === '"') { word += next; index += 1; }
        else if (next === undefined || next === "$" || next === "`" || next === "\n") return null;
        else word += char;
      }
      else if (DOUBLE_QUOTE_SPECIAL.test(char)) return null;
      else word += char;
      continue;
    }
    const redirect = started ? null : DISCARD_REDIRECT.exec(command.slice(index));
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "#") pending = false;
    if (redirect !== null) {
      index += redirect[0].length - 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === "\n") {
      // A newline ends a command like `;`, but blank lines and a line after
      // an operator (`ls &&⏎ pwd`) are allowed.
      endWord();
      if (words.length > 0) { segments.push(words); words = []; }
    } else if (char === "#" && !started) {
      // A comment runs to the end of the line and never executes. Mid-word `#`
      // is a zsh glob operator, so it stays rejected below.
      const end = command.indexOf("\n", index);
      index = (end === -1 ? command.length : end) - 1;
    } else if (char === "$" && !started && home(index) > 0) {
      index += home(index) - 1;
      word += "~";
      started = true;
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
      const boundary = next === undefined || next === "/" || next === " " || next === "\t" || next === "\n";
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
  else if (pending) return null; // trailing operator
  return segments;
}

/** A `cd` whose destination does not depend on CDPATH, OLDPWD or options. */
function cdTarget(words: string[]): string | null {
  if (words[0] !== "cd" || words.length !== 2) return null;
  const target = words[1]!;
  return /^(?:\/|~\/|\.\/|\.\.\/)/.test(target) || ["~", ".", ".."].includes(target) ? target : null;
}

/** rtk subcommands that proxy a fast-path program with its own arguments. */
const RTK_PROXIES = new Set(["ls", "find", "diff", "git", "grep", "rg", "wc"]);
/** rtk subcommands that only read and filter the named files. */
const RTK_READERS = new Set(["read", "json", "log"]);

/**
 * The command an `rtk` (output-condensing proxy) call really runs, or null.
 * `rtk proxy CMD` runs CMD unfiltered; `rtk git …` runs git; `rtk read FILE`
 * reads files. Anything else (`err`, `test`, `env`, `curl`, global options)
 * is not a fast-path read.
 */
function unwrapRtk(words: string[]): string[] | null {
  if (words[0] !== "rtk") return words;
  const [, sub, ...rest] = words;
  if (sub === "proxy") return rest[0] === "rtk" || rest.length === 0 ? null : rest;
  if (sub !== undefined && RTK_PROXIES.has(sub)) return [sub, ...rest];
  if (sub !== undefined && RTK_READERS.has(sub) && rest.length > 0 && rest.every(arg => !arg.startsWith("-"))) return ["cat", ...rest];
  return null;
}

export function isReadOnlySegment(segment: string[]): boolean {
  const words = unwrapRtk(segment);
  if (words === null) return false;
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
  if (program === "gh") {
    return second === "pr" && GH_PR_READ_COMMANDS.has(words[2] ?? "") && !words.some(arg => arg === "--web" || /^-[A-Za-z]*w/.test(arg));
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
const GIT_EXECUTING_CONFIG = String.raw`^(core\.fsmonitor|core\.pager|pager\..+|diff\.external|diff\..+\.(command|textconv)|filter\..+\.(clean|smudge|process)|gpg\.program|gpg\..+\.program)$`;

/**
 * True when the repository at `dir` configures a program that a git read would
 * run. Only repository scopes count: global and system config belong to the
 * user. Any failure to inspect the repository fails closed.
 */
function gitConfigRunsCommands(dir: string): boolean {
  const key = configStamp(dir);
  const cached = key === null ? undefined : probeCache.get(dir);
  if (cached !== undefined && cached.key === key) return cached.runs;
  const runs = probeGitConfig(dir);
  if (key !== null) probeCache.set(dir, { key, runs });
  return runs;
}

const gitDirs = new Map<string, string[] | null>();
const probeCache = new Map<string, { key: string; runs: boolean }>();

/**
 * A fingerprint of the repository's own config files, or null when the probe
 * must not be cached: not a repository, or a config that includes other files.
 */
function configStamp(dir: string): string | null {
  let files = gitDirs.get(dir);
  if (files === undefined) {
    try {
      const [gitDir, commonDir] = execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim().split("\n");
      const common = posix.isAbsolute(commonDir!) ? commonDir! : posix.join(dir, commonDir!);
      files = [posix.join(common, "config"), posix.join(gitDir!, "config.worktree")];
    } catch { files = null; }
    gitDirs.set(dir, files);
  }
  if (files === null) return null;
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = statSync(file);
      if (/^\s*\[include(?:If\b[^\]]*)?\]/im.test(readFileSync(file, "utf8"))) return null;
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}:${stat.ino}`);
    } catch { parts.push(`${file}:absent`); }
  }
  return parts.join("|");
}

function probeGitConfig(dir: string): boolean {
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
    else if (unwrapRtk(words)?.[0]?.replace(/^.*\//, "") === "git" && dirs.some(dir => gitConfigRunsCommands(resolveTarget(dir || ".", options.cwd!, home)))) return false;
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
    // A terminal lets git and gh start a pager, which repository config can name.
    if (input["pty"] !== undefined && input["pty"] !== false) return true;
    const dir = input["cwd"];
    if (dir !== undefined) {
      // The command runs in `dir`: reads are judged there; a heredoc write is left to the classifier.
      if (typeof dir !== "string" || dir === "" || options.cwd === undefined) return true;
      return !isReadOnlyCommand(command, { ...options, cwd: resolveTarget(dir, options.cwd, options.home ?? homedir()) });
    }
    if (isReadOnlyCommand(command, options)) return false;
    // A literal heredoc into an ordinary project file is an in-project write.
    const heredoc = options.cwd === undefined ? null : heredocWrite(command);
    return heredoc === null || !isWorkspaceEdit("write", { path: heredoc.path }, options.cwd!, options.home ?? homedir());
  }
  if (options.cwd !== undefined && isWorkspaceEdit(tool, input, options.cwd, options.home ?? homedir())) return false;
  // Other writes and every MCP tool can change state.
  return true;
}
