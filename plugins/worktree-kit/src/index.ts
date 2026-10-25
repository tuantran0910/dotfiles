/**
 * worktree-kit: durable git worktrees for agent tasks.
 *
 * One tool, `worktree`, with `create` / `list` / `remove`.
 *
 * Placement is owned by the active backend:
 * - git    (default): `<repository>/.omp/worktrees/<branch-slug>`
 * - herdr  (`HERDR_ENV=1`): Herdr chooses the location; we only ask it to create
 *
 * Direct `git worktree add|move` commands are not blocked — they are observed.
 * An absolute destination outside the managed root gets a reminder attached to
 * the command result and is recorded for the next session in that repository.
 */

import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCreateArgs as buildHerdrCreateArgs,
  buildListArgs as buildHerdrListArgs,
  buildOpenArgs as buildHerdrOpenArgs,
  buildRemoveArgs as buildHerdrRemoveArgs,
  findCreatedPath,
  findWorkspaceId,
  isCurrentWorkspace,
  parseHerdrList,
} from "./herdr.ts";
import { IncidentStore } from "./incidents.ts";
import {
  WORKTREE_ROOT,
  assertUsableBranch,
  buildAddArgs,
  describeDirtyMain,
  isManagedPath,
  linkedWorktrees,
  parseDirectWorktreeCommand,
  parseWorktreeList,
  resolveDestination,
} from "./placement.ts";

const CUTOVER_REMINDER =
  "Cutover required: the main checkout had uncommitted changes when this worktree was created. This tool does not move or undo edits. Move only this task's changes into the new worktree, then undo only those in the main checkout — never `git clean`, `git restore .` or `git reset --hard`. If you cannot tell which changes are yours, stop and ask.";

