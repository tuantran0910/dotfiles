/**
 * Pure placement rules for worktree-kit.
 *
 * The tool owns destination selection: a caller passes a repository and a
 * branch, never a path. That is what makes the worktrees predictable and keeps
 * them inside the repository's own `.omp/worktrees/` directory.
 */

/** Directory (relative to the repository root) where worktrees are placed. */
export const WORKTREE_ROOT = ".omp/worktrees";

/** Git refs that must never be used as a branch name for a new worktree. */
const RESERVED_BRANCHES = new Set(["HEAD", "main", "master"]);

/** Converts a branch name into a single safe directory name. */
export function branchSlug(branch: string): string {
  const slug = branch
    .trim()
    .replace(/[\\/\s]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (slug === "") throw new Error(`branch name "${branch}" has no usable characters`);
  return slug;
}

/** Absolute destination for a branch, inside the repository. */
export function resolveDestination(repoRoot: string, branch: string): string {
  return `${repoRoot.replace(/\/+$/, "")}/${WORKTREE_ROOT}/${branchSlug(branch)}`;
}

/** True when a path is inside the managed worktree root of this repository. */
export function isManagedPath(repoRoot: string, path: string): boolean {
  return path.startsWith(`${repoRoot.replace(/\/+$/, "")}/${WORKTREE_ROOT}/`);
}

/** Rejects branch names that would collide with an existing ref we must not move. */
export function assertUsableBranch(branch: string): void {
  const name = branch.trim();
  if (name === "") throw new Error("branch must not be empty");
  if (RESERVED_BRANCHES.has(name)) throw new Error(`branch "${name}" is reserved; pick a task branch`);
  if (name.startsWith("-")) throw new Error(`branch "${name}" must not start with a dash`);
  if (/\s/.test(name)) throw new Error(`branch "${name}" must not contain whitespace`);
}

/**
 * Builds `git worktree add` arguments.
 *
 * An existing branch is checked out as-is; a new one is created from `baseRef`.
 * The destination always comes from the repository and branch, never the caller.
 */
export function buildAddArgs(options: {
  repoRoot: string;
  branch: string;
  baseRef: string;
  destination: string;
  branchExists: boolean;
}): string[] {
  const { repoRoot, branch, baseRef, destination, branchExists } = options;
  const args = ["-C", repoRoot, "worktree", "add"];
  if (branchExists) return [...args, destination, branch];
  return [...args, "-b", branch, destination, baseRef || "HEAD"];
}

/**
 * Parses `git worktree list --porcelain` into worktree records.
 *
 * Output is blank-line separated blocks of `key value` lines; bare and detached
 * worktrees simply omit `branch`.
 */
export interface WorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const record: WorktreeRecord = { path: "", bare: false, detached: false, prunable: false };
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") record.path = value;
      else if (key === "HEAD") record.head = value;
      else if (key === "branch") record.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") record.bare = true;
      else if (key === "detached") record.detached = true;
      else if (key === "prunable") record.prunable = true;
    }
    if (record.path !== "") records.push(record);
  }
  return records;
}

/** The main worktree is the first record; everything else is linked. */
export function linkedWorktrees(records: WorktreeRecord[]): WorktreeRecord[] {
  return records.slice(1).filter((record) => !record.prunable);
}

/**
 * Detects a model-issued `git worktree add|move` that names an absolute
 * destination. Returns null for reads, for user `!` commands, and for
 * repository-relative destinations.
 */
export function parseDirectWorktreeCommand(command: string): {
  action: "add" | "move";
  destination: string;
} | null {
  const tokens = command.trim().split(/\s+/);
  // Only a real git invocation counts: `echo worktree add /tmp/x` must not match.
  if (!/^(?:.*\/)?git$/.test(tokens[0] ?? "")) return null;

  const worktreeIndex = tokens.findIndex((token, index) => token === "worktree" && index > 0);
  if (worktreeIndex === -1) return null;

  const action = tokens[worktreeIndex + 1];
  if (action !== "add" && action !== "move") return null;

  // Flags that consume the following token, so it is not the destination.
  const valueFlags = new Set(["-b", "-B", "--reason", "--orphan"]);
  let destination: string | null = null;
  for (let index = worktreeIndex + 2; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    destination = token;
    if (action === "add") break;
  }

  if (destination === null || !destination.startsWith("/")) return null;
  return { action, destination };
}

/** Human summary of a `git status --porcelain` result. */
export function describeDirtyMain(statusOutput: string): string | null {
  const entries = statusOutput.split("\n").filter((line) => line.trim() !== "");
  if (entries.length === 0) return null;
  const staged = entries.filter((line) => !line.startsWith("??") && line[0] !== " ").length;
  const untracked = entries.filter((line) => line.startsWith("??")).length;
  const modified = entries.length - staged - untracked;
  return `${entries.length} path(s): ${staged} staged, ${modified} modified, ${untracked} untracked`;
}
