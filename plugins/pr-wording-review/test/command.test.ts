import { describe, expect, it } from "bun:test";

import { bodyFilePaths, prWriteIndex, tokenize, usesFillFlag } from "../src/command.ts";

describe("tokenize", () => {
  it("keeps quoted paths together", () => {
    expect(tokenize(`gh pr create --body-file "my notes.md" --draft`)).toEqual([
      "gh",
      "pr",
      "create",
      "--body-file",
      "my notes.md",
      "--draft",
    ]);
  });

  it("handles single quotes and escaped quotes", () => {
    expect(tokenize(`a 'b c' "d \\"e\\""`)).toEqual(["a", "b c", 'd "e"']);
  });
});

describe("prWriteIndex", () => {
  it("finds gh pr create and gh pr edit", () => {
    expect(prWriteIndex(tokenize("gh pr create --fill"))).toBe(2);
    expect(prWriteIndex(tokenize("gh pr edit 12 --title x"))).toBe(2);
  });

  it("ignores reads, other verbs and unrelated commands", () => {
    expect(prWriteIndex(tokenize("gh pr view 12"))).toBe(-1);
    expect(prWriteIndex(tokenize("git commit -m x"))).toBe(-1);
    expect(prWriteIndex(tokenize("echo gh pr create"))).toBe(3);
  });
});

describe("bodyFilePaths", () => {
  it("reads the long flag, the short flag and the equals form", () => {
    expect(bodyFilePaths("gh pr create --body-file notes.md")).toEqual(["notes.md"]);
    expect(bodyFilePaths("gh pr create -F notes.md")).toEqual(["notes.md"]);
    expect(bodyFilePaths("gh pr edit 3 --body-file=notes.md")).toEqual(["notes.md"]);
  });

  it("handles quoted paths and multiple files", () => {
    expect(bodyFilePaths(`gh pr create --body-file "a b.md" -F c.md`)).toEqual(["a b.md", "c.md"]);
  });

  it("ignores inline bodies, stdin and non-PR commands", () => {
    expect(bodyFilePaths(`gh pr create -f "why: inline body"`)).toEqual([]);
    expect(bodyFilePaths("gh pr create -F -")).toEqual([]);
    expect(bodyFilePaths("gh pr view 1 --body-file x.md")).toEqual([]);
  });

  it("is not confused by a path inside a later argument", () => {
    expect(bodyFilePaths("gh pr create --title 'add --body-file' --body-file real.md")).toEqual(["real.md"]);
  });
});

describe("usesFillFlag", () => {
  it("detects fill, which takes the body from commits", () => {
    expect(usesFillFlag("gh pr create --fill")).toBe(true);
    expect(usesFillFlag("gh pr create --fill-first --draft")).toBe(true);
    expect(usesFillFlag("gh pr create --body-file x.md")).toBe(false);
  });
});
