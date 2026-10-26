/**
 * A copy of a bash command with data-only text blanked, for command rules.
 *
 * Command rules are regexes over the whole command line, so a search pattern
 * (`rg 'git push --force'`), a commit message or a file written from a heredoc
 * can trip a rule meant for a command that actually runs. This view blanks the
 * text that can only ever be data:
 *
 * - search patterns of rg/grep/git grep (never the searched paths);
 * - quoted `git commit -m` messages;
 * - quoted-delimiter heredoc bodies that `cat` writes to a file or stdout, or
 *   that become a git commit or GitHub message, unless anything pipes them on.
 *
 * Anything that could run (interpreters, `bash -c`, `ssh`, substitutions,
 * unquoted heredocs) is left as is. The caller only uses the view to soften a
 * rule match into the normal review flow, never to allow on its own.
 */

/** One shell word on a line, with its raw span and whether it was quoted literally. */
interface Word { start: number; end: number; text: string; literalQuote: boolean }
interface Segment { words: Word[]; next: string; dynamic: boolean }

const OPERATORS = ["&&", "||", "|&", "|", ";", "&"];

/** Split one line into simple-command segments; null when quoting is unbalanced. */
function segments(line: string): Segment[] | null {
  const out: Segment[] = [];
  let words: Word[] = [];
  let dynamic = false;
  let index = 0;
  const finish = (next: string) => { out.push({ words, next, dynamic }); words = []; dynamic = false; };
  while (index < line.length) {
    const char = line[index]!;
    if (char === " " || char === "\t") { index++; continue; }
    const operator = OPERATORS.find(op => line.startsWith(op, index));
    if (operator) { finish(operator); index += operator.length; continue; }
    const start = index;
    let text = "";
    let quoted = false;
    let expanding = false;
    while (index < line.length && !" \t".includes(line[index]!) && !OPERATORS.some(op => line.startsWith(op, index))) {
      const c = line[index]!;
      if (c === "'") {
        const close = line.indexOf("'", index + 1);
        if (close === -1) return null;
        text += line.slice(index + 1, close);
        quoted = true;
        index = close + 1;
      } else if (c === '"') {
        let close = index + 1;
        while (close < line.length && line[close] !== '"') close += line[close] === "\\" ? 2 : 1;
        if (close >= line.length) return null;
        const inner = line.slice(index + 1, close);
        if (/[$`\\]/.test(inner)) expanding = true;
        text += inner;
        quoted = true;
        index = close + 1;
      } else {
        if (c === "$" || c === "`" || c === "\\") expanding = true;
        text += c;
        index++;
      }
    }
    if (expanding) dynamic = true;
    words.push({ start, end: index, text, literalQuote: quoted && !expanding });
  }
  finish("");
  return out;
}

/** Options of rg/grep that consume the following word. */
const SEARCH_VALUE_OPTIONS = new Set([
  "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add", "-A", "-B", "-C", "-m", "--max-count",
  "-M", "--max-columns", "-j", "--threads", "-E", "--encoding", "--sort", "--sortr", "--color", "--colors", "-d",
  "--max-depth", "--maxdepth", "--max-filesize", "--path-separator", "-r", "--replace", "-f", "--file",
  "--context-separator", "--field-match-separator", "--include", "--exclude", "--exclude-dir", "-D", "--label",
  "--pre", "--pre-glob", "--hostname-bin",
]);

/** Indexes of the words that are search patterns or commit messages. */
function dataWords(segment: Segment): number[] {
  const words = segment.words.map(word => word.text);
  const program = words[0]?.replace(/^.*\//, "");
  const found: number[] = [];
  if (program === "rg" || program === "grep" || program === "egrep" || program === "fgrep" || (program === "git" && words[1] === "grep")) {
    let explicit = false;
    let positional = -1;
    for (let index = program === "git" ? 2 : 1; index < words.length; index++) {
      const word = words[index]!;
      if (word === "-e" || word === "--regexp") { explicit = true; found.push(index + 1); index++; }
      else if (SEARCH_VALUE_OPTIONS.has(word)) index++;
      else if (word === "--") { if (positional === -1) positional = index + 1; break; }
      else if (!word.startsWith("-") && positional === -1) positional = index;
    }
    if (!explicit && positional !== -1) found.push(positional);
  } else if (program === "git" && words[1] === "commit") {
    for (let index = 2; index < words.length; index++) {
      if (words[index] === "-m" || words[index] === "--message" || /^-[a-zA-Z]*m$/.test(words[index]!)) found.push(index + 1);
    }
  }
  return found.filter(index => index < segment.words.length && segment.words[index]!.literalQuote);
}

/** Spaces for every character of a word except the quotes that delimit it. */
function blankKeepingDelimiters(raw: string): string {
  let out = "";
  let quote = "";
  for (const char of raw) {
    if (quote === "" && (char === "'" || char === '"')) { quote = char; out += char; }
    else if (char === quote) { quote = ""; out += char; }
    else out += " ";
  }
  return out;
}

/** Replace the chosen words with spaces, keeping their quotes. */
function blankWords(line: string): string {
  const parsed = segments(line);
  if (parsed === null) return line;
  let out = line;
  for (const segment of parsed) {
    if (segment.dynamic) continue;
    for (const index of dataWords(segment)) {
      const word = segment.words[index]!;
      out = out.slice(0, word.start) + blankKeepingDelimiters(out.slice(word.start, word.end)) + out.slice(word.end);
    }
  }
  return out;
}

const HEREDOC = /<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/** Does the heredoc on this line feed a data sink rather than a program? */
function feedsData(header: string, operatorAt: number): "segment" | "substitution" | null {
  // `git commit -m "$(cat <<'EOF'` and the GitHub CLI's --body/--title equivalent.
  const substitution = /^(.*)"\$\(cat[ \t]+<<-?[ \t]*'[A-Za-z_][A-Za-z0-9_]*'[ \t]*$/.exec(header);
  if (substitution) {
    const before = segments(substitution[1]!);
    const last = before?.at(-1);
    if (!last || last.dynamic) return null;
    const words = last.words.map(word => word.text);
    const flag = words.at(-1);
    if (words[0] === "git" && words[1] === "commit" && (flag === "-m" || flag === "--message" || /^-[a-zA-Z]*m$/.test(flag ?? ""))) return "substitution";
    if (words[0] === "gh" && ["pr", "issue"].includes(words[1] ?? "") && ["create", "comment", "edit"].includes(words[2] ?? "") && ["--body", "-b", "--title", "-t"].includes(flag ?? "")) return "substitution";
    return null;
  }
  const parsed = segments(header);
  if (parsed === null) return null;
  // The segment that holds the heredoc operator, by position.
  let offset = 0;
  for (const segment of parsed) {
    const last = segment.words.at(-1);
    if (last === undefined) continue;
    offset = last.end;
    if (segment.words[0]!.start > operatorAt || offset < operatorAt) continue;
    if (segment.dynamic || segment.next === "|" || segment.next === "|&") return null;
    const text = header.slice(segment.words[0]!.start, offset).trim();
    if (/^cat[ \t]*(?:>>?[ \t]*[^\s<>|;&'"`$]+[ \t]*)?<<-?[ \t]*(['"])[A-Za-z_][A-Za-z0-9_]*\1[ \t]*(?:>>?[ \t]*[^\s<>|;&'"`$]+[ \t]*)?$/.test(text)) return "segment";
    const words = segment.words.map(word => word.text);
    if (words[0] === "git" && words[1] === "commit" && words.some((word, index) => (word === "-F" || word === "--file") && words[index + 1] === "-" || word === "--file=-")) return "segment";
    if (words[0] === "gh" && ["pr", "issue"].includes(words[1] ?? "") && words.some((word, index) => (word === "--body-file" || word === "-F") && words[index + 1] === "-")) return "segment";
    return null;
  }
  return null;
}

export function dataBlankedCommand(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const operators = [...line.matchAll(HEREDOC)];
    if (operators.length === 0) { out.push(blankWords(line)); continue; }
    out.push(blankWords(line));
    // Bodies follow in operator order; only a lone quoted heredoc into a data sink is blanked.
    const sink = operators.length === 1 && operators[0]![2] !== "" ? feedsData(line, operators[0]!.index!) : null;
    for (const operator of operators) {
      const delimiter = operator[3]!;
      const stripTabs = operator[1] === "-";
      const end = lines.findIndex((body, at) => at > index && (stripTabs ? body.replace(/^\t+/, "") : body) === delimiter);
      if (end === -1) { out.push(...lines.slice(index + 1)); return out.join("\n"); }
      for (let at = index + 1; at < end; at++) out.push(sink ? "" : lines[at]!);
      out.push(lines[end]!);
      index = end;
    }
    if (sink === "substitution") {
      // The substitution must close right after the terminator, or it was not a plain message.
      if (!/^\)"/.test(lines[index + 1] ?? "")) return command;
    }
  }
  return out.join("\n");
}
