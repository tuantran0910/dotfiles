import { describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLASSIFIER, DEFAULT_RULES, loadConfig } from "../src/config.ts";
import { evaluate } from "../src/decide.ts";
import { isReadOnlyCommand } from "../src/classify-input.ts";
import { gateHarness, classifierPolicy } from "./harness.ts";

const policy = { mode: "enforce" as const, defaultAction: "allow" as const, log: false, rules: DEFAULT_RULES, classifier: DEFAULT_CLASSIFIER };

describe("read-only fast-path boundary", () => {
  const executable = [
    'node -e "process.exit(0)"', 'python3 -c "print(1)"', "python3 task.py", "bun task.ts",
    "npm exec task", "npm run deploy", "npm test", "pnpm dlx task", "yarn dlx task", "uv run task.py",
    "cargo run", "cargo test", "go run task.go", "pip uninstall example", "ruff check --fix-only .",
    "git branch new-branch", "/usr/bin/git branch new-branch", "git remote add origin https://example.test/r",
    "sort -o output.txt input.txt", "sort --output=output.txt input.txt", "rg --pre task.sh pattern .",
    "rg --hostname-bin task.sh pattern .", "git diff --output=result.patch", "git log --ext-diff -p",
    "echo safe\ntouch unrelated", "echo $API_TOKEN", "printf %s ${SECRET}", "./cat README.md",
    "/tmp/ls -la", "jq --run-tests tests.jq", "date -s 2026-01-01", "ls -la\r\ntouch unrelated",
    "sort '-o' output input", "rg '--pre=task.sh' pattern .", "cat 'unterminated", "file -C",
    "cat ~/alias/*", "echo\u00a0task",
    "ls && touch build", "cat notes.txt | xargs touch", "cd sub && cat notes.txt", "uniq a.txt out.txt",
    "sort --compress-program=sh x", "bat --paging=always --pager=sh x", "ag --pager sh foo",
    "ack --pager=sh foo", "rg -z foo",
  ];
  for (const command of executable) {
    it(`classifies executable or mutating input: ${JSON.stringify(command)}`, async () => {
      let calls = 0;
      const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "deny" }; } });
      expect(isReadOnlyCommand(command)).toBe(false);
      expect((await h.bash(command))?.block).toBe(true);
      expect(calls).toBe(1);
    });
  }
  it("keeps session-only agent tools away from the classifier", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "deny" }; } });
    expect(await h.call("todo", { list: [{ content: "read schema", status: "pending" }] })).toBeUndefined();
    expect(await h.call("ask", { question: "which branch?" })).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("records why the classifier asked and how the user answered", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: "prompt", reason: "Jev allow probability 0.910 is below 0.95; confirmation required" }) });
    expect(await h.bash("touch out.txt", { hasUI: true, ui: { approve: async () => "once" } })).toBeUndefined();
    const record = h.audit().at(-1);
    expect(record).toMatchObject({ decision: "allow", source: "classifier", verdict: "prompt", approval: "once" });
    expect(record.reason).toContain("0.910");
  });
  it("asks about an oversized command without running backtracking-prone rule regexes", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    const started = performance.now();
    const result = await h.bash("git push ".repeat(12000));
    expect(performance.now() - started).toBeLessThan(500);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("too long");
    expect(calls).toBe(0);
  });
  it("checks file rules against paths reached through cd", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    expect((await h.bash("cd ~/.ssh && head config"))?.block).toBe(true);
    expect(calls).toBe(0);
  });
  for (const command of [
    "git status", "git diff --stat", "git log --oneline -5", "rg TODO src", "ls -la", "cat README.md", "jq . package.json",
    "cd /tmp && grep -n 'pub struct\\|pub fn' lib.rs | head -40 && echo '--- sizes ---' && wc -l lib.rs",
    "cd /tmp && ls src | head -40 && echo '--- routes ---' && grep -n 'tables' routes.tsx | head -20",
  ]) {
    it(`keeps ordinary reads fast: ${command}`, async () => {
      let calls = 0;
      const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "deny" }; } });
      expect(await h.bash(command)).toBeUndefined();
      expect(calls).toBe(0);
    });
  }
});

