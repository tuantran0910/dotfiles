import { describe, expect, it } from "bun:test";

import {
  buildCreateArgs,
  buildListArgs,
  buildOpenArgs,
  buildRemoveArgs,
  findCreatedPath,
  findWorkspaceId,
  isCurrentWorkspace,
  parseHerdrList,
} from "../src/herdr.ts";

describe("herdr arguments", () => {
  it("creates without taking focus and without choosing a path", () => {
    expect(buildCreateArgs("/repo", "feat/x", "HEAD")).toEqual([
      "worktree", "create", "--cwd", "/repo", "--branch", "feat/x", "--base", "HEAD", "--no-focus",
    ]);
  });

  it("lists and opens by cwd/path", () => {
    expect(buildListArgs("/repo")).toEqual(["worktree", "list", "--cwd", "/repo"]);
    expect(buildOpenArgs("/repo", "/wt/a")).toEqual([
      "worktree", "open", "--cwd", "/repo", "--path", "/wt/a", "--no-focus",
    ]);
  });

  it("removes by workspace id and only passes --force when asked", () => {
    expect(buildRemoveArgs("ws-1", false)).toEqual(["worktree", "remove", "--workspace", "ws-1"]);
    expect(buildRemoveArgs("ws-1", true)).toEqual(["worktree", "remove", "--workspace", "ws-1", "--force"]);
  });
});

describe("findCreatedPath", () => {
  it("prefers the path matching the branch slug", () => {
    const output = JSON.stringify({
      result: {
        workspace_id: "ws-9",
        cwd: "/repo",
        worktrees: [{ path: "/herdr/other" }, { path: "/herdr/feat-x" }],
      },
    });
    expect(findCreatedPath(output, "feat/x")).toBe("/herdr/feat-x");
  });

  it("falls back to the first absolute path", () => {
    expect(findCreatedPath(JSON.stringify({ result: { path: "/herdr/whatever" } }), "feat/x")).toBe("/herdr/whatever");
  });

  it("returns null for invalid JSON", () => {
    expect(findCreatedPath("not json", "feat/x")).toBeNull();
  });
});

describe("findWorkspaceId", () => {
  it("finds snake_case and camelCase ids at any depth", () => {
    expect(findWorkspaceId(JSON.stringify({ result: { workspace_id: "ws-1" } }))).toBe("ws-1");
    expect(findWorkspaceId(JSON.stringify({ result: { workspace: { workspaceId: "ws-2" } } }))).toBe("ws-2");
  });

  it("returns null when absent", () => {
    expect(findWorkspaceId(JSON.stringify({ result: {} }))).toBeNull();
    expect(findWorkspaceId("no json")).toBeNull();
  });
});

describe("parseHerdrList", () => {
  const output = JSON.stringify({
    result: {
      worktrees: [
        { path: "/repo", branch: "main" },
        { path: "/herdr/feat-x", branch: "feat/x", is_linked_worktree: true },
        { path: "/herdr/stale", is_linked_worktree: true, is_prunable: true },
      ],
    },
  });

  it("marks non-linked entries as main and keeps prunable ones flagged", () => {
    const worktrees = parseHerdrList(output);
    expect(worktrees).toHaveLength(3);
    expect(worktrees[0]?.isMain).toBe(true);
    expect(worktrees[1]).toMatchObject({ path: "/herdr/feat-x", branch: "feat/x", isMain: false, isPrunable: false });
    expect(worktrees[2]?.isPrunable).toBe(true);
  });

  it("accepts a top-level worktrees array", () => {
    expect(parseHerdrList(JSON.stringify({ worktrees: [{ path: "/a", is_linked_worktree: true }] }))).toHaveLength(1);
  });

  it("returns empty for malformed payloads", () => {
    expect(parseHerdrList("{}")).toEqual([]);
    expect(parseHerdrList("nope")).toEqual([]);
  });
});

describe("isCurrentWorkspace", () => {
  it("refuses only the workspace hosting this session", () => {
    expect(isCurrentWorkspace("ws-1", "ws-1")).toBe(true);
    expect(isCurrentWorkspace("ws-2", "ws-1")).toBe(false);
    expect(isCurrentWorkspace("ws-2", undefined)).toBe(false);
  });
});
