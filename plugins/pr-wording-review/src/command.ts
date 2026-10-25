/**
 * Detects `gh pr create|edit` commands that carry the description in a file,
 * and extracts the file paths.
 *
 * `--body-file` (and its `-F` short form) is the one write path where the slop
 * patterns cannot see the text: the command line only contains a path.
 */

/** Minimal shell word splitter: respects single and double quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[(index += 1)];
      } else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Index of the `pr create|edit` arguments, or -1 when this is not a PR write. */
export function prWriteIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const program = tokens[index]!;
    if (program !== "gh" && !program.endsWith("/gh")) continue;
    if (tokens[index + 1] !== "pr") continue;
    const verb = tokens[index + 2];
    if (verb === "create" || verb === "edit") return index + 2;
  }
  return -1;
}

/** Body files named by `--body-file <path>`, `--body-file=<path>`, `-F <path>`. */
export function bodyFilePaths(command: string): string[] {
  const tokens = tokenize(command);
  const start = prWriteIndex(tokens);
  if (start === -1) return [];

  const paths: string[] = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--body-file" || token === "-F") {
      const value = tokens[index + 1];
      if (value !== undefined) paths.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--body-file=")) paths.push(token.slice("--body-file=".length));
    else if (token.startsWith("-F=")) paths.push(token.slice(3));
  }
  return paths.filter((path) => path !== "" && path !== "-");
}

/** True when the description comes from commit messages instead of the flag. */
export function usesFillFlag(command: string): boolean {
  const tokens = tokenize(command);
  return prWriteIndex(tokens) !== -1 && tokens.some((token) => token === "--fill" || token === "--fill-first");
}

/** Text supplied on stdin to `gh pr ... -F -`, from a heredoc or a pipe. */
export function stdinBody(command: string): string | null {
  const tokens = tokenize(command);
  const start = prWriteIndex(tokens);
  if (start === -1) return null;

  const takesStdin = tokens
    .slice(start + 1)
    .some((token, index, all) => (token === "-F" || token === "--body-file") && all[index + 1] === "-");
  if (!takesStdin) return null;

  const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/.exec(command);
  if (heredoc?.[2]) return heredoc[2];

  const piped = command.split("|")[0]?.trim() ?? "";
  return piped !== "" && piped !== command ? piped : null;
}

/**
 * Text written into `path` by the same command (heredoc or echo redirect), which
 * covers `echo "..." > body.md && gh pr create -F body.md`.
 */
export function redirectedText(command: string, path: string): string | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const redirect = new RegExp(`>>?\\s*['"]?${escaped}['"]?`).exec(command);
  if (!redirect) return null;

  const before = command.slice(0, redirect.index);
  const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/.exec(command);
  if (heredoc?.[2]) return heredoc[2];

  const quoted = /["']([^"']{4,})["']\s*$/.exec(before);
  if (quoted?.[1]) return quoted[1];

  const words = before.split(/\s+/).filter(Boolean);
  return words.length > 0 ? words.slice(1).join(" ") : null;
}

/**
 * Field text from a `gh api /repos/<o>/<r>/pulls` POST, which creates a pull
 * request without going through `gh pr create`.
 */
export function apiPullText(command: string): string | null {
  if (!/\bgh\s+api\b/.test(command)) return null;
  if (!/\/repos\/[^/\s"']+\/[^/\s"']+\/pulls(?:\s|$|["'])/.test(command)) return null;

  const posts = /(?:--method|-X)\s+["']?POST\b/i.test(command) || /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s|=)/.test(command);
  if (!posts) return null;

  const tokens = tokenize(command);
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const attached = /^(?:-f|-F|--field|--raw-field)=(.+)$/.exec(token)
      ?? /^(?:title|body)=([\s\S]*)$/.exec(token);
    if (attached?.[1]) {
      values.push(attached[1]);
      continue;
    }
    if (token === "-f" || token === "-F" || token === "--field" || token === "--raw-field") {
      const next = tokens[index + 1];
      if (next !== undefined) {
        const pair = /^(?:title|body)=([\s\S]*)$/.exec(next);
        values.push(pair?.[1] ?? next);
      }
      index += 1;
    }
  }
  return values.length > 0 ? values.join("\n") : null;
}
