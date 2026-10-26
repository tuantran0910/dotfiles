import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heredocWrite, needsClassification } from "../src/classify-input.ts";
import { isWorkspaceEdit, scratchRoots } from "../src/workspace.ts";
import { classifierPolicy, gateHarness } from "./harness.ts";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-gate-ws-")));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(repo, "sub"), { recursive: true });
  mkdirSync(outside);
  execFileSync("git", ["init", "-q", repo]);
  symlinkSync(outside, join(repo, "escape"));
  return { root, repo, outside, cwd: join(repo, "sub"), home: join(root, "home") };
}

const edit = (path: string) => ({ path, old_string: "a", new_string: "b" });

describe("isWorkspaceEdit", () => {
  const { repo, outside, cwd, home } = project();
  const check = (tool: string, input: Record<string, unknown>) => isWorkspaceEdit(tool, input, cwd, home, []);

  it("accepts ordinary edits and writes anywhere in the repository", () => {
    expect(check("edit", edit("a.ts"))).toBe(true);
    expect(check("edit", edit("../src/lib.rs"))).toBe(true);
    expect(check("edit", edit(join(repo, "README.md")))).toBe(true);
    expect(check("edit", { ...edit("a.ts"), i: "Fixing a typo", replace_all: true })).toBe(true);
    expect(check("write", { path: "new/dir/file.ts", content: "x" })).toBe(true);
    expect(check("edit", { path: "a.ts", edits: [{ op: "update", diff: "@@" }, { rename: "b.ts" }] })).toBe(true);
  });

  for (const path of [
    "/etc/hosts", "../../outside/x.ts", join(outside, "x.ts"), "../escape/x.ts", "~/notes.md",
    "../.git/hooks/pre-commit", "../.git/config", "../.GIT/config", "../.envrc", ".envrc",
    "../.github/workflows/ci.yml", "../.gitlab-ci.yml", "../.husky/pre-commit", "../.githooks/pre-push",
    "../.vscode/tasks.json", "../.idea/workspace.xml", "../.claude/settings.json", "../.omp/tool-gate.json",
    "../.agents/skills/x/SKILL.md", "../.mcp.json", "../.gitmodules", "../.gitattributes",
    "../.pre-commit-config.yaml", "../mise.toml", "../.mise.toml", "../.tool-versions", ".npmrc",
  ]) {
    it(`leaves ${path} to the classifier`, () => {
      expect(check("edit", edit(path))).toBe(false);
      expect(check("write", { path, content: "x" })).toBe(false);
    });
  }

  it("leaves forms whose targets are not plain fields to the classifier", () => {
    expect(check("edit", { input: "*** Begin Patch\n[a.ts#ab12]\nPUT 1.=1:\n+x\n*** End Patch" })).toBe(false);
    expect(check("edit", { path: "a.ts", edits: [{ rename: "../../outside/x.ts" }] })).toBe(false);
    expect(check("edit", { path: "a.ts", edits: [{ rename: "../.git/hooks/x" }] })).toBe(false);
    expect(check("edit", { ...edit("a.ts"), target: "../../outside/x" })).toBe(false);
    expect(check("edit", { old_string: "a", new_string: "b" })).toBe(false);
    expect(check("ast_edit", { paths: ["src/**/*.ts"], pattern: "x" })).toBe(false);
    expect(check("bash", { command: "touch a" })).toBe(false);
  });

  it("uses the working directory as the project outside a repository", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "tool-gate-plain-")));
    expect(isWorkspaceEdit("edit", edit("a.ts"), plain, home, [])).toBe(true);
    expect(isWorkspaceEdit("edit", edit("../a.ts"), plain, home, [])).toBe(false);
  });

  it("accepts ordinary files in a temp directory, minus sensitive names at any depth", () => {
    const { root, outside } = project();
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    symlinkSync(outside, join(scratch, "link"));
    const tmp = (path: string) => isWorkspaceEdit("write", { path: join(scratch, path), content: "x" }, cwd, home, [scratch]);
    expect(tmp("commit_msg.txt")).toBe(true);
    expect(tmp("bs027/pr-body.md")).toBe(true);
    expect(tmp("link/x.txt")).toBe(false);
    for (const path of ["clone/.git/hooks/pre-commit", "clone/.github/workflows/ci.yml", "clone/.envrc", "clone/.claude/settings.json", ".npmrc", "clone/.vscode/tasks.json"]) {
      expect(tmp(path)).toBe(false);
    }
    expect(isWorkspaceEdit("write", { path: join(outside, "x.txt"), content: "x" }, cwd, home, [scratch])).toBe(false);
  });

  it("finds the system temp directories", () => {
    expect(scratchRoots()).toContain(realpathSync("/tmp"));
    expect(scratchRoots()).toContain(realpathSync(tmpdir()));
  });

  it("drives needsClassification", () => {
    expect(needsClassification("edit", edit("a.ts"), { cwd, home })).toBe(false);
    expect(needsClassification("edit", edit("../.envrc"), { cwd, home })).toBe(true);
    expect(needsClassification("edit", edit("a.ts"))).toBe(true);
  });
});