describe("policy monotonicity", () => {
  it("a project prompt cannot soften a default deny, even after a session grant", async () => {
    const h = gateHarness({ project: { rules: [{ id: "project-prompt", action: "prompt", tool: "bash", reason: "trust this repository" }] } });
    expect((await h.bash("rm -rf /"))?.block).toBe(true);
    await h.command("allow project-prompt");
    expect((await h.bash("rm -rf /"))?.block).toBe(true);
  });
  it("an earlier prompt cannot mask a denial in a compound call", async () => {
    const h = gateHarness();
    let prompted = false;
    const result = await h.bash("curl -X DELETE https://example.test/resource; gh pr merge 12", {
      hasUI: true, ui: { approve: async () => { prompted = true; return "once"; } },
    });
    expect(result?.block).toBe(true);
    expect(prompted).toBe(false);
  });
  it("a session grant cannot be reused through a duplicate rule id", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: "deny" }), project: { rules: [{ id: "sudo", action: "prompt", tool: "bash", command: "touch", reason: "shadowed id" }] } });
    await h.command("allow sudo");
    expect(h.warnings.some(warning => warning.includes("duplicate"))).toBe(true);
    // Dropping the conflicting project rule leaves this unmatched, rather than granting it.
    expect((await h.bash("touch unrelated"))?.block).toBe(true);
  });
});

describe("protected path aliases and multi-file edits", () => {
  function check(tool: string, input: Record<string, unknown>, h = gateHarness()) {
    return evaluate(policy, { tool, input, cwd: h.cwd, home: h.root });
  }
  it("a template in a multi-file edit cannot allow a credential target", () => {
    expect(check("edit", { paths: [".env.example", ".env.production"] }).action).toBe("deny");
  });
  it("an allowed template symlink cannot launder a denied target", () => {
    const h = gateHarness();
    mkdirSync(join(h.root, ".ssh"));
    writeFileSync(join(h.root, ".ssh/id_rsa"), "synthetic fixture");
    symlinkSync(join(h.root, ".ssh/id_rsa"), join(h.cwd, ".env.example"));
    expect(check("read", { path: ".env.example" }, h).action).toBe("deny");
  });
  it("a new file below a symlinked credential directory remains protected", () => {
    const h = gateHarness();
    mkdirSync(join(h.root, ".ssh"));
    symlinkSync(join(h.root, ".ssh"), join(h.cwd, "alias"));
    expect(check("write", { path: "alias/new-key" }, h).action).toBe("deny");
  });
  it("normalizes dot segments in absolute paths for new files", () => {
    const h = gateHarness();
    expect(check("write", { path: `${h.root}/uncreated/../.ssh/new-key` }, h).action).toBe("deny");
  });
  it("protects the directory itself and search tools", () => {
    const h = gateHarness();
    for (const tool of ["read", "grep", "glob", "find", "ls"]) {
      expect(check(tool, { path: `${h.root}/.ssh` }, h).action).toBe("deny");
    }
  });
  it("canonicalizes the protected literal path as well as the requested path", () => {
    const h = gateHarness();
    mkdirSync(join(h.root, ".omp/agent"), { recursive: true });
    const backing = join(h.cwd, "policy.json");
    writeFileSync(backing, "{}");
    symlinkSync(backing, join(h.root, ".omp/agent/tool-gate.json"));
    expect(check("write", { path: backing }, h).action).toBe("prompt");
  });
  it("does not treat a template prefix as a template exemption", () => {
    expect(check("read", { path: ".env.example.production" }).action).toBe("deny");
  });
  it("checks literal fast-path shell operands against protected paths", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: "allow" }) });
    expect((await h.bash("grep . ~/.aws/credentials"))?.block).toBe(true);
    expect((await h.bash("jq . ~/.codex/auth.json"))?.block).toBe(true);
    expect((await h.bash("cat ~/.s''sh/id_rsa"))?.block).toBe(true);
  });
});

