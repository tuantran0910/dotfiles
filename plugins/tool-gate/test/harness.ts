import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import toolGate from "../src/index.ts";
import type { ClassifyFn } from "../src/classifier.ts";
import { useScratchRoots } from "../src/workspace.ts";

// Harness projects live in the temp directory; keep "outside the project" outside.
useScratchRoots([]);

/** Exercises the registered extension hooks. It never executes a proposed tool. */
export function gateHarness(options: { config?: unknown; project?: unknown; classify?: ClassifyFn } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tool-gate-harness-"));
  const state = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(state);
  mkdirSync(cwd);
  if (options.config !== undefined) writeFileSync(join(state, "tool-gate.json"), JSON.stringify(options.config));
  if (options.project !== undefined) {
    mkdirSync(join(cwd, ".omp"));
    writeFileSync(join(cwd, ".omp/tool-gate.json"), JSON.stringify(options.project));
  }
  const handlers = new Map<string, Function>();
  let command: any;
  const warnings: string[] = [];
  const previous = process.env["TOOL_GATE_STATE_DIR"];
  process.env["TOOL_GATE_STATE_DIR"] = state;
  try {
    toolGate({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (_: string, definition: unknown) => { command = definition; },
      logger: { info() {}, warn(message: string) { warnings.push(message); } },
    } as unknown as ExtensionAPI, { classify: options.classify });
  } finally {
    if (previous === undefined) delete process.env["TOOL_GATE_STATE_DIR"];
    else process.env["TOOL_GATE_STATE_DIR"] = previous;
  }
  const ctx: any = { cwd, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
  let sequence = 0;
  return {
    root, state, cwd, ctx, warnings,
    async call(tool: string, input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
      return handlers.get("tool_call")!({ toolName: tool, toolCallId: `probe-${++sequence}`, input }, { ...ctx, ...overrides });
    },
    async bash(command: string, overrides: Record<string, unknown> = {}) {
      return this.call("bash", { command }, overrides);
    },
    async input(text: string) { return handlers.get("input")?.({ text, source: "interactive" }, ctx); },
    async event(name: string) { return handlers.get(name)?.({ type: name }, ctx); },
    async command(args: string) { return command.handler(args, ctx); },
    audit(): any[] { return readFileSync(join(state, "tool-gate.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)); },
  };
}

export const classifierPolicy = { classifier: { enabled: true, onError: "deny", timeoutMs: 500, maxPerSession: 200 } };
