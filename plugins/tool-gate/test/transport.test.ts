import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildClassifierPrompt, completeSimpleCandidates, createClassifier, loadCompleteSimple, MAX_CLASSIFIER_ARGS, type ClassifierRuntime } from "../src/classifier.ts";
import { DEFAULT_CLASSIFIER } from "../src/config.ts";
import { parseVerdict } from "../src/verdict.ts";
import { gateHarness } from "./harness.ts";

const call = { tool: "bash", input: { command: "touch output" }, cwd: "/work", home: "/home/test" };
const answer = (decision = "allow") => ({ stopReason: "toolUse", content: [{ type: "toolCall", name: "verdict", arguments: { decision, reason: "synthetic verdict" } }] });
const config = { ...DEFAULT_CLASSIFIER, enabled: true, timeoutMs: 30 };
function transport(overrides: Partial<ClassifierRuntime> = {}, contextOverrides: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const pi = { logger: { warn: (text: string) => warnings.push(text), info() {} } } as unknown as ExtensionAPI;
  const context = { models: { resolve: () => ({ id: "test-judge" }), current: () => ({ id: "wrong-model" }) }, modelRegistry: { getApiKey: async () => "synthetic-test-key" }, ...contextOverrides };
  const runtime: ClassifierRuntime = { loadComplete: async () => async () => answer(), subprocess: async () => answer(), ...overrides };
  return { classify: createClassifier(pi, context, config, runtime), warnings };
}

describe("classifier transport contract", () => {
  it("loads the installed pi-ai completion function without making a model request", async () => {
    expect(typeof await loadCompleteSimple()).toBe("function");
  });
  it("forces the verdict schema and passes only the pending call and user intent", async () => {
    let options: any;
    let context: any;
    const { classify } = transport({ loadComplete: async () => async (_model, nextContext, nextOptions) => {
      context = nextContext; options = nextOptions; return answer();
    } });
    expect((await classify(call, ["create output"]))?.action).toBe("allow");
    expect(options.toolChoice).toEqual({ type: "tool", name: "verdict" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    expect(context.tools[0].parameters.additionalProperties).toBe(false);
    expect(context.messages[0].content).toContain("create output");
  });
  it("falls back to the subprocess after an in-process failure", async () => {
    let spawned = 0;
    const { classify } = transport({ loadComplete: async () => async () => { throw new Error("loader error"); }, subprocess: async () => { spawned++; return answer("deny"); } });
    expect((await classify(call, []))?.action).toBe("deny");
    expect(spawned).toBe(1);
  });
  it("uses the subprocess when the loader is unavailable", async () => {
    const { classify } = transport({ loadComplete: async () => null, subprocess: async () => answer("prompt") });
    expect((await classify(call, []))?.action).toBe("prompt");
  });
  it("fails closed on subprocess errors", async () => {
    const { classify } = transport({ loadComplete: async () => null, subprocess: async () => { throw new Error("child exited"); } });
    expect(await classify(call, [])).toBeNull();
  });
  it("does not silently use the main model when the judge alias is unresolved", async () => {
    const { classify } = transport({}, { models: { resolve: () => undefined, current: () => ({ id: "wrong-model" }) } });
    expect(await classify(call, [])).toBeNull();
  });
  it("handles credential resolution failures without leaking the error", async () => {
    const { classify, warnings } = transport({}, { modelRegistry: { getApiKey: async () => { throw new Error("synthetic-sensitive-detail"); } } });
    expect(await classify(call, [])).toBeNull();
    expect(warnings.join(" ")).not.toContain("synthetic-sensitive-detail");
  });
  for (const phase of ["credentials", "loader", "completion", "subprocess"] as const) {
    it(`one deadline bounds a hung ${phase}`, async () => {
      const never = () => new Promise<never>(() => {});
      let signal: AbortSignal | undefined;
      const { classify } = transport({
        loadComplete: phase === "loader" ? never : phase === "subprocess" ? async () => null : async () => async (_m, _c, options: any) => { signal = options.signal; return phase === "completion" ? never() : answer(); },
        subprocess: async (_payload, nextSignal) => { signal = nextSignal; return phase === "subprocess" ? never() : answer(); },
      }, phase === "credentials" ? { modelRegistry: { getApiKey: never } } : {});
      const start = performance.now();
      expect(await classify(call, [])).toBeNull();
      expect(performance.now() - start).toBeLessThan(1000);
      if (signal) expect(signal.aborted).toBe(true);
    });
  }
  it("an aborted parent never starts a completion", async () => {
    let completions = 0;
    const { classify } = transport({ loadComplete: async () => async () => { completions++; return answer(); } });
    const controller = new AbortController();
    controller.abort();
    expect(await classify(call, [], controller.signal)).toBeNull();
    expect(completions).toBe(0);
  });
  it("never probes the current project for a classifier module", () => {
    const h = gateHarness();
    const previous = process.cwd();
    try {
      process.chdir(h.cwd);
      expect(completeSimpleCandidates()).not.toContain(`${h.cwd}/node_modules/@oh-my-pi/pi-ai/src/stream.ts`);
    } finally { process.chdir(previous); }
  });
});

describe("strict verdict schema", () => {
  for (const stopReason of ["error", "aborted", "length"]) {
    it(`rejects a verdict on ${stopReason}`, () => expect(parseVerdict({ ...answer(), stopReason })).toBeNull());
  }
  it("rejects multiple, contradictory verdicts", () => {
    expect(parseVerdict({ content: [...answer().content, ...answer("deny").content] })).toBeNull();
  });
  for (const args of [
    { action: "allow", reason: "alias" }, { decision: "allow" }, { decision: "allow", reason: "" },
    { decision: "allow", reason: "test", unexpected: true }, { decision: "maybe", reason: "test" },
  ]) {
    it(`rejects out-of-schema arguments ${JSON.stringify(args)}`, () => {
      expect(parseVerdict({ content: [{ type: "toolCall", name: "verdict", arguments: args }] })).toBeNull();
    });
  }
});

describe("complete classifier context", () => {
  it("includes a dangerous tail after the old 2000-character clipping point", () => {
    const command = `echo ${"a".repeat(2100)}; touch /outside/the/task`;
    expect(buildClassifierPrompt({ ...call, input: { command } }, []).user).toContain("touch /outside/the/task");
  });
  it("requires manual review instead of classifying a clipped call", () => {
    expect(() => buildClassifierPrompt({ ...call, input: { command: "x".repeat(MAX_CLASSIFIER_ARGS + 1) } }, [])).toThrow("review limit");
  });
  it("retains the tail of user instructions and canonical file targets", () => {
    const { user } = buildClassifierPrompt({ ...call, resolvedPaths: ["/outside/file"] }, [`${"a".repeat(500)} DO NOT DEPLOY`]);
    expect(user).toContain("DO NOT DEPLOY");
    expect(user).toContain("/outside/file");
  });
});
