import { describe, expect, it } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLASSIFIER, DEFAULT_RULES } from "../src/config.ts";
import { evaluate } from "../src/decide.ts";
import { MAX_CLASSIFIER_ARGS } from "../src/classifier.ts";
import { gateHarness, classifierPolicy } from "./harness.ts";

const forbidden = ["rm -rf /", "git reset --hard HEAD", "git push --force", "mkfs.ext4 /dev/sda", "prisma migrate reset", "gh pr merge 1"];
const policy = { mode: "enforce" as const, defaultAction: "allow" as const, log: false, rules: DEFAULT_RULES, classifier: DEFAULT_CLASSIFIER };

describe("generated deny monotonicity", () => {
  for (const command of forbidden) {
    for (const action of ["prompt", "allow"] as const) {
      for (const granted of [false, true]) {
        it(`${command}: earlier ${action}, granted=${granted}, cannot weaken deny`, () => {
          const rules = [{ id: "broad-rule", action, tool: "bash", reason: "generated policy" }, ...DEFAULT_RULES];
          expect(evaluate({ ...policy, rules }, { tool: "bash", input: { command }, cwd: "/repo", home: "/nonexistent-gate-home" }, new Set(granted ? ["broad-rule"] : [])).action).toBe("deny");
        });
      }
    }
  }
});

describe("generated multi-file target ordering", () => {
  for (const tool of ["read", "write", "edit"]) {
    for (const template of [".env.example", ".env.sample", ".env.template"]) {
      for (const paths of [[template, ".env.production"], [".env.production", template]]) {
        it(`${tool}: ${paths.join(", ")}`, () => {
          expect(evaluate(policy, { tool, input: { paths }, cwd: "/repo", home: "/nonexistent-gate-home" }).action).toBe("deny");
        });
      }
    }
  }
});

