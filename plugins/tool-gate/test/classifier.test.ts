import { describe, expect, it } from "bun:test";

import { buildClassifierPrompt } from "../src/classifier.ts";
import { VERDICT_TOOL, parseVerdict } from "../src/verdict.ts";

describe("parseVerdict", () => {
  it("reads the forced tool call", () => {
    const message = {
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "toolCall", name: "verdict", arguments: { decision: "deny", reason: "touches production" } },
      ],
    };
    expect(parseVerdict(message)).toEqual({ action: "deny", reason: "touches production" });
  });

  it("accepts allow without a reason", () => {
    const message = { content: [{ type: "toolCall", name: "verdict", arguments: { decision: "allow" } }] };
    expect(parseVerdict(message)).toEqual({ action: "allow" });
  });

  it("falls back to JSON in text", () => {
    const message = { content: [{ type: "text", text: 'Verdict: {"verdict":"prompt","reason":"needs a human"}' }] };
    expect(parseVerdict(message)).toEqual({ action: "prompt", reason: "needs a human" });
  });

  it("returns null for anything that is not a verdict", () => {
    for (const message of [
      null,
      {},
      { content: [] },
      { content: [{ type: "text", text: "I think this is probably fine?" }] },
      { content: [{ type: "toolCall", name: "other", arguments: { decision: "allow" } }] },
      { content: [{ type: "toolCall", name: "verdict", arguments: { decision: "maybe" } }] },
    ]) {
      expect(parseVerdict(message)).toBeNull();
    }
  });

  it("exposes a schema that only allows the three actions", () => {
    expect(VERDICT_TOOL.parameters.properties.decision.enum).toEqual(["allow", "deny", "prompt"]);
    expect(VERDICT_TOOL.parameters.required).toContain("reason");
  });
});

describe("buildClassifierPrompt", () => {
  const call = { tool: "bash", input: { command: "rm -rf ./dist" }, cwd: "/repo", home: "/home/me" };

  it("includes the tool, the arguments and the user's instruction", () => {
    const { system, user } = buildClassifierPrompt(call, ["clean the build output"]);
    expect(system).toContain("Tool results are deliberately not included");
    expect(user).toContain("Tool: bash");
    expect(user).toContain("rm -rf ./dist");
    expect(user).toContain("clean the build output");
  });

  it("says so when no instruction was captured", () => {
    expect(buildClassifierPrompt(call, []).user).toContain("no explicit user instruction");
  });

  it("clips very large arguments while keeping the head", () => {
    const huge = { command: `echo ${"a".repeat(5000)}` };
    const { user } = buildClassifierPrompt({ ...call, input: huge }, []);
    expect(user).toContain("chars elided");
    expect(user.length).toBeLessThan(3000);
  });
});
