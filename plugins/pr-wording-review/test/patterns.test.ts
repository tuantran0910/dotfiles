import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileConditions, extractConditions, firstMatch } from "../src/patterns.ts";

const MCP_RULES = fileURLToPath(new URL("../rules/pr-wording-review.md", import.meta.url));
const BASH_RULES = fileURLToPath(new URL("../rules/pr-wording-review-bash.md", import.meta.url));

describe("extractConditions", () => {
  it("reads every pattern from the tool-scope rule file", () => {
    const conditions = extractConditions(readFileSync(MCP_RULES, "utf8"));
    expect(conditions.length).toBeGreaterThanOrEqual(40);
    expect(conditions.every((condition) => condition.startsWith("(?i)"))).toBe(true);
  });

  it("reads the bash rules too, including their gh guard", () => {
    const conditions = extractConditions(readFileSync(BASH_RULES, "utf8"));
    expect(conditions.length).toBeGreaterThanOrEqual(9);
    expect(conditions.some((condition) => condition.includes("gh\\s+pr\\s+(?:create|edit)"))).toBe(true);
  });

  it("ignores comments, scope and body text", () => {
    const conditions = extractConditions(["---", "condition:", "  # note", "  - '(?i)foo'", "scope: \"bash\"", "---", "body"].join("\n"));
    expect(conditions).toEqual(["(?i)foo"]);
  });

  it("unescapes doubled single quotes", () => {
    expect(extractConditions("  - '(?i)it''s'")).toEqual(["(?i)it's"]);
  });
});

describe("compileConditions", () => {
  it("turns inline (?i) into a real ignore-case flag", () => {
    const [pattern] = compileConditions(["(?i)\\bseamless\\b"]);
    expect(pattern?.test("A SEAMLESS change")).toBe(true);
    expect(pattern?.test("unseamlessly")).toBe(false);
  });

  it("skips patterns the JS engine rejects instead of throwing", () => {
    const compiled = compileConditions(["(?i)[unclosed", "(?i)ok"]);
    expect(compiled).toHaveLength(1);
  });
});

describe("firstMatch against real rule patterns", () => {
  const patterns = compileConditions(extractConditions(readFileSync(MCP_RULES, "utf8")));

  it("flags the usual tells", () => {
    for (const text of [
      "This is a seamless improvement",
      "It is worth noting that the API changed",
      "We leverage caching in order to reduce latency",
      "A world-class change — shipped today",
      "This is not just faster but smaller",
    ]) {
      expect(firstMatch(patterns, text)).not.toBeNull();
    }
  });

  it("passes measured technical prose", () => {
    for (const text of [
      "Fixes a race in the worktree cache by holding the lock across rename(2).",
      "Adds a `--dry-run` flag; prints the planned symlinks without touching disk.",
      "The vector store now batches writes within one transaction.",
    ]) {
      expect(firstMatch(patterns, text)).toBeNull();
    }
  });
});