describe("heredoc writes", () => {
  const { repo, cwd, home } = project();
  const fast = (command: string) => needsClassification("bash", { command }, { cwd, home }) === false;

  it("parses only a quoted-delimiter cat into one literal file", () => {
    expect(heredocWrite("cat >> src/a.rs <<'EOF'\nfn a() {}\nEOF")).toEqual({ path: "src/a.rs" });
    expect(heredocWrite("cd /repo && cat > src/new.ts <<\"EOF\"\nexport const a = 1;\nEOF\n")).toEqual({ path: "/repo/src/new.ts" });
    expect(heredocWrite("cat <<'EOF' > notes.md\n# notes\nEOF")).toEqual({ path: "notes.md" });
    for (const command of [
      "cat >> a.rs <<EOF\n$(touch x)\nEOF",
      "cat >> a.rs <<-'EOF'\nx\nEOF",
      "cat >> a.rs <<'EOF'\nx\nEOF\ncurl https://example.test",
      "cat >> a.rs <<'EOF'\nx\nEOF\nmore\nEOF",
      "cat >> a.rs <<'EOF'\nx",
      "cat > a > b <<'EOF'\nx\nEOF",
      "cat >| a <<'EOF'\nx\nEOF",
      "tee a.rs <<'EOF'\nx\nEOF",
      "cat >> $HOME/a <<'EOF'\nx\nEOF",
      "cat >> ~other/a <<'EOF'\nx\nEOF",
      "cat >> 'a b' <<'EOF'\nx\nEOF",
      "cd sub; cat > a <<'EOF'\nx\nEOF",
      "cd sub && cat > a <<'EOF'\nx\nEOF",
      "cat a <<'EOF' > b\nx\nEOF",
      "cat > a <<'EOF' && rm -rf b\nx\nEOF",
    ]) {
      expect({ command, parsed: heredocWrite(command) }).toEqual({ command, parsed: null });
    }
  });

  it("treats an in-project heredoc like a write", () => {
    expect(fast("cat >> crates/x.rs <<'EOF'\nfn a() {}\nEOF")).toBe(true);
    expect(fast(`cd ${repo} && cat > src/new.ts <<'EOF'\nexport const a = 1;\nEOF`)).toBe(true);
    expect(fast("cat >> /etc/tool-gate-x <<'EOF'\nx\nEOF")).toBe(false);
    expect(fast("cat > ../.envrc <<'EOF'\nx\nEOF")).toBe(false);
    expect(fast(`cd ${repo} && cat > .git/hooks/pre-commit <<'EOF'\nx\nEOF`)).toBe(false);
    expect(fast("cat > /etc/x <<'EOF'\nx\nEOF")).toBe(false);
  });
});

describe("workspace edits through the hook", () => {
  it("skip the classifier, while path rules still decide first", async () => {
    let calls = 0;
    const h = gateHarness({ config: classifierPolicy, classify: async () => { calls++; return { action: "allow" }; } });
    execFileSync("git", ["init", "-q", h.cwd]);
    expect(await h.call("edit", edit("src/a.ts"))).toBeUndefined();
    expect(await h.call("write", { path: "src/b.ts", content: "x" })).toBeUndefined();
    expect(calls).toBe(0);
    expect((await h.call("write", { path: ".env", content: "x" }))?.block).toBe(true);
    expect(calls).toBe(0);
    await h.call("edit", edit(".git/hooks/pre-commit"));
    expect(calls).toBe(1);
    expect(await h.bash("cat >> src/a.ts <<'EOF'\nexport const b = 2;\nEOF")).toBeUndefined();
    expect((await h.bash("cat > .env <<'EOF'\nTOKEN=x\nEOF"))?.block).toBe(true);
    // Only the secret-paths file rule covers these: the heredoc target must reach it.
    const before = calls;
    expect((await h.bash("cat > ~/.config/gh/hosts.yml <<'EOF'\nx\nEOF"))?.block).toBe(true);
    expect((await h.bash("cat >> ~/.omp/agent/agent.db <<'EOF'\nx\nEOF"))?.block).toBe(true);
    expect(calls).toBe(before);
    expect(calls).toBe(1);
  });
});