interface ExecLike {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(pi: ExtensionAPI, args: string[]): Promise<ExecLike> {
  const result = await pi.exec("git", args);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function herdr(pi: ExtensionAPI, args: string[]): Promise<ExecLike> {
  const result = await pi.exec("herdr", args);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** Resolves the git top-level directory containing `cwd`. */
async function resolveRepository(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const result = await git(pi, ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  const path = result.stdout.trim();
  return path === "" ? null : path;
}

/** Keeps nested worktrees out of `git status` in the main checkout. */
function ensureExcluded(repoRoot: string): void {
  const excludeFile = join(repoRoot, ".git", "info", "exclude");
  const line = `/${WORKTREE_ROOT}/`;
  try {
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").some((entry) => entry.trim() === line)) return;
    mkdirSync(join(repoRoot, ".git", "info"), { recursive: true });
    appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`, "utf8");
  } catch {
    // Not fatal: the worktree still works, main just shows an untracked dir.
  }
}

/** True when a local branch ref already exists in the repository. */
async function branchExists(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<boolean> {
  const result = await git(pi, ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.code === 0;
}

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], details: {}, isError };
}

interface WorktreeParams {
  action: "create" | "list" | "remove";
  repository: string;
  branch?: string;
  baseRef?: string;
  path?: string;
  force?: boolean;
}

export default function worktreeKit(pi: ExtensionAPI): void {
  const agentDir = process.env["WORKTREE_KIT_STATE_DIR"] ?? getAgentDir();
  const incidents = new IncidentStore(agentDir);
  const pending = new Map<string, { repo: string; destination: string }>();
  const useHerdr = process.env["HERDR_ENV"] === "1";
  const backend = useHerdr ? "herdr" : "git";
  const z = pi.zod;

  async function create(repoRoot: string, params: WorktreeParams) {
    const branch = params.branch;
    if (!branch) return text("worktree: create requires a branch", true);
    try {
      assertUsableBranch(branch);
    } catch (error) {
      return text(`worktree: ${(error as Error).message}`, true);
    }

    const status = await git(pi, ["-C", repoRoot, "status", "--porcelain"]);
    const dirty = describeDirtyMain(status.stdout);
    const baseRef = params.baseRef ?? "HEAD";

    let location: string;
    if (useHerdr) {
      const created = await herdr(pi, buildHerdrCreateArgs(repoRoot, branch, baseRef));
      if (created.code !== 0) {
        return text(`worktree: herdr worktree create failed: ${created.stderr.trim() || created.stdout.trim()}`, true);
      }
      const path = findCreatedPath(created.stdout, branch);
      if (path === null) {
        return text("worktree: Herdr did not report the created worktree path", true);
      }
      location = path;
    } else {
      ensureExcluded(repoRoot);
      const exists = await branchExists(pi, repoRoot, branch);
      const created = await git(
        pi,
        buildAddArgs({ repoRoot, branch, baseRef, destination: resolveDestination(repoRoot, branch), branchExists: exists }),
      );
      if (created.code !== 0) {
        return text(`worktree: git worktree add failed: ${created.stderr.trim() || created.stdout.trim()}`, true);
      }
      location = resolveDestination(repoRoot, branch);
    }

    const lines = [`Backend: ${backend}`, `Created worktree: ${location}`, `Branch: ${branch} (from ${baseRef})`, `Repository: ${repoRoot}`];
    if (dirty) lines.push("", CUTOVER_REMINDER, `Main checkout was dirty: ${dirty}.`);
    return text(lines.join("\n"));
  }

  async function list(repoRoot: string) {
    if (useHerdr) {
      const result = await herdr(pi, buildHerdrListArgs(repoRoot));
      if (result.code !== 0) return text(`worktree: herdr worktree list failed: ${result.stderr.trim()}`, true);
      const worktrees = parseHerdrList(result.stdout).filter((entry) => !entry.isMain && !entry.isPrunable);
      if (worktrees.length === 0) return text(`Backend: ${backend}\nRepository: ${repoRoot}\nNo linked worktrees.`);
      const rows = worktrees.map((entry) => `- ${entry.path}${entry.branch ? ` [${entry.branch}]` : ""}`);
      return text([`Backend: ${backend}`, `Repository: ${repoRoot}`, "Linked worktrees:", ...rows].join("\n"));
    }

    const result = await git(pi, ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    if (result.code !== 0) return text(`worktree: git worktree list failed: ${result.stderr.trim()}`, true);
    const linked = linkedWorktrees(parseWorktreeList(result.stdout));
    if (linked.length === 0) return text(`Backend: ${backend}\nRepository: ${repoRoot}\nNo linked worktrees.`);
    const rows = linked.map((record) => `- ${record.path}${record.branch ? ` [${record.branch}]` : ""}`);
    return text([`Backend: ${backend}`, `Repository: ${repoRoot}`, "Linked worktrees:", ...rows].join("\n"));
  }

  async function remove(repoRoot: string, params: WorktreeParams) {
    const target = params.path;
    if (!target) return text("worktree: remove requires the path of a linked worktree", true);

    if (useHerdr) {
      const opened = await herdr(pi, buildHerdrOpenArgs(repoRoot, target));
      if (opened.code !== 0) return text(`worktree: herdr worktree open failed: ${opened.stderr.trim()}`, true);
      const workspace = findWorkspaceId(opened.stdout);
      if (workspace === null) return text("worktree: Herdr did not report a workspace for that path", true);
      if (isCurrentWorkspace(workspace)) {
        return text(
          `worktree: refusing to remove ${target}: workspace ${workspace} hosts this agent session, so removing it would close this pane and kill the agent. Remove it from another workspace.`,
          true,
        );
      }
      const removed = await herdr(pi, buildHerdrRemoveArgs(workspace, params.force === true));
      if (removed.code !== 0) {
        return text(`worktree: herdr worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`, true);
      }
      incidents.clear(repoRoot, target);
      return text(`Backend: ${backend}\nRemoved worktree: ${target}`);
    }

    const listing = await git(pi, ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    const linked = linkedWorktrees(parseWorktreeList(listing.stdout));
    if (!linked.some((record) => record.path === target)) {
      return text(`worktree: ${target} is not a linked worktree of ${repoRoot}. The main checkout cannot be removed.`, true);
    }
    const removed = await git(pi, ["-C", repoRoot, "worktree", "remove", ...(params.force ? ["--force"] : []), target]);
    if (removed.code !== 0) {
      return text(`worktree: git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim()}`, true);
    }
    incidents.clear(repoRoot, target);
    return text(`Backend: ${backend}\nRemoved worktree: ${target}`);
  }

  pi.registerTool({
    name: "worktree",
    label: "Worktree",
    description:
      "Create, list or remove durable git worktrees. Placement belongs to the active backend (Herdr when running inside Herdr, otherwise <repo>/.omp/worktrees): do not pass a destination path to create.",
    approval: "write",
    parameters: z.object({
      action: z.enum(["create", "list", "remove"]),
      repository: z.string().describe("Git top-level directory"),
      branch: z.string().optional().describe("Required for create"),
      baseRef: z.string().optional().describe("Commit-ish to branch from; defaults to HEAD"),
      path: z.string().optional().describe("Existing linked-worktree path, required for remove"),
      force: z.boolean().optional().describe("Pass --force when removing a dirty worktree"),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as WorktreeParams;
      const repoRoot = await resolveRepository(pi, params.repository);
      if (repoRoot === null) {
        return text(`worktree: ${params.repository} is not inside a git repository`, true);
      }
      if (params.action === "create") return create(repoRoot, params);
      if (params.action === "list") return list(repoRoot);
      return remove(repoRoot, params);
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as Record<string, unknown>)["command"];
    if (typeof command !== "string") return;

    const direct = parseDirectWorktreeCommand(command);
    if (direct === null) return;

    const repo = await resolveRepository(pi, ctx.cwd);
    if (repo === null) return;
    pending.set(event.toolCallId, { repo, destination: direct.destination });
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const entry = pending.get(event.toolCallId);
    if (!entry) return;
    pending.delete(event.toolCallId);
    if (event.isError) return;

    // Inside Herdr, placement is Herdr's business, so a path outside our directory
    // is not necessarily wrong. Only the git backend enforces the managed root.
    if (useHerdr) return;
    if (isManagedPath(entry.repo, entry.destination)) return;

    incidents.add(entry.repo, entry.destination);
    const reminder = [
      `worktree-kit: this worktree was created outside the managed root ${join(entry.repo, WORKTREE_ROOT)} (${entry.destination}).`,
      "Remove it with the `worktree` tool and create it again so the placement policy applies.",
    ].join(" ");
    return {
      content: [{ type: "text" as const, text: `${reminder}\n\n` }, ...event.content],
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const repo = await resolveRepository(pi, ctx.cwd);
    if (repo === null) return;
    const unresolved = incidents.list(repo);
    if (unresolved.length === 0) return;
    const lines = unresolved.map((incident) => `- ${incident.path} (created ${incident.at})`);
    pi.sendMessage(
      [
        `worktree-kit: ${unresolved.length} worktree(s) in ${repo} were created outside ${WORKTREE_ROOT}:`,
        ...lines,
        "Recreate them through the `worktree` tool to bring them under the placement policy.",
      ].join("\n"),
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_shutdown", () => {
    pending.clear();
  });
}
