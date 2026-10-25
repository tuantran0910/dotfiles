import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import toolGate from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<{ block?: boolean; reason?: string } | undefined>;

interface Harness {
  handlers: Handler[];
  command: { handler: (args: string, ctx: any) => Promise<void> };
  notices: string[];
}

function harness(approve?: (prompt: any) => Promise<any>): Harness {
  const handlers: Handler[] = [];
  const notices: string[] = [];
  let command: any;

  const pi = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    registerCommand: (_name: string, definition: any) => {
      command = definition;
    },
    on: (event: string, handler: Handler) => {
      if (event === "tool_call") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;

  toolGate(pi);
  return {
    handlers,
    command,
    notices,
    approve,
  } as Harness & { approve?: (prompt: any) => Promise<any> };
}

let stateDir: string;
let cwd: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tool-gate-state-"));
  cwd = mkdtempSync(join(tmpdir(), "tool-gate-work-"));
  process.env["TOOL_GATE_STATE_DIR"] = stateDir;
});

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
