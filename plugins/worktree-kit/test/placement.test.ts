import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IncidentStore } from "../src/incidents.ts";
import {
  assertUsableBranch,
  branchSlug,
  buildAddArgs,
  describeDirtyMain,
  isManagedPath,
  linkedWorktrees,
  parseDirectWorktreeCommand,
  parseWorktreeList,
  resolveDestination,
} from "../src/placement.ts";

const REPO = "/Users/me/repo";

describe("branch placement", () => {
  it("flattens slashes into one directory name", () => {
    expect(branchSlug("feat/parser")).toBe("feat-parser");
    expect(branchSlug("fix/issue 42")).toBe("fix-issue-42");
  });

  it("rejects branch names with no usable characters", () => {
    expect(() => branchSlug("///")).toThrow();
  });

  it("always places worktrees under the repository", () => {
    expect(resolveDestination(REPO, "feat/x")).toBe(`${REPO}/.omp/worktrees/feat-x`);
    expect(resolveDestination(`${REPO}/`, "x")).toBe(`${REPO}/.omp/worktrees/x`);
  });

  it("recognises managed and foreign paths", () => {
    expect(isManagedPath(REPO, `${REPO}/.omp/worktrees/a`)).toBe(true);
    expect(isManagedPath(REPO, `${REPO}/../sibling`)).toBe(false);
    expect(isManagedPath(REPO, `${REPO}/.omp/worktrees-evil/a`)).toBe(false);
  });

  it("protects the default branches", () => {
    for (const name of ["main", "master", "HEAD"]) {
      expect(() => assertUsableBranch(name)).toThrow();
    }
    expect(() => assertUsableBranch("--force")).toThrow();
    expect(() => assertUsableBranch("two words")).toThrow();
    expect(() => assertUsableBranch("feat/ok")).not.toThrow();
  });
});

describe("buildAddArgs", () => {
  it("creates a branch from the base ref", () => {
    const args = buildAddArgs({
      repoRoot: REPO,
      branch: "feat/x",
      baseRef: "origin/main",
      destination: "/d",
      branchExists: false,
    });
    expect(args).toEqual(["-C", REPO, "worktree", "add", "-b", "feat/x", "/d", "origin/main"]);
  });

  it("checks out an existing branch without -b", () => {
    const args = buildAddArgs({
      repoRoot: REPO,
      branch: "feat/x",
      baseRef: "HEAD",
      destination: "/d",
      branchExists: true,
    });
    expect(args).toEqual(["-C", REPO, "worktree", "add", "/d", "feat/x"]);
  });
});

describe("parseWorktreeList", () => {
  const output = [
    "worktree /repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.omp/worktrees/feat-x",
    "HEAD bbb",
    "branch refs/heads/feat/x",
    "",
    "worktree /repo/detached",
    "HEAD ccc",
    "detached",
    "",
    "worktree /repo/stale",
    "HEAD ddd",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");

  it("parses every block", () => {
    const records = parseWorktreeList(output);
    expect(records).toHaveLength(4);
    expect(records[0]?.path).toBe("/repo");
    expect(records[1]?.branch).toBe("feat/x");
    expect(records[2]?.detached).toBe(true);
    expect(records[3]?.prunable).toBe(true);
  });

  it("treats the first record as main and hides prunable entries", () => {
    const linked = linkedWorktrees(parseWorktreeList(output));
    expect(linked.map((record) => record.path)).toEqual([
      "/repo/.omp/worktrees/feat-x",
      "/repo/detached",
    ]);
  });
});

describe("parseDirectWorktreeCommand", () => {
  it("detects an absolute destination", () => {
    expect(parseDirectWorktreeCommand("git worktree add /tmp/wt feat/x")).toEqual({
      action: "add",
      destination: "/tmp/wt",
    });
  });

  it("skips the value of -b", () => {
    expect(parseDirectWorktreeCommand("git worktree add -b feat/x /tmp/wt origin/main")).toEqual({
      action: "add",
      destination: "/tmp/wt",
    });
  });

  it("detects move", () => {
    expect(parseDirectWorktreeCommand("git worktree move /tmp/a /tmp/b")).toEqual({
      action: "move",
      destination: "/tmp/b",
    });
  });

  it("ignores relative destinations and unrelated commands", () => {
    expect(parseDirectWorktreeCommand("git worktree add ./wt feat/x")).toBeNull();
    expect(parseDirectWorktreeCommand("git worktree list")).toBeNull();
    expect(parseDirectWorktreeCommand("git status")).toBeNull();
    expect(parseDirectWorktreeCommand("echo worktree add /tmp/wt")).toBeNull();
  });
});

describe("describeDirtyMain", () => {
  it("returns null for a clean checkout", () => {
    expect(describeDirtyMain("")).toBeNull();
  });

  it("counts staged, modified and untracked paths", () => {
    const status = ["M  staged.ts", " M modified.ts", "?? new.ts"].join("\n");
    expect(describeDirtyMain(status)).toBe("3 path(s): 1 staged, 1 modified, 1 untracked");
  });
});

describe("IncidentStore", () => {
  it("records each path once, lists it, then clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-kit-"));
    const store = new IncidentStore(dir);

    store.add("/repo", "/tmp/wt");
    store.add("/repo", "/tmp/wt");
    expect(store.list("/repo")).toHaveLength(1);
    expect(store.list("/other")).toHaveLength(0);

    store.clear("/repo", "/tmp/wt");
    expect(store.list("/repo")).toHaveLength(0);
  });

  it("survives a corrupt store file", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-kit-"));
    Bun.write(join(dir, "worktree-kit-incidents.json"), "{not json");
    expect(new IncidentStore(dir).list("/repo")).toEqual([]);
  });
});
