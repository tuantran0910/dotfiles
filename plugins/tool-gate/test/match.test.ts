import { describe, expect, it } from "bun:test";

import { extractPaths, globToRegExp, matchesAnyPath, matchesTool, resolveTarget } from "../src/match.ts";

describe("globToRegExp", () => {
  it("makes ** span separators and * not", () => {
    const deep = globToRegExp("/a/**/x.ts");
    expect(deep.test("/a/x.ts")).toBe(true);
    expect(deep.test("/a/b/c/x.ts")).toBe(true);

    const shallow = globToRegExp("/a/*/x.ts");
    expect(shallow.test("/a/b/x.ts")).toBe(true);
    expect(shallow.test("/a/b/c/x.ts")).toBe(false);
  });

  it("matches dotfiles literally", () => {
    const pattern = globToRegExp("**/.env");
    expect(pattern.test("/repo/.env")).toBe(true);
    expect(pattern.test("/repo/.env.local")).toBe(false);
    expect(pattern.test("/repo/sub/.env")).toBe(true);
  });

  it("supports ? for one character", () => {
    expect(globToRegExp("/a/b?.ts").test("/a/b1.ts")).toBe(true);
    expect(globToRegExp("/a/b?.ts").test("/a/b12.ts")).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("expands ~ and resolves relative paths", () => {
    expect(resolveTarget("~/.ssh/id_rsa", "/work", "/home/me")).toBe("/home/me/.ssh/id_rsa");
    expect(resolveTarget("~", "/work", "/home/me")).toBe("/home/me");
    expect(resolveTarget("src/a.ts", "/work/repo", "/home/me")).toBe("/work/repo/src/a.ts");
  });
});

describe("matchesTool", () => {
  it("treats a missing or * pattern as every tool", () => {
    expect(matchesTool(undefined, "bash")).toBe(true);
    expect(matchesTool("", "bash")).toBe(true);
    expect(matchesTool("*", "bash")).toBe(true);
  });

  it("supports alternation through the pipe glob used by the defaults", () => {
    expect(matchesTool("read|write|edit", "write")).toBe(true);
    expect(matchesTool("read|write|edit", "bash")).toBe(false);
  });
});

describe("extractPaths", () => {
  it("reads path and paths", () => {
    expect(extractPaths({ path: "/a" })).toEqual(["/a"]);
    expect(extractPaths({ paths: ["/a", "/b"] })).toEqual(["/a", "/b"]);
    expect(extractPaths({ command: "ls" })).toEqual([]);
  });
});

describe("matchesAnyPath", () => {
  it("returns the resolved path that matched", () => {
    expect(matchesAnyPath(["**/.env"], [".env"], "/repo", "/home/me")).toBe("/repo/.env");
    expect(matchesAnyPath(["~/.ssh/**"], ["~/.ssh/id_rsa"], "/repo", "/home/me")).toBe("/home/me/.ssh/id_rsa");
  });

  it("does not match unrelated paths", () => {
    expect(matchesAnyPath(["~/.ssh/**"], ["/repo/.ssh-notes.md"], "/repo", "/home/me")).toBeNull();
  });
});
