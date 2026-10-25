import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import worktreeKit from "../src/index.ts";

interface ToolDef {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

type Handler = (event: any, ctx?: any) => Promise<any>;

function stubZod() {
  const schema: any = {
    describe: () => schema,
    optional: () => schema,
  };
  return {
    object: () => schema,
    enum: () => schema,
    string: () => schema,
    boolean: () => schema,
  };
}

function harness(git: (args: string[]) => { code: number; stdout: string; stderr: string }) {
  const tools = new Map<string, ToolDef>();
  const handlers = new Map<string, Handler[]>();
  const messages: string[] = [];

  const pi = {
    zod: stubZod(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    registerTool: (definition: ToolDef) => tools.set(definition.name, definition),
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec: async (_command: string, args: string[]) => git(args),
    sendMessage: (text: string) => messages.push(text),
  } as unknown as ExtensionAPI;

  return { pi, tools, handlers, messages };
}

function listing(repo: string): string {
  return [
    `worktree ${repo}`,
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    `worktree ${repo}/.omp/worktrees/feat-x`,
    "HEAD bbb",
    "branch refs/heads/feat/x",
    "",
  ].join("\n");
}

let repoRoot: string;

beforeEach(() => {
  delete process.env["HERDR_ENV"];
  delete process.env["HERDR_WORKSPACE_ID"];
  repoRoot = mkdtempSync(join(tmpdir(), "worktree-kit-repo-"));
  process.env["WORKTREE_KIT_STATE_DIR"] = mkdtempSync(join(tmpdir(), "worktree-kit-state-"));
});

function defaultGit(overrides: Record<string, { code: number; stdout: string; stderr: string }> = {}) {
  return (args: string[]) => {
    const key = args.join(" ");
    for (const [needle, response] of Object.entries(overrides)) {
      if (key.includes(needle)) return response;
    }
    if (key.includes("rev-parse --show-toplevel")) return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    if (key.includes("status --porcelain")) return { code: 0, stdout: "", stderr: "" };
    if (key.includes("rev-parse --verify")) return { code: 1, stdout: "", stderr: "" };
    if (key.includes("worktree list")) return { code: 0, stdout: listing(repoRoot), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function call(tools: Map<string, ToolDef>, params: Record<string, unknown>) {
  const tool = tools.get("worktree");
  if (!tool) throw new Error("worktree tool not registered");
  return tool.execute("call-1", params);
}

describe("worktree tool", () => {
  it("creates under the managed root and reports a clean main", async () => {
    const seen: string[] = [];
    const h = harness((args) => {
      seen.push(args.join(" "));
      return defaultGit()(args);
    });
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "create", repository: repoRoot, branch: "feat/x" });
    const text = result.content[0]!.text;

    expect(text).toContain(`${repoRoot}/.omp/worktrees/feat-x`);
    expect(text).not.toContain("Cutover required");
    expect(seen.some((line) => line.includes("worktree add -b feat/x"))).toBe(true);
  });

  it("reminds about cutover when main is dirty", async () => {
    const h = harness(
      defaultGit({ "status --porcelain": { code: 0, stdout: " M src/a.ts\n?? scratch.txt\n", stderr: "" } }),
    );
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "create", repository: repoRoot, branch: "feat/y" });
    expect(result.content[0]!.text).toContain("Cutover required");
    expect(result.content[0]!.text).toContain("1 modified, 1 untracked");
  });

  it("reuses an existing branch without -b", async () => {
    const seen: string[] = [];
    const h = harness((args) => {
      seen.push(args.join(" "));
      return defaultGit({ "rev-parse --verify": { code: 0, stdout: "", stderr: "" } })(args);
    });
    worktreeKit(h.pi);

    await call(h.tools, { action: "create", repository: repoRoot, branch: "feat/x" });
    const addCall = seen.find((line) => line.includes("worktree add"));
    expect(addCall).toBeDefined();
    expect(addCall).not.toContain("-b");
  });

  it("refuses a reserved branch", async () => {
    const h = harness(defaultGit());
    worktreeKit(h.pi);
    const result = await call(h.tools, { action: "create", repository: repoRoot, branch: "main" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("reserved");
  });

  it("lists linked worktrees without the main checkout", async () => {
    const h = harness(defaultGit());
    worktreeKit(h.pi);
    const result = await call(h.tools, { action: "list", repository: repoRoot });
    expect(result.content[0]!.text).toContain(`${repoRoot}/.omp/worktrees/feat-x`);
    expect(result.content[0]!.text).toContain(`Repository: ${repoRoot}`);
  });

  it("refuses to remove the main checkout", async () => {
    const h = harness(defaultGit());
    worktreeKit(h.pi);
    const result = await call(h.tools, { action: "remove", repository: repoRoot, path: "/repo" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cannot be removed");
  });

  it("flags a direct git command that escapes the managed root", async () => {
    const h = harness(defaultGit());
    worktreeKit(h.pi);

    const [onCall] = h.handlers.get("tool_call") ?? [];
    const [onResult] = h.handlers.get("tool_result") ?? [];
    const event = { toolName: "bash", toolCallId: "c1", input: { command: "git worktree add /tmp/wt feat/z" } };

    await onCall!(event, { cwd: repoRoot });
    const patched = await onResult!(
      { toolName: "bash", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] },
      { cwd: repoRoot },
    );

    expect(patched.content[0].text).toContain("outside the managed root");
    expect(patched.content[1].text).toBe("ok");

    const [onStart] = h.handlers.get("session_start") ?? [];
    await onStart!({}, { cwd: repoRoot });
    expect(h.messages[0]).toContain("/tmp/wt");
  });

  it("stays quiet for a direct command inside the managed root", async () => {
    const h = harness(defaultGit());
    worktreeKit(h.pi);

    const [onCall] = h.handlers.get("tool_call") ?? [];
    const [onResult] = h.handlers.get("tool_result") ?? [];
    const event = {
      toolName: "bash",
      toolCallId: "c2",
      input: { command: `git worktree add ${repoRoot}/.omp/worktrees/feat-z feat/z` },
    };

    await onCall!(event, { cwd: repoRoot });
    const patched = await onResult!(
      { toolName: "bash", toolCallId: "c2", isError: false, content: [{ type: "text", text: "ok" }] },
      { cwd: repoRoot },
    );
    expect(patched).toBeUndefined();
  });
});

describe("herdr backend", () => {
  function herdrHarness(herdrResponses: (args: string[]) => { code: number; stdout: string; stderr: string }) {
    return harness((args) => {
      if (args[0] === "-C" || args[0] === "--version") return defaultGit()(args);
      return herdrResponses(args);
    });
  }

  it("delegates creation to herdr and reports the path herdr chose", async () => {
    process.env["HERDR_ENV"] = "1";
    const seen: string[] = [];
    const h = herdrHarness((args) => {
      seen.push(args.join(" "));
      return { code: 0, stdout: JSON.stringify({ result: { path: `${repoRoot}/../herdr-feat-x` } }), stderr: "" };
    });
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "create", repository: repoRoot, branch: "feat/x" });
    const body = result.content[0]!.text;

    expect(body).toContain("Backend: herdr");
    expect(body).toContain("herdr-feat-x");
    expect(seen[0]).toContain("worktree create --cwd");
    expect(seen[0]).not.toContain(".omp/worktrees");
  });

  it("refuses to remove the workspace hosting this session", async () => {
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_WORKSPACE_ID"] = "ws-current";
    const h = herdrHarness((args) => {
      if (args[1] === "open") return { code: 0, stdout: JSON.stringify({ result: { workspace_id: "ws-current" } }), stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    });
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "remove", repository: repoRoot, path: "/herdr/a" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("hosts this agent session");
  });

  it("removes a different workspace by id", async () => {
    process.env["HERDR_ENV"] = "1";
    const seen: string[] = [];
    const h = herdrHarness((args) => {
      seen.push(args.join(" "));
      if (args[1] === "open") return { code: 0, stdout: JSON.stringify({ result: { workspace_id: "ws-other" } }), stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    });
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "remove", repository: repoRoot, path: "/herdr/a", force: true });
    expect(result.isError).toBe(false);
    expect(seen.some((line) => line.includes("remove --workspace ws-other --force"))).toBe(true);
  });

  it("lists only linked, non-prunable herdr worktrees", async () => {
    process.env["HERDR_ENV"] = "1";
    const h = herdrHarness(() => ({
      code: 0,
      stdout: JSON.stringify({
        result: {
          worktrees: [
            { path: repoRoot, branch: "main" },
            { path: "/herdr/feat-y", branch: "feat/y", is_linked_worktree: true },
          ],
        },
      }),
      stderr: "",
    }));
    worktreeKit(h.pi);

    const result = await call(h.tools, { action: "list", repository: repoRoot });
    expect(result.content[0]!.text).toContain("/herdr/feat-y");
    expect(result.content[0]!.text).not.toContain(`- ${repoRoot}\n`);
  });
});
