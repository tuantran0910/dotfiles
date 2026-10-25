import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLASSIFIER } from "../src/config.ts";
import { gateHarness, classifierPolicy } from "./harness.ts";

describe("classifier attempt limits", () => {
  it("keeps the finite built-in default", () => {
    expect(DEFAULT_CLASSIFIER.maxPerSession).toBe(200);
  });

  it("continues past 200 distinct calls when unlimited and still enforces denials", async () => {
    let calls = 0;
    const h = gateHarness({
      config: { classifier: { ...classifierPolicy.classifier, maxPerSession: -1 } },
      classify: async call => { calls++; return { action: call.input["command"] === "touch forbidden" ? "deny" : "allow" }; },
    });
    const results = await Promise.all(Array.from({ length: 256 }, (_, i) => h.bash(`touch output-${i}`)));
    expect(results.every(result => result === undefined)).toBe(true);
    expect(calls).toBe(256);
    // Cached approvals remain usable without spending an attempt.
    expect(await h.bash("touch output-0")).toBeUndefined();
    expect(calls).toBe(256);
    expect((await h.bash("touch forbidden"))?.block).toBe(true);
    expect(calls).toBe(257);
    // Deterministic denials still win before classification.
    expect((await h.bash("rm -rf /"))?.block).toBe(true);
    expect(calls).toBe(257);
    let status = "";
    h.ctx.ui.notify = (message: string) => { status = message; };
    await h.command("status");
    expect(status).toContain("257/unlimited calls");
  });

  it("keeps fail-closed behavior and retries transient errors when unlimited", async () => {
    let calls = 0;
    const h = gateHarness({ config: { classifier: { ...classifierPolicy.classifier, maxPerSession: -1 } }, classify: async () => { calls++; return null; } });
    for (let i = 0; i < 3; i++) expect((await h.bash("touch output"))?.reason).toContain("no verdict");
    expect(calls).toBe(3);
  });

  it("applies unlimited on reload after a finite budget was exhausted", async () => {
    let calls = 0;
    const h = gateHarness({ config: { classifier: { ...classifierPolicy.classifier, maxPerSession: 1 } }, classify: async () => { calls++; return { action: "allow" }; } });
    expect(await h.bash("touch first")).toBeUndefined();
    expect((await h.bash("touch second"))?.reason).toContain("budget exhausted");
    writeFileSync(join(h.state, "tool-gate.json"), JSON.stringify({ classifier: { ...classifierPolicy.classifier, maxPerSession: -1 } }));
    await h.command("reload");
    expect(await h.bash("touch second")).toBeUndefined();
    expect(calls).toBe(2);
  });

  // Exercise the actual router and hook reservation callback without network
  // calls: Jev has no key, and the fallback has no resolved session model.
  for (const [limit, fallbackAttempts] of [[0, 0], [1, 0], [2, 1], [-1, 205]] as const) {
    it(`applies ${limit} to both primary and fallback reservations`, async () => {
      const h = gateHarness({ config: { classifier: { ...classifierPolicy.classifier, backend: "opencode-jev", model: "jev-1.13-free", fallbackModel: "@smol", maxPerSession: limit } } });
      let fallbacks = 0;
      h.ctx.models = { current: () => undefined, resolve: () => { fallbacks++; return undefined; } };
      h.ctx.modelRegistry = { getApiKey: async () => undefined };
      for (let i = 0; i < 205; i++) expect((await h.bash(`touch unavailable-${i}`))?.block).toBe(true);
      expect(fallbacks).toBe(fallbackAttempts);
    });
  }
});
