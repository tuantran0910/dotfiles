import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import toolGate from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<{ block?: boolean; reason?: string } | undefined>;

interface Harness {
  handlers: Handler[];
  input?: (event: any) => Promise<unknown> | unknown;
  command: { handler: (args: string, ctx: any) => Promise<void> };
  notices: string[];
}

function harness(opts: {
  approve?: (prompt: any) => Promise<any>;
  classify?: (call: any, intent: readonly string[]) => Promise<any>;
  config?: unknown;
} = {}): Harness {
  if (opts.config !== undefined) {
    writeFileSync(join(stateDir, "tool-gate.json"), JSON.stringify(opts.config));
  }
  const handlers: Handler[] = [];
  const inputHandlers: Handler[] = [];
  const notices: string[] = [];
  let command: any;

  const pi = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    registerCommand: (_name: string, definition: any) => {
      command = definition;
    },
    on: (event: string, handler: Handler) => {
      if (event === "tool_call") handlers.push(handler);
      if (event === "input") inputHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;

  toolGate(pi, opts.classify ? { classify: opts.classify as any } : {});
  return { handlers, input: inputHandlers[0], command, notices } as Harness;
}

let stateDir: string;
let cwd: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tool-gate-state-"));
  cwd = mkdtempSync(join(tmpdir(), "tool-gate-work-"));
  process.env["TOOL_GATE_STATE_DIR"] = stateDir;
});

async function runTool(h: Harness, tool: string, input: Record<string, unknown>, options: { approve?: (p: any) => Promise<any> } = {}) {
  const ui: any = { notify: (message: string) => h.notices.push(message) };
  if (options.approve) ui.approve = options.approve;
  return h.handlers[0]!({ toolName: tool, toolCallId: "1", input }, { cwd, ui, mode: "tui" });
}

async function run(h: Harness, command: string, options: { approve?: (p: any) => Promise<any> } = {}) {
  const ui: any = { notify: (message: string) => h.notices.push(message) };
  if (options.approve) ui.approve = options.approve;
  return h.handlers[0]!({ toolName: "bash", toolCallId: "1", input: { command } }, { cwd, ui, mode: "tui" });
}

describe("enforcement", () => {
  it("blocks a destructive command with the rule id", async () => {
    const h = harness();
    const decision = await run(h, "rm -rf /");
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("rm-root");
  });

  it("lets ordinary commands through", async () => {
    const h = harness();
    expect(await run(h, "git status")).toBeUndefined();
  });

  it("writes an audit line for every decision", async () => {
    const h = harness();
    await run(h, "git status");
    await run(h, "rm -rf /");
    const lines = readFileSync(join(stateDir, "tool-gate.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ tool: "bash", decision: "deny", ruleId: "rm-root" });
  });

  it("observe mode allows but records what it would have done", async () => {
    const h = harness();
    await h.command.handler("mode observe", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });

    expect(await run(h, "rm -rf /")).toBeUndefined();
    const record = JSON.parse(readFileSync(join(stateDir, "tool-gate.log"), "utf8").trim());
    expect(record).toMatchObject({ decision: "allow", wouldBe: "deny", ruleId: "rm-root" });
  });

  it("off mode allows and logs the bypass", async () => {
    const h = harness();
    await h.command.handler("mode off", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });
    expect(await run(h, "rm -rf /")).toBeUndefined();
    const record = JSON.parse(readFileSync(join(stateDir, "tool-gate.log"), "utf8").trim());
    expect(record.ruleId).toBe("mode:off");
  });
});

describe("prompt rules", () => {
  it("blocks when the session has no UI to ask", async () => {
    const h = harness();
    const decision = await run(h, "sudo ls");
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("no UI");
  });

  it("allows once when the user approves", async () => {
    const h = harness();
    const decision = await run(h, "sudo ls", { approve: async () => "once" });
    expect(decision).toBeUndefined();
  });

  it("blocks when the user denies", async () => {
    const h = harness();
    const decision = await run(h, "sudo ls", { approve: async () => "deny" });
    expect(decision?.block).toBe(true);
  });

  it("remembers a session approval", async () => {
    const h = harness();
    expect(await run(h, "sudo ls", { approve: async () => "session" })).toBeUndefined();
    expect(await run(h, "sudo ls")).toBeUndefined();
  });

  it("shows the rule and the reason in the prompt", async () => {
    const h = harness();
    let seen: any;
    await run(h, "npm publish", {
      approve: async (prompt) => {
        seen = prompt;
        return "deny";
      },
    });
    expect(seen.full).toContain("package-publish");
    expect(seen.session).toContain("package-publish");
  });
});

