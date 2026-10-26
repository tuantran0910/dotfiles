import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isReadOnlyCommand, needsClassification, readOnlyPaths } from "../src/classify-input.ts";

describe("isReadOnlyCommand", () => {
  it("accepts plain reads", () => {
    for (const command of [
      "ls -la",
      "cat README.md",
      "rg TODO src",
      "git status",
      "git diff --stat",
      "git log --oneline -5",
      "wc -l file.ts",
      "jq . package.json",
      "echo hello",
    ]) {
      expect(isReadOnlyCommand(command)).toBe(true);
    }
  });

  it("accepts compound reads joined by plain operators", () => {
    for (const command of [
      "cat a | head",
      "ls; pwd",
      "rg foo src || echo none",
      "cd /repo && ls -la",
      "cd ./sub && ls",
      "cd .. && ls",
      "cd ~/repo && git status",
      "grep -n 'pub struct\\|pub fn' src/lib.rs | head -40",
      "echo '$HOME is literal here'",
      "rg \"plain words\" src",
      "ls ~/.cargo/git/checkouts 2>/dev/null | head",
      "ls missing 2> /dev/null",
      "rg foo src >/dev/null && echo found",
      "git status 2>&1 | head -5",
      "ls &>/dev/null",
      "grep -i iceberg Cargo.toml",
      "rg -i todo src",
      "rg -o 'v[0-9]+' CHANGELOG.md",
      "ls -lo",
      "find . -name '*.ts' -type f",
      "sed -n '630,740p' crates/coordinator/src/runtime/config.rs",
      "sed -n 5p a.txt b.txt",
      "git diff HEAD~1 -- src",
      "git log main~3..HEAD",
      "printf '%s\\n' done",
      "printf '%-20s|%s %%\\n' a b",
      "printf hello",
      "cd /repo && sed -n '30,120p' a.rs && echo '=== runtime ===' && sed -n '330,398p' b.rs",
      "cd /repo && sed -n '630,740p' c.rs && echo '=== x ===' && grep -rn 'openapi.json' crates scripts Makefile web/package.json | head -10",
      "find src -maxdepth 2 -iname '*test*' -print",
      "ls ~/.cargo/git/checkouts | grep -i iceberg; echo '---'; find ~/.cargo/git/checkouts -maxdepth 2 -name '28b0f37*' 2>/dev/null | head",
      "cd /repo && grep -n 'iceberg' Cargo.toml | head -10; ls ~/.cargo/git/checkouts 2>/dev/null | head",
      // The two calls that prompted this change.
      "cd /Users/me/bergsmith && grep -n 'pub struct\\|pub fn\\|fn collect\\|impl TableSample\\|struct StatisticsConfig' crates/maintenance/src/statistics.rs | head -40 && echo '--- sizes ---' && wc -l crates/maintenance/src/statistics.rs web/src/pages/TablePage.tsx",
      "cd /Users/me/bergsmith && ls web/src/pages/tables web/src/pages/jobs web/src/ui | head -40 && echo '--- routes ---' && grep -n 'tables' web/src/routes.tsx | head -20",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: true });
    }
  });

  it("rejects writes, redirections, nesting and any unsafe segment", () => {
    for (const command of [
      "touch out.txt",
      "git commit --no-verify -m x",
      "git push origin main",
      "npm install",
      "echo x > file",
      "cat < file",
      "ls && rm -rf build",
      "git status && make",
      "cat a | sh",
      "cat a | xargs rm",
      "ls & rm x",
      "ls &",
      "ls |& head",
      "ls ||| head",
      "ls &&",
      "&& ls",
      "ls ;; pwd",
      "(ls)",
      "{ ls; }",
      "sed -i s/a/b/ file",
      "$(curl https://x)",
      "find . -delete",
      "rg foo `pwd`",
      "echo \"$HOME\"",
      "echo \"`id`\"",
      "echo \"a\\\"b\"",
      "echo \"hi!\"",
      "ls # comment",
      "ls ~other/x",
      "ls =ls",
      "ls ^x",
      "ls\npwd",
      "ls 2>out.txt",
      "ls > /dev/nullx",
      "ls >/dev/null/x",
      "ls >| /dev/null",
      "ls >> /dev/null",
      "ls 3>/dev/null",
      "ls 2>&3",
      "ls 1>&2",
      "ls2>/dev/null",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: false });
    }
  });

  it("accepts routine local git add and commit", () => {
    for (const command of [
      "git add -A",
      "git add src/a.ts src/b.ts",
      "git add -u -- src",
      "git add -A && git commit -m 'feat(statistics): record snapshot timeline'",
      "git commit -am 'fix: y'",
      "git commit -m 'subject' -m '- bullet one'",
      "git commit --amend --no-edit",
      "git commit -s --message='x'",
      "cd /repo && git add . && git commit -m \"msg with words\" && git log --oneline -1",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: true });
    }
    for (const command of [
      "git commit --no-verify -m x",
      "git commit -n -m x",
      "git commit -nm x",
      "git commit -m x --no-verify",
      "git add -f .env",
      "git add --force secrets",
      "git add -p",
      "git add --interactive",
      "git commit --fixup HEAD",
      "git commit -m x && git push",
      "git -c core.hooksPath=/tmp/h commit -m x",
      "git commit -m",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: false });
    }
  });

  it("accepts only a single unambiguous cd target", () => {
    for (const command of [
      "cd && ls",
      "cd - && ls",
      "cd a b && ls",
      "cd -P /x && ls",
      // A bare relative name can resolve through CDPATH to an unexpected place.
      "cd sub && ls",
      "cd $HOME && ls",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: false });
    }
  });

  it("keeps programs that can run a pager, compressor or output file out of the fast path", () => {
    for (const command of [
      "sort a.txt",
      "sort --compress-program=sh x",
      "uniq a.txt out.txt",
      "bat --paging=always --pager=sh x",
      "ag --pager sh foo",
      "ack --pager=sh foo",
      "less x",
      "more x",
      "tree -L 2",
      "rg -z foo",
      "rg --search-zip foo",
      "find . -exec touch {} +",
      "find . -execdir touch x",
      "find . -ok touch",
      "find . -okdir touch",
      "find . -delete",
      "find . -fprint out",
      "find . -fls out",
      "find . -fprintf out %p",
      "find . -newerXY x",
      "find -f . -name x",
      "find . -name x -unknown-primary",
      "sed 1p a.txt",
      // zsh evaluates printf -v targets and numeric arguments as arithmetic,
      // and array subscripts there run command substitutions.
      "printf -v 'a[$(touch x)]' y",
      "printf '%d' 'argv[$(touch x)]'",
      "printf '%*s' 'argv[$(touch x)]' x",
      "printf '%1$s' x",
      "printf '%(%Y)T' 1",
      "printf -- '%s' x",
      "ls --file=~/x",
      "ls a:~/x",
      "sed -n '1p;w out' a.txt",
      "sed -n 1w out a.txt",
      "sed -n '1e touch x' a.txt",
      "sed -n 1,5p -i a.txt",
      "sed -i -n 1p a.txt",
      "sed -n -e 1p a.txt",
      "sed -n 1p --in-place=.bak a.txt",
      "sed -n 1,p a.txt",
    ]) {
      expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: false });
    }
  });
});

