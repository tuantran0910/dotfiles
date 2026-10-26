import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { DEFAULT_RULES, loadConfig } from "../src/config.ts";

const REPO_OMP = fileURLToPath(new URL("../../../omp", import.meta.url));

let agentDir: string;
let cwd: string;

function writeUser(value: unknown) {
  writeFileSync(join(agentDir, "tool-gate.json"), JSON.stringify(value));
}

function writeProject(value: unknown) {
  const dir = join(cwd, ".omp");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tool-gate.json"), JSON.stringify(value));
}

const customRule = { id: "project-rule", action: "deny", tool: "bash", command: "deploy", reason: "no deploys" };

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "tool-gate-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "tool-gate-cwd-"));
});

describe("loadConfig", () => {
  it("uses the defaults when no files exist", () => {
    const { config, sources, warnings } = loadConfig(agentDir, cwd);
    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config.mode).toBe("enforce");
    expect(config.defaultAction).toBe("allow");
    expect(config.rules.length).toBe(DEFAULT_RULES.length);
  });

  it("puts project rules before user rules, and both before the defaults", () => {
    writeProject({ rules: [customRule] });
    writeUser({ rules: [{ ...customRule, id: "user-rule" }] });
    const { config, sources } = loadConfig(agentDir, cwd);
    expect(sources).toHaveLength(2);
    expect(config.rules[0]?.id).toBe("project-rule");
    expect(config.rules[1]?.id).toBe("user-rule");
    expect(config.rules.length).toBe(DEFAULT_RULES.length + 2);
  });

  it("lets the user, not the project, set mode and default action", () => {
    writeUser({ mode: "observe", defaultAction: "deny" });
    writeProject({ mode: "off", defaultAction: "allow" });
    const { config, warnings } = loadConfig(agentDir, cwd);
    expect(config.mode).toBe("observe");
    expect(config.defaultAction).toBe("deny");
    expect(warnings.some((warning) => warning.includes("replaceDefaults"))).toBe(false);
  });

  it("refuses allow rules from a project file, so a repo cannot loosen policy", () => {
    writeProject({ rules: [{ id: "repo-allow", action: "allow", tool: "bash", command: "rm -rf /", reason: "trust me" }] });
    const { config, warnings } = loadConfig(agentDir, cwd);
    expect(config.rules.some((rule) => rule.id === "repo-allow")).toBe(false);
    expect(warnings.some((warning) => warning.includes("cannot add allow rules"))).toBe(true);
  });

  it("ignores a project replaceDefaults", () => {
    writeProject({ replaceDefaults: true });
    const { config, warnings } = loadConfig(agentDir, cwd);
    expect(config.rules.length).toBe(DEFAULT_RULES.length);
    expect(warnings.some((warning) => warning.includes("user-only"))).toBe(true);
  });

  it("honours replaceDefaults from the user file", () => {
    writeUser({ replaceDefaults: true, rules: [customRule] });
    const { config } = loadConfig(agentDir, cwd);
    expect(config.rules.map((rule) => rule.id)).toEqual(["project-rule"]);
  });

  it("drops invalid rules with a warning instead of failing open", () => {
    writeProject({
      rules: [
        customRule,
        { id: "no-action", reason: "x" },
        { id: "bad-regex", action: "deny", command: "[unclosed", reason: "x" },
        { action: "deny", command: "x", reason: "missing id" },
        { id: "no-reason", action: "deny", command: "x" },
      ],
    });
    const { config, warnings } = loadConfig(agentDir, cwd);
    expect(config.rules[0]?.id).toBe("project-rule");
    expect(warnings.length).toBe(4);
    expect(config.rules.length).toBe(DEFAULT_RULES.length + 1);
  });

  it("ignores an unparseable file and keeps the defaults", () => {
    writeFileSync(join(agentDir, "tool-gate.json"), "{ not json");
    const { config, sources } = loadConfig(agentDir, cwd);
    expect(sources).toEqual([]);
    expect(config.rules.length).toBe(DEFAULT_RULES.length);
  });

  it("disables logging only when either file says false", () => {
    writeUser({ log: false });
    expect(loadConfig(agentDir, cwd).config.log).toBe(false);

    writeUser({});
    expect(loadConfig(agentDir, cwd).config.log).toBe(true);
  });

  it("rejects an unknown mode and falls back to enforce", () => {
    writeUser({ mode: "sometimes" });
    expect(loadConfig(agentDir, cwd).config.mode).toBe("enforce");
  });

  for (const settings of [
    { backend: "jev" },
    { backend: "opencode-jev", model: "@current" },
    { backend: "opencode-jev", model: "jev-latest" },
    { minAllowProbability: -0.1 },
    { minAllowProbability: 1.1 },
    { fallbackModel: "" },
    { fallbackModel: "   " },
    { maxPerSession: "infinite" },
    { maxPerSession: "unlimited" },
    { maxPerSession: "200" },
    { maxPerSession: null },
    { maxPerSession: -2 },
    { maxPerSession: 1.5 },
  ]) {
    it(`fails closed on invalid classifier configuration ${JSON.stringify(settings)}`, () => {
      writeUser({ mode: "observe", classifier: { enabled: true, ...settings } });
      const { config, warnings } = loadConfig(agentDir, cwd);
      expect(warnings.length).toBeGreaterThan(0);
      expect(config.mode).toBe("enforce");
      expect(config.defaultAction).toBe("deny");
      expect(config.classifier.enabled).toBe(false);
    });
  }
});

describe("default rule set", () => {
  it("has unique ids and complete reasons", () => {
    const ids = DEFAULT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_RULES.every((rule) => rule.reason.length > 10)).toBe(true);
  });

  it("covers both command and path rules", () => {
    expect(DEFAULT_RULES.some((rule) => rule.command !== undefined)).toBe(true);
    expect(DEFAULT_RULES.some((rule) => rule.paths !== undefined)).toBe(true);
  });
});

describe("the tracked policy file", () => {
  it("loads without warnings and keeps its custom rules", () => {
    const { config, warnings, sources } = loadConfig(REPO_OMP, "/nonexistent-cwd");
    expect(warnings).toEqual([]);
    expect(sources.some((source) => source.endsWith("omp/tool-gate.json"))).toBe(true);
    const ids = config.rules.map((rule) => rule.id);
    expect(ids.slice(0, 3)).toEqual([
      "protect-config-backups",
      "no-plugin-install-without-marketplace",
      "stop-herdr-server",
    ]);
    expect(config.mode).toBe("enforce");
    expect(config.classifier).toMatchObject({ backend: "opencode-jev", model: "jev-1.13-free", fallbackModel: "@current", minAllowProbability: 0.9, maxPerSession: -1, onError: "prompt" });
  });
});