describe("hook lifecycle and concurrency", () => {
  it("gates the installed SDK's normalized multi-file hashline edit targets", async () => {
    const sdk = await import(new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/tool-event-input.ts", import.meta.url).href);
    const input = sdk.normalizeToolEventInput("edit", { _path: "innocent.ts", input: "[.env.example#abcd]\n[.env.production#1234]" });
    expect(input.paths).toEqual([".env.example", ".env.production"]);
    const h = gateHarness({ config: classifierPolicy, classify: async () => ({ action: "allow" }) });
    expect((await h.call("edit", input))?.block).toBe(true);
  });
  it("does not mistake a rule named default for a fallback", async () => {
    const h = gateHarness({ config: { ...classifierPolicy, rules: [{ id: "default", action: "deny", command: "touch", reason: "explicit rule" }] }, classify: async () => ({ action: "allow" }) });
    expect((await h.bash("touch output"))?.block).toBe(true);
    expect(h.audit()[0].source).toBe("rule");
  });
  it("an intent change invalidates an in-flight permission decision", async () => {
    let answer!: (value: any) => void;
    const h = gateHarness({ config: classifierPolicy, classify: () => new Promise(resolve => { answer = resolve; }) });
    const pending = h.bash("touch output");
    await Promise.resolve();
    await h.input("stop changing files");
    answer({ action: "allow" });
    expect((await pending)?.block).toBe(true);
  });
  it("a session switch rejects a pending observe-mode allow", async () => {
    let answer!: (value: any) => void;
    const h = gateHarness({ config: classifierPolicy, classify: () => new Promise(resolve => { answer = resolve; }) });
    await h.command("mode observe");
    const pending = h.bash("touch output");
    await Promise.resolve();
    await h.event("session_switch");
    answer({ action: "allow" });
    expect((await pending)?.block).toBe(true);
  });
  it("a reload rejects a pending UI approval", async () => {
    let answer!: (value: any) => void;
    const h = gateHarness();
    const pending = h.bash("npm publish", { ui: { approve: () => new Promise(resolve => { answer = resolve; }) } });
    await h.command("reload");
    answer("once");
    expect((await pending)?.block).toBe(true);
  });
  it("enforces the budget under concurrent distinct requests", async () => {
    let calls = 0;
    const h = gateHarness({ config: { classifier: { ...classifierPolicy.classifier, maxPerSession: 2 } }, classify: async () => { calls++; return { action: "allow" }; } });
    const decisions = await Promise.all(Array.from({ length: 10 }, (_, i) => h.bash(`touch output-${i}`)));
    expect(calls).toBe(2);
    expect(decisions.filter(result => result?.block)).toHaveLength(8);
  });
  it("preserves a runtime mode override through reload", async () => {
    const h = gateHarness();
    await h.command("mode observe");
    await h.command("reload");
    expect(await h.bash("rm -rf /")).toBeUndefined();
    expect(h.audit()[0]).toMatchObject({ decision: "allow", wouldBe: "deny" });
  });
  it("off mode never calls the classifier", async () => {
    let calls = 0;
    const h = gateHarness({ config: { ...classifierPolicy, mode: "off" }, classify: async () => { calls++; return { action: "deny" }; } });
    expect(await h.bash("touch output")).toBeUndefined();
    expect(calls).toBe(0);
    expect(h.audit()[0].ruleId).toBe("mode:off");
  });
  it("oversized calls require review without consulting a partial prompt", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    expect((await h.call("write", { path: "output", content: "a".repeat(MAX_CLASSIFIER_ARGS + 1) }))?.block).toBe(true);
    expect(calls).toBe(0);
  });
  it("retargeting a file-tool symlink invalidates the cached verdict", async () => {
    const seen: any[] = [];
    const h = gateHarness({ config: classifierPolicy, classify: async call => { seen.push(call.resolvedPaths); return { action: seen.length === 1 ? "allow" : "deny" }; } });
    for (const name of ["one", "two"]) mkdirSync(join(h.root, name));
    symlinkSync(join(h.root, "one"), join(h.cwd, "alias"));
    expect(await h.call("write", { path: "alias/new", content: "synthetic" })).toBeUndefined();
    renameSync(join(h.cwd, "alias"), join(h.cwd, "old-alias"));
    symlinkSync(join(h.root, "two"), join(h.cwd, "alias"));
    expect((await h.call("write", { path: "alias/new", content: "synthetic" }))?.block).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0][0]).toContain("/one/new");
    expect(seen[1][0]).toContain("/two/new");
  });
  it("applies a changed classifier configuration after reload", async () => {
    const h = gateHarness({ config: classifierPolicy, classify: async () => null });
    expect((await h.bash("touch output"))?.block).toBe(true);
    writeFileSync(join(h.state, "tool-gate.json"), JSON.stringify({ classifier: { ...classifierPolicy.classifier, onError: "allow" } }));
    await h.command("reload");
    expect(await h.bash("touch output")).toBeUndefined();
  });
});

describe("common CLI option spellings", () => {
  for (const command of [
    "gh -R owner/repo pr merge 1", "gh --repo=owner/repo pr merge 1", "gh pr review 1 -a",
    "gh --repo owner/repo pr review 1 --approve", "drizzle-kit push --config=drizzle.ts --force",
    "prisma db push --schema=schema.prisma --force-reset",
  ]) {
    it(`denies ${command}`, async () => expect((await gateHarness().bash(command))?.block).toBe(true));
  }
  for (const command of ["curl --request=DELETE https://example.test/r", "curl -XDELETE https://example.test/r"]) {
    it(`prompts for ${command}`, async () => {
      const h = gateHarness();
      let prompted = false;
      expect(await h.bash(command, { ui: { approve: async () => { prompted = true; return "once"; } } })).toBeUndefined();
      expect(prompted).toBe(true);
    });
  }
  for (const command of ["git clean -nfdx", "git clean -fdx --dry-run"]) {
    it(`allows dry run ${command}`, async () => expect(await gateHarness().bash(command)).toBeUndefined());
  }
});
