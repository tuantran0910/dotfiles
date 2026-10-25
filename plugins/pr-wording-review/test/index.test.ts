import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import prWordingReview from "../src/index.ts";

type Handler = (event: unknown, ctx?: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

function harness(commitLog: string | null = null) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    exec: async () =>
      commitLog === null
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: commitLog, stderr: "" },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pr-wording-"));
});

/** One plugin instance per session: the interrupt set must persist across calls. */
function session(commitLog: string | null = null) {
  const h = harness(commitLog);
  prWordingReview(h.pi);
  const [handler] = h.handlers.get("tool_call") ?? [];
  if (!handler) throw new Error("tool_call not registered");
  return (command: string, workingDirectory = cwd) =>
    handler({ toolName: "bash", toolCallId: "1", input: { command, cwd: workingDirectory } }, { cwd: workingDirectory });
}

describe("body-file inspection", () => {
  it("interrupts a slop description file, then lets the retry through", async () => {
    const run = session();
    writeFileSync(join(cwd, "body.md"), "This is a seamless change — it leverages caching to unlock potential.\n");

    const first = await run("gh pr create --body-file body.md --title x");
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("machine-generated");

    const retry = await run("gh pr create --body-file body.md --title x");
    expect(retry).toBeUndefined();
  });

  it("allows a measured description file", async () => {
    const run = session();
    writeFileSync(join(cwd, "body.md"), "Fixes a race in the worktree cache by holding the lock across rename(2).\n");
    expect(await run("gh pr create -F body.md")).toBeUndefined();
  });

  it("resolves the path against the command cwd, not the session cwd", async () => {
    const run = session();
    const other = mkdtempSync(join(tmpdir(), "pr-wording-other-"));
    writeFileSync(join(other, "body.md"), "A world-class improvement.\n");
    expect((await run("gh pr edit 7 --body-file body.md", other))?.block).toBe(true);
  });

  it("fails open for a missing file", async () => {
    const run = session();
    expect(await run("gh pr create --body-file does-not-exist.md")).toBeUndefined();
  });

  it("ignores inline bodies and stdin", async () => {
    const run = session();
    expect(await run(`gh pr create -f "seamless and comprehensive"`)).toBeUndefined();
    expect(await run("gh pr create -F -")).toBeUndefined();
  });

  it("ignores commands that are not PR writes", async () => {
    const run = session();
    writeFileSync(join(cwd, "body.md"), "seamless comprehensive leverage\n");
    expect(await run("gh pr view 1 --body-file body.md")).toBeUndefined();
    expect(await run("git commit -F body.md -m x")).toBeUndefined();
  });

  it("tracks interrupts per file, not per session", async () => {
    const run = session();
    writeFileSync(join(cwd, "a.md"), "seamless\n");
    writeFileSync(join(cwd, "b.md"), "comprehensive\n");

    expect((await run("gh pr create -F a.md"))?.block).toBe(true);
    expect((await run("gh pr create -F b.md"))?.block).toBe(true);
    expect(await run("gh pr create -F a.md")).toBeUndefined();
  });
});

describe("other write paths", () => {
  it("inspects a heredoc passed on stdin", async () => {
    const run = session();
    const decision = await run(`gh pr create -F - <<'EOF'\nThis is a seamless improvement.\nEOF`);
    expect(decision?.block).toBe(true);
  });

  it("inspects text piped into stdin", async () => {
    const run = session();
    expect((await run(`echo "A world-class change" | gh pr create -F -`))?.block).toBe(true);
  });

  it("inspects a body file written earlier in the same command", async () => {
    const run = session();
    const decision = await run(`echo "A comprehensive rewrite." > body.md && gh pr create -F body.md`);
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("body.md");
  });

  it("inspects gh api pull request fields", async () => {
    const run = session();
    const decision = await run(`gh api /repos/o/r/pulls -f title=feat -f body="leverage caching"`);
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("gh-api-pulls");
  });

  it("ignores gh api reads", async () => {
    const run = session();
    expect(await run(`gh api /repos/o/r/pulls`)).toBeUndefined();
  });

  it("inspects commit messages behind --fill", async () => {
    const run = session("feat: add caching\n\nThis seamless change leverages the new store.\n");
    const decision = await run(`gh pr create --fill`);
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("fill");
  });

  it("allows --fill when commit messages are clean", async () => {
    const run = session("fix: hold the lock across rename(2)\n");
    expect(await run(`gh pr create --fill`)).toBeUndefined();
  });
});
