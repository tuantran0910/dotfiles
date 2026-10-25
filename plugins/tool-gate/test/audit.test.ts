import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, auditPath } from "../src/audit.ts";
import { gateHarness } from "./harness.ts";

describe("audit persistence", () => {
  const record = { tool: "bash", decision: "deny", ruleId: "synthetic", source: "rule" as const };
  it("creates logs with private permissions and valid JSONL", () => {
    const h = gateHarness();
    appendAudit(h.state, { ...record, detail: "line one\nline two" });
    expect(statSync(auditPath(h.state)).mode & 0o777).toBe(0o600);
    const lines = readFileSync(auditPath(h.state), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).detail).toBe("line one\nline two");
  });
  it("rotates at the size bound and resumes logging", () => {
    const h = gateHarness();
    writeFileSync(auditPath(h.state), "x".repeat(2 * 1024 * 1024 + 1));
    appendAudit(h.state, record);
    expect(statSync(`${auditPath(h.state)}.1`).size).toBe(2 * 1024 * 1024 + 1);
    expect(JSON.parse(readFileSync(auditPath(h.state), "utf8")).decision).toBe("deny");
  });
  it("makes an existing log private", () => {
    const h = gateHarness();
    writeFileSync(auditPath(h.state), "");
    chmodSync(auditPath(h.state), 0o644);
    appendAudit(h.state, record);
    expect(statSync(auditPath(h.state)).mode & 0o777).toBe(0o600);
  });
  it("logging errors do not change enforcement", async () => {
    const h = gateHarness();
    mkdirSync(auditPath(h.state));
    expect((await h.bash("rm -rf /"))?.block).toBe(true);
  });
  it("never appends audit data through a symlink", () => {
    const h = gateHarness();
    const target = join(h.root, "synthetic-protected-file");
    writeFileSync(target, "sentinel");
    symlinkSync(target, auditPath(h.state));
    appendAudit(h.state, record);
    expect(readFileSync(target, "utf8")).toBe("sentinel");
  });
  for (const detail of [
    "curl -X DELETE https://example.test -H 'Authorization: Bearer synthetic-value'",
    "curl -X DELETE https://user:synthetic-value@example.test",
    "deploy --token synthetic-value", "API_KEY=synthetic-value task",
  ]) {
    it(`redacts a credential-bearing command: ${detail.split(" ")[0]}`, () => {
      const h = gateHarness();
      appendAudit(h.state, { ...record, detail });
      expect(readFileSync(auditPath(h.state), "utf8")).not.toContain("synthetic-value");
    });
  }
});