describe("verdict cache isolation", () => {
  it("rejudges when the dynamically selected fallback model changes", async () => {
    let selected = { provider: "synthetic-provider", id: "first" };
    let calls = 0;
    const h = gateHarness({ config: { classifier: { ...classifierPolicy.classifier, fallbackModel: "@current" } }, classify: async () => ({ action: ++calls === 1 ? "allow" : "deny" }) });
    h.ctx.models = { current: () => selected };
    expect(await h.bash("touch output")).toBeUndefined();
    selected = { ...selected, id: "second" };
    expect((await h.bash("touch output"))?.block).toBe(true);
    expect(calls).toBe(2);
  });
  it("does not reuse a hash collision (Aa and B@ collide in the old djb2 key)", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async call => { calls++; return { action: call.input["command"] === "touch Aa" ? "allow" : "deny" }; } });
    expect(await h.bash("touch Aa")).toBeUndefined();
    expect((await h.bash("touch B@"))?.block).toBe(true);
    expect(calls).toBe(2);
  });
  it("rejudges the same call after the user changes intent", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: ++calls === 1 ? "allow" : "deny" }) });
    await h.input("create output");
    await h.bash("touch output");
    await h.input("stop changing files");
    expect((await h.bash("touch output"))?.block).toBe(true);
    expect(calls).toBe(2);
  });
  it("rejudges across cwd changes and explicit reloads", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    await h.bash("touch output");
    mkdirSync(join(h.root, "other"));
    h.ctx.cwd = join(h.root, "other");
    await h.bash("touch output");
    await h.command("reload");
    await h.bash("touch output");
    expect(calls).toBe(3);
  });
  it("resets session permissions and budget on a session switch", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    await h.command("allow sudo");
    await h.bash("touch output");
    await h.event("session_switch");
    expect((await h.bash("sudo ls"))?.block).toBe(true);
    await h.bash("touch output");
    expect(calls).toBe(2);
  });
  it("deduplicates concurrent identical classifier requests", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { action: "allow" }; } });
    await Promise.all(Array.from({ length: 8 }, () => h.bash("touch output")));
    expect(calls).toBe(1);
  });
  it("does not cache a transient classifier failure", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => ++calls === 1 ? null : { action: "allow" } });
    expect((await h.bash("touch output"))?.block).toBe(true);
    expect(await h.bash("touch output")).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("approval and audit contract", () => {
  it("headless prompts are recorded as denials with a call id", async () => {
    const h = gateHarness();
    expect((await h.bash("npm publish"))?.block).toBe(true);
    expect(h.audit()[0]).toMatchObject({ decision: "deny", ruleId: "package-publish", toolCallId: "probe-1" });
  });
  it("records the user's denial rather than the preliminary prompt", async () => {
    const h = gateHarness();
    await h.bash("npm publish", { hasUI: true, ui: { approve: async () => "deny" } });
    expect(h.audit()[0].decision).toBe("deny");
  });
  it("records an approved prompt as allow", async () => {
    const h = gateHarness();
    expect(await h.bash("npm publish", { hasUI: true, ui: { approve: async () => "once" } })).toBeUndefined();
    expect(h.audit()[0].decision).toBe("allow");
  });
  it("session approval for a classifier prompt covers the identical call only", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: "prompt", reason: "confirm this target" }) });
    expect(await h.bash("touch output", { hasUI: true, ui: { approve: async () => "session" } })).toBeUndefined();
    expect(await h.bash("touch output")).toBeUndefined();
    expect((await h.bash("touch different"))?.block).toBe(true);
  });
  it("unexpected UI answers never count as consent", async () => {
    const h = gateHarness();
    expect((await h.bash("npm publish", { hasUI: true, ui: { approve: async () => null } }))?.block).toBe(true);
  });
  it("classifier exceptions become an audited fail-closed denial", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => { throw new Error("provider unavailable"); } });
    expect((await h.bash("touch output"))?.block).toBe(true);
    expect(h.audit()[0]).toMatchObject({ decision: "deny", source: "classifier" });
  });
});

describe("malformed policy files", () => {
  it("warns and fails closed if an existing user config cannot be parsed", () => {
    const h = gateHarness();
    writeFileSync(join(h.state, "tool-gate.json"), "{ invalid");
    const loaded = loadConfig(h.state, h.cwd);
    expect(loaded.warnings.length).toBeGreaterThan(0);
    expect(loaded.config.defaultAction).toBe("deny");
  });
  for (const config of [
    { classifier: { enabled: "true" } }, { classifier: { timeoutMs: 10 } },
    { classifier: { maxPerSession: 1.5 } }, { classifier: { onError: "ask" } },
    { classifier: { timeoutMs: Infinity } }, { classifier: { model: " " } },
    { classifier: [] }, { classifer: { enabled: true } }, { mode: "enforced" },
    { defaultAction: "denyy" }, { rules: [{ id: "invalid", action: "deny", command: "[", reason: "typo" }] },
  ]) {
    it(`fails closed for invalid user policy ${JSON.stringify(config)}`, () => {
      const h = gateHarness({ config });
      const loaded = loadConfig(h.state, h.cwd);
      expect(loaded.warnings.length).toBeGreaterThan(0);
      expect(loaded.config.mode).toBe("enforce");
      expect(loaded.config.defaultAction).toBe("deny");
      expect(loaded.config.classifier.enabled).toBe(false);
    });
  }
});
