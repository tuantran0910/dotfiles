/**
 * Herdr backend helpers.
 *
 * Inside Herdr (`HERDR_ENV=1`) the multiplexer owns worktree placement, so the
 * tool must ask it to create the worktree instead of choosing a path. Arguments
 * and JSON shapes are kept here as pure functions so they can be tested without
 * a running Herdr.
 */

import { branchSlug } from "./placement.ts";

/** Recursively collects every absolute-path string in a JSON document. */
function collectPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("/")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectPaths(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectPaths(entry, out);
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function buildCreateArgs(repository: string, branch: string, baseRef: string): string[] {
  return ["worktree", "create", "--cwd", repository, "--branch", branch, "--base", baseRef || "HEAD", "--no-focus"];
}

export function buildListArgs(repository: string): string[] {
  return ["worktree", "list", "--cwd", repository];
}

export function buildOpenArgs(repository: string, path: string): string[] {
  return ["worktree", "open", "--cwd", repository, "--path", path, "--no-focus"];
}

export function buildRemoveArgs(workspaceId: string, force: boolean): string[] {
  return ["worktree", "remove", "--workspace", workspaceId, ...(force ? ["--force"] : [])];
}

/**
 * Extracts the created worktree path from Herdr's JSON.
 * Prefers a path containing the branch slug, then any absolute path.
 */
export function findCreatedPath(output: string, branch: string): string | null {
  const paths = collectPaths(parseJson(output));
  const slug = branchSlug(branch);
  return paths.find((path) => path.includes(`/${slug}`)) ?? paths.find((path) => path.includes(slug)) ?? paths[0] ?? null;
}

/** Finds a workspace id in Herdr's `worktree open` JSON, at any depth. */
export function findWorkspaceId(output: string): string | null {
  const search = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = search(entry);
        if (found !== null) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const field of ["workspace_id", "workspaceId"]) {
      if (typeof record[field] === "string") return record[field] as string;
    }
    for (const entry of Object.values(record)) {
      const found = search(entry);
      if (found !== null) return found;
    }
    return null;
  };
  return search(parseJson(output));
}

export interface HerdrWorktree {
  path: string;
  branch?: string;
  isMain: boolean;
  isPrunable: boolean;
}

/** Parses `herdr worktree list` JSON, accepting both documented shapes. */
export function parseHerdrList(output: string): HerdrWorktree[] {
  const document = parseJson(output);
  if (!document || typeof document !== "object") return [];
  const record = document as Record<string, unknown>;
  const result = (record["result"] ?? record) as Record<string, unknown>;
  const raw = result["worktrees"];
  if (!Array.isArray(raw)) return [];

  const worktrees: HerdrWorktree[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const path = item["path"];
    if (typeof path !== "string") continue;
    worktrees.push({
      path,
      branch: typeof item["branch"] === "string" ? item["branch"] : undefined,
      isMain: item["is_linked_worktree"] !== true,
      isPrunable: item["is_prunable"] === true,
    });
  }
  return worktrees;
}

/**
 * Refuses removal when the target hosts the current agent session: removing that
 * workspace would close the pane and kill the agent running in it.
 */
export function isCurrentWorkspace(workspaceId: string, currentWorkspaceId = process.env["HERDR_WORKSPACE_ID"]): boolean {
  return currentWorkspaceId !== undefined && currentWorkspaceId === workspaceId;
}
