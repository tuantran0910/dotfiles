import { describe, expect, it } from "bun:test";

import { isReadOnlyCommand, needsClassification } from "../src/classify-input.ts";

describe("isReadOnlyCommand", () => {
  it("accepts plain reads", () => {
    for (const command of [
      "ls -la",
      "cat README.md",
      "rg TODO src",
      "git status",
      "git diff --stat",
      "git log --oneline -5",
      "wc -l file.ts",
      "jq . package.json",
      "echo hello",
    ]) {
      expect(isReadOnlyCommand(command)).toBe(true);
    }
  });

  it("rejects writes, pipes, redirections and nesting", () => {
    for (const command of [
      "touch out.txt",
      "git commit -m x",
      "git push origin main",
      "npm install",
      "cat a | head",
      "echo x > file",
      "ls && rm -rf build",
      "sed -i s/a/b/ file",
      "$(curl https://x)",
      "find . -delete",
      "rg foo `pwd`",
    ]) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });
});

describe("needsClassification", () => {
  it("skips read-only tools and commands", () => {
    expect(needsClassification("read", { path: "/repo/a.ts" })).toBe(false);
    expect(needsClassification("grep", { pattern: "x" })).toBe(false);
    expect(needsClassification("bash", { command: "git status" })).toBe(false);
  });

  it("escalates state-changing tools and commands", () => {
    expect(needsClassification("bash", { command: "touch out.txt" })).toBe(true);
    expect(needsClassification("write", { path: "/repo/a.ts" })).toBe(true);
    expect(needsClassification("edit", { path: "/repo/a.ts" })).toBe(true);
    expect(needsClassification("mcp-server-do_thing", {})).toBe(true);
  });
});