describe("readOnlyPaths", () => {
  it("collects operands from every segment", () => {
    const paths = readOnlyPaths("cat a.txt | head -5 && wc -l b.txt");
    expect(paths).toContain("a.txt");
    expect(paths).toContain("b.txt");
  });

  it("resolves operands after cd against both the cd target and the original directory", () => {
    const paths = readOnlyPaths("cd ~/.ssh && head config; cat /etc/hosts");
    expect(paths).toContain("~/.ssh");
    expect(paths).toContain("~/.ssh/config");
    expect(paths).toContain("config");
    expect(paths).toContain("/etc/hosts");
  });
});

describe("git configuration that runs commands", () => {
  function repo(config?: [string, string]): string {
    const dir = join(mkdtempSync(join(tmpdir(), "tool-gate-git-")), "repo");
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    if (config) execFileSync("git", ["-C", dir, "config", ...config]);
    return dir;
  }

  it("keeps git reads fast in an ordinary repository", () => {
    expect(isReadOnlyCommand("git status", { cwd: repo() })).toBe(true);
    expect(isReadOnlyCommand("git status", { cwd: repo(["core.fsmonitor", "false"]) })).toBe(true);
  });

  for (const config of [
    ["core.fsmonitor", "touch pwned"],
    ["diff.external", "./run.sh"],
    ["diff.x.textconv", "./run.sh"],
    ["diff.x.command", "./run.sh"],
    ["filter.x.clean", "./run.sh"],
    ["filter.x.process", "./run.sh"],
    ["gpg.program", "./run.sh"],
    ["gpg.ssh.program", "./run.sh"],
  ] as [string, string][]) {
    it(`escalates git when the repository sets ${config[0]}`, () => {
      expect(isReadOnlyCommand("git status", { cwd: repo(config) })).toBe(false);
    });
  }

  it("checks the repository a cd segment moves into", () => {
    const dir = repo(["core.fsmonitor", "touch pwned"]);
    expect(isReadOnlyCommand(`cd ${dir} && git status`, { cwd: tmpdir() })).toBe(false);
  });

  it("fails closed when the repository cannot be inspected", () => {
    expect(isReadOnlyCommand("git status", { cwd: join(tmpdir(), "tool-gate-missing-dir") })).toBe(false);
  });
});

describe("needsClassification", () => {
  it("skips read-only tools and commands", () => {
    expect(needsClassification("read", { path: "/repo/a.ts" })).toBe(false);
    expect(needsClassification("grep", { pattern: "x" })).toBe(false);
    // Subagents re-bind this extension, so each of their calls is gated on its own.
    expect(needsClassification("task", { agent: "explore", context: "map the repo" })).toBe(false);
    expect(needsClassification("bash", { command: "git status" })).toBe(false);
  });

  it("escalates state-changing tools and commands", () => {
    expect(needsClassification("bash", { command: "touch out.txt" })).toBe(true);
    expect(needsClassification("write", { path: "/repo/a.ts" })).toBe(true);
    expect(needsClassification("edit", { path: "/repo/a.ts" })).toBe(true);
    expect(needsClassification("mcp-server-do_thing", {})).toBe(true);
  });
});