describe("/tool-gate command", () => {
  it("reports status with rule count and audit path", async () => {
    const h = harness();
    await h.command.handler("", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });
    expect(h.notices[0]).toContain("enforce");
    expect(h.notices[0]).toContain("tool-gate.log");
  });

  it("grants a rule for the session", async () => {
    const h = harness();
    await h.command.handler("allow rm-root", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });
    expect(await run(h, "rm -rf /")).toBeUndefined();
  });

  it("rejects an unknown rule", async () => {
    const h = harness();
    await h.command.handler("allow nope", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });
    expect(h.notices[0]).toContain("unknown rule");
  });

  it("rejects an invalid mode", async () => {
    const h = harness();
    await h.command.handler("mode sometimes", { cwd, ui: { notify: (m: string) => h.notices.push(m) } });
    expect(h.notices[0]).toContain("usage");
  });
});

describe("classifier escalation", () => {
  const enabled = { classifier: { enabled: true, model: "@smol", timeoutMs: 1000, maxPerSession: 10, onError: "deny" } };

  function recorder(verdict: any) {
    const calls: any[] = [];
    const classify = async (call: any, intent: readonly string[]) => {
      calls.push({ call, intent });
      return verdict;
    };
    return { classify, calls };
  }

  it("denies an unmatched write when the classifier says deny", async () => {
    const { classify, calls } = recorder({ action: "deny", reason: "writes outside the task" });
    const h = harness({ classify, config: enabled });

    const decision = await run(h, "touch /tmp/unrelated");
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("classifier");
    expect(calls).toHaveLength(1);

    const record = JSON.parse(readFileSync(join(stateDir, "tool-gate.log"), "utf8").trim());
    expect(record).toMatchObject({ decision: "deny", ruleId: "classifier", source: "classifier" });
  });

  it("allows when the classifier allows", async () => {
    const { classify } = recorder({ action: "allow", reason: "build output" });
    const h = harness({ classify, config: enabled });
    expect(await run(h, "touch /tmp/build-artifact")).toBeUndefined();
  });

  it("fails closed when there is no verdict", async () => {
    const { classify } = recorder(null);
    const h = harness({ classify, config: enabled });
    const decision = await run(h, "touch /tmp/x");
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("no verdict");
  });

  it("honours onError: allow", async () => {
    const { classify } = recorder(null);
    const h = harness({ classify, config: { classifier: { ...enabled.classifier, onError: "allow" } } });
    expect(await run(h, "touch /tmp/x")).toBeUndefined();
  });

  it("caches verdicts for identical calls", async () => {
    const { classify, calls } = recorder({ action: "allow" });
    const h = harness({ classify, config: enabled });
    await run(h, "touch /tmp/same");
    await run(h, "touch /tmp/same");
    expect(calls).toHaveLength(1);
  });

  it("stops calling the classifier once the budget is spent", async () => {
    const { classify, calls } = recorder({ action: "allow" });
    const h = harness({ classify, config: { classifier: { ...enabled.classifier, maxPerSession: 1 } } });
    expect(await run(h, "touch /tmp/a")).toBeUndefined();
    const decision = await run(h, "touch /tmp/b");
    expect(calls).toHaveLength(1);
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("budget");
  });

  it("never runs for a matched rule", async () => {
    const { classify, calls } = recorder({ action: "allow" });
    const h = harness({ classify, config: enabled });
    expect((await run(h, "rm -rf /"))?.block).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("never runs for read-only commands", async () => {
    const { classify, calls } = recorder({ action: "deny" });
    const h = harness({ classify, config: enabled });
    expect(await run(h, "git status")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("passes the user's recent instruction to the classifier", async () => {
    const { classify, calls } = recorder({ action: "allow" });
    const h = harness({ classify, config: enabled });
    await h.input!({ type: "input", text: "clear the build output", source: "interactive" });
    await run(h, "touch /tmp/build-output");
    expect(calls[0].intent).toContain("clear the build output");
  });

  it("escalates write tools too", async () => {
    const { classify } = recorder({ action: "deny", reason: "not asked" });
    const h = harness({ classify, config: enabled });
    const decision = await runTool(h, "write", { path: "/tmp/x", content: "hi" });
    expect(decision?.block).toBe(true);
  });

  it("obeys a prompt verdict through the UI", async () => {
    const { classify } = recorder({ action: "prompt", reason: "publishing" });
    const h = harness({ classify, config: enabled });
    expect(await run(h, "npm publish", { approve: async () => "once" })).toBeUndefined();
    expect((await run(h, "npm publish", { approve: async () => "deny" }))?.block).toBe(true);
  });

  it("logs would-be classifier denials in observe mode", async () => {
    const { classify } = recorder({ action: "deny", reason: "risky" });
    const h = harness({ classify, config: { ...enabled, mode: "observe" } });
    expect(await run(h, "touch /tmp/x")).toBeUndefined();
    const record = JSON.parse(readFileSync(join(stateDir, "tool-gate.log"), "utf8").trim());
    expect(record).toMatchObject({ decision: "allow", wouldBe: "deny", source: "classifier" });
  });
});
