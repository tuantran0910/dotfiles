import { describe, expect, it } from "bun:test";

import { buildClassifierPrompt, recentInstructions } from "../src/classifier.ts";
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

  it("rejects allow without the required reason", () => {
    const message = { content: [{ type: "toolCall", name: "verdict", arguments: { decision: "allow" } }] };
    expect(parseVerdict(message)).toBeNull();
  });

  it("does not accept free-text JSON as consent", () => {
    const message = { content: [{ type: "text", text: 'Verdict: {"verdict":"prompt","reason":"needs a human"}' }] };
    expect(parseVerdict(message)).toBeNull();
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

  it("keeps the full call rather than hiding its tail", () => {
    const huge = { command: `echo ${"a".repeat(5000)}` };
    const { user } = buildClassifierPrompt({ ...call, input: huge }, []);
    expect(user).toContain(huge.command);
    expect(user).not.toContain("chars elided");
  });
});

describe("recentInstructions", () => {
  const branch = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
    { type: "model_usage", purpose: "turn" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", message: { role: "user", content: "second ask" } },
  ];

  it("returns the last user messages, oldest first", () => {
    expect(recentInstructions({ getBranch: () => branch })).toEqual(["first ask", "second ask"]);
  });

  it("respects the limit and ignores non-text blocks", () => {
    const mixed = [{ type: "message", message: { role: "user", content: [{ type: "image" }] } }, ...branch];
    expect(recentInstructions({ getBranch: () => mixed }, 1)).toEqual(["second ask"]);
  });

  it("is quiet for a missing or broken manager", () => {
    expect(recentInstructions(undefined)).toEqual([]);
    expect(recentInstructions({})).toEqual([]);
    expect(recentInstructions({ getBranch: () => "nope" })).toEqual([]);
  });
});
