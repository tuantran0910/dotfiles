/**
 * Matching primitives: tool-name globs, command regexes and path globs.
 *
 * Path patterns are written the way people think about them (`~/.ssh/**`,
 * `**​/.env`) and are matched against resolved absolute paths, so a rule cannot
 * be dodged with a relative path or a symlinked home directory.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Converts a glob to a RegExp: `**` spans separators, `*` does not. */
export function globToRegExp(glob: string): RegExp {
  if (glob.endsWith("/**")) {
    const parent = globToRegExp(glob.slice(0, -3)).source.slice(1, -1);
    return new RegExp(`^${parent}(?:/.*)?$`);
  }
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          // `**/` means zero or more directories, so `/a/**/b` also matches `/a/b`.
          index += 1;
          out += "(?:.*/)?";
        } else {
          // Bare `**` swallows everything that follows, including nothing.
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      out += "[^/]";
      continue;
    }
    out += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Expands `~` and resolves relative paths against the call's cwd. */
export function resolveTarget(target: string, cwd: string, home: string): string {
  const expanded = target === "~" ? home : target.startsWith("~/") ? `${home}/${target.slice(2)}` : target;
  return resolve(cwd, expanded);
}

/** Resolve the existing ancestor too: a new file can be inside a symlink. */
export function canonicalTarget(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(canonicalTarget(parent), basename(path));
  }
}

function canonicalPattern(pattern: string): string {
  const wildcard = pattern.search(/[?*]/);
  if (wildcard < 0) return canonicalTarget(pattern);
  const slash = pattern.lastIndexOf("/", wildcard);
  if (slash < 0) return pattern;
  return `${canonicalTarget(pattern.slice(0, slash) || "/").replace(/\/$/, "")}/${pattern.slice(slash + 1)}`;
}

/**
 * True when the tool name matches the rule's glob. Blank or `*` means every
 * tool; `read|write|edit` is an explicit alternation, evaluated as separate
 * globs rather than as regex alternatives (which would anchor incorrectly).
 */
export function matchesTool(pattern: string | undefined, tool: string): boolean {
  if (pattern === undefined || pattern.trim() === "" || pattern.trim() === "*") return true;
  return pattern
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .some((part) => globToRegExp(part).test(tool));
}

/** File targets a call touches, for read/write/edit-style tools. */
export function extractPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const single = input["path"];
  if (typeof single === "string" && single !== "") paths.push(single);
  const many = input["paths"];
  if (Array.isArray(many)) {
    for (const entry of many) {
      if (typeof entry === "string" && entry !== "") paths.push(entry);
    }
  }
  return paths;
}

/** True when any of the call's paths matches any of the rule's globs. */
export function matchesAnyPath(
  patterns: string[],
  targets: string[],
  cwd: string,
  home: string,
  allAliases = false,
): string | null {
  for (const target of targets) {
    const resolved = resolveTarget(target, cwd, home);
    // A symlink in the workspace must not smuggle a protected file past a rule:
    // test the real location as well as the path as written.
    const real = canonicalTarget(resolved);
    // A home directory can itself be behind a symlink (macOS /var -> /private/var),
    // so `~` patterns are expanded against both spellings.
    const homes = new Set<string>([home]);
    try {
      homes.add(realpathSync(home));
    } catch {
      // home does not exist: the plain spelling is all we have
    }

    for (const pattern of patterns) {
      for (const base of pattern.startsWith("~") ? homes : new Set([home])) {
        const expanded = pattern.startsWith("**/") ? pattern : resolveTarget(pattern, cwd, base);
        const regex = globToRegExp(expanded);
        const canonical = globToRegExp(canonicalPattern(expanded));
        const matches = (path: string) => regex.test(path) || canonical.test(path);
        if (allAliases ? matches(resolved) && matches(real) : matches(resolved) || matches(real)) return real;
      }
    }
  }
  return null;
}

/** Compiles a command regex, returning null when the pattern is invalid. */
export function compileCommand(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "m");
  } catch {
    return null;
  }
}
