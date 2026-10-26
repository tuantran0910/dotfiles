/**
 * In-project edits: the auto-mode default of letting an agent change its own
 * project without a model round-trip.
 *
 * Only plain targets count. A file inside the project root (the git worktree of
 * cwd, or cwd itself) is ordinary work unless the file configures something that
 * runs later on its own: git internals and hooks, CI, editor tasks, agent
 * settings, direnv/mise, package-manager config. Those stay with the classifier,
 * as does every target outside the project or behind a symlink that leaves it.
 *
 * The system temp directories count too: agents stage commit messages, PR
 * bodies and review notes there. Nothing in them runs on its own, but a repo
 * can be cloned there, so the sensitive names apply at any depth.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";

import { canonicalTarget, resolveTarget } from "./match.ts";

/** Argument keys of omp's replace/patch `edit` and of `write`. Anything else
 * (hashline `input`, unknown fields) may name targets this check cannot see. */
const EDIT_KEYS = new Set(["path", "old_string", "new_string", "replace_all", "edits", "i"]);
const WRITE_KEYS = new Set(["path", "content", "i"]);
const PATCH_ENTRY_KEYS = new Set(["op", "rename", "diff"]);

/** Project-relative paths whose content runs later without another review. */
const SENSITIVE = [
  /^\.git(?:\/|$)/, /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.husky\//, /^\.githooks\//,
  /^\.vscode\//, /^\.idea\//, /^\.claude\//, /^\.omp\//, /^\.agents\//, /^\.mcp\.json$/,
  /^\.gitmodules$/, /^\.gitattributes$/, /^\.pre-commit-config\.yaml$/,
  /^\.?mise\.toml$/, /^\.tool-versions$/,
  // Read from any directory on the way to a command.
  /(?:^|\/)\.envrc$/, /(?:^|\/)\.npmrc$/, /(?:^|\/)\.git\//,
];

const roots = new Map<string, string>();

/** Canonical system temp directories (`/tmp` and `$TMPDIR`). */
export function scratchRoots(): string[] {
  const found = new Set<string>();
  for (const dir of ["/tmp", tmpdir()]) {
    try { found.add(realpathSync(dir)); } catch { /* absent on this system */ }
  }
  return [...found];
}

let defaultScratch = scratchRoots();

/** Replace the temp directories; tests whose fixtures live in temp pass []. */
export function useScratchRoots(dirs: string[]): void { defaultScratch = dirs; }

/** Is a path relative to `root` an ordinary file inside it? */
function within(root: string, target: string): string | null {
  const inside = relative(root, target);
  return inside === "" || inside.startsWith("..") || inside.startsWith("/") ? null : inside.toLowerCase();
}

const isSensitive = (key: string) => SENSITIVE.some(pattern => pattern.test(key));

/** The git worktree containing cwd, or cwd when there is none. */
function projectRoot(cwd: string): string {
  let root = roots.get(cwd);
  if (root === undefined) {
    try {
      root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    } catch { root = cwd; }
    try { root = realpathSync(root); } catch { /* keep the unresolved path */ }
    roots.set(cwd, root);
  }
  return root;
}

function targets(tool: string, input: Record<string, unknown>): string[] | null {
  const keys = tool === "edit" ? EDIT_KEYS : tool === "write" ? WRITE_KEYS : null;
  if (keys === null || Object.keys(input).some(key => !keys.has(key))) return null;
  if (typeof input["path"] !== "string" || input["path"] === "") return null;
  const found = [input["path"]];
  const edits = input["edits"];
  if (edits !== undefined) {
    if (!Array.isArray(edits)) return null;
    for (const entry of edits) {
      if (typeof entry !== "object" || entry === null || Object.keys(entry).some(key => !PATCH_ENTRY_KEYS.has(key))) return null;
      const rename = (entry as Record<string, unknown>)["rename"];
      if (rename !== undefined) {
        if (typeof rename !== "string" || rename === "") return null;
        found.push(rename);
      }
    }
  }
  return found;
}

/** True when every target of an edit/write is an ordinary file of the project or a temp directory. */
export function isWorkspaceEdit(tool: string, input: Record<string, unknown>, cwd: string, home: string, scratch: string[] = defaultScratch): boolean {
  const paths = targets(tool, input);
  if (paths === null) return false;
  const root = projectRoot(cwd);
  return paths.every(path => {
    const target = canonicalTarget(resolveTarget(path, cwd, home));
    // macOS volumes are case-insensitive: `.GIT/config` is `.git/config`.
    const key = within(root, target);
    if (key !== null) return !isSensitive(key);
    return scratch.some(dir => {
      const rest = within(dir, target);
      if (rest === null) return false;
      // Every suffix from a directory boundary: `repo/.github/x` is still CI config.
      const parts = rest.split("/");
      return !parts.some((_, at) => isSensitive(parts.slice(at).join("/")));
    });
  });
}
