/**
 * Offline evaluation of the deterministic layers: rules, the read-only fast
 * path and the hook around them. The classifier is stubbed; nothing is sent to
 * a model.
 *
 *   bun scripts/evaluate-gate.ts [--sections accuracy,replay,fuzz,sandbox,perf] [--transcripts DIR ...]
 *                                [--fuzz N] [--sandbox N] [--output PATH]
 *
 * Sections
 *   accuracy   labelled fixtures through the real hook (test/fixtures/gate-evaluation.ts)
 *   replay     real agent commands from transcripts, never executed outside the sandbox
 *   fuzz       generated and mutated commands; every fast-path acceptance runs in zsh
 *              with stubbed programs and an empty PATH, and must run exactly the
 *              commands the parser saw, with no file created
 *   sandbox    fast-path commands run with real binaries under sandbox-exec (macOS),
 *              which denies every file write and all network; a denied write is a finding
 *   perf       hook latency, parser throughput, git config probe cost, ReDoS probes
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { isReadOnlyCommand, isReadOnlySegment, parseSegments } from "../src/classify-input.ts";
import { DEFAULT_RULES } from "../src/config.ts";
import { compileCommand, globToRegExp } from "../src/match.ts";
import { GATE_EVALUATION, type GateCase, type Outcome } from "../test/fixtures/gate-evaluation.ts";
import { gateHarness } from "../test/harness.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const options = (name: string) => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]!] : []);
const FUZZ = Number(option("--fuzz") ?? 20000);
const SANDBOX = Number(option("--sandbox") ?? 1500);
const OUTPUT = option("--output");
const TRANSCRIPTS = options("--transcripts");
if (TRANSCRIPTS.length === 0) TRANSCRIPTS.push(join(homedir(), ".claude/projects"), join(homedir(), ".omp/agent/sessions"));

const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };
const log = (line: string) => console.log(line);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const round = (value: number) => Math.round(value * 1000) / 1000;
const latency = (values: number[]) => ({ n: values.length, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), p99: round(percentile(values, 0.99)), max: round(Math.max(0, ...values)) });

/** Deterministic PRNG so a finding can be reproduced from the seed. */
function prng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── the hook under test ──────────────────────────────────────────────────────
let classified = 0;
let prompted = false;
const freshGate = () => gateHarness({
  config: { classifier: { enabled: true, onError: "deny", timeoutMs: 500, maxPerSession: -1 } },
  classify: async () => { classified++; return { action: "allow" }; },
});
let gate = freshGate();
const ui = { notify() {}, approve: async () => { prompted = true; return "deny"; } };

async function outcome(tool: string, input: Record<string, unknown>): Promise<{ outcome: Outcome; ms: number }> {
  const before = classified;
  prompted = false;
  const started = performance.now();
  const result = await gate.call(tool, input, { hasUI: true, ui });
  const ms = performance.now() - started;
  if (classified > before) return { outcome: "classify", ms };
  if (prompted) return { outcome: "prompt", ms };
  return { outcome: result?.block ? "deny" : "fast", ms };
}

/** Why a command missed the fast path, for ranking the next improvement. */
function missReason(command: string): string {
  const segments = parseSegments(command);
  if (segments === null) {
    if (/\$\(|`/.test(command)) return "syntax: command substitution";
    if (/\$/.test(command)) return "syntax: parameter expansion";
    if (/[\r\n]/.test(command)) return "syntax: newline";
    if (/<<|<\(/.test(command)) return "syntax: heredoc/process substitution";
    if (/[<>]/.test(command)) return "syntax: redirection";
    if (/[*?\[\]{}]/.test(command)) return "syntax: glob/brace";
    if (/\\/.test(command)) return "syntax: backslash";
    if (/[()]/.test(command)) return "syntax: subshell/grouping";
    return "syntax: other";
  }
  const failing = segments.find(words => !isReadOnlySegment(words));
  if (failing === undefined) return "git repository config";
  const program = (failing[0] ?? "").replace(/^.*\//, "");
  const readers = ["ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "pwd", "whoami", "date", "which", "type", "echo", "printf", "rg", "grep", "git", "jq", "tr", "cut", "diff", "comm", "realpath", "basename", "dirname", "cd"];
  if (program === "git") return `git ${failing[1] ?? ""}`.trim();
  return readers.includes(program) ? `flags: ${program}` : `program: ${program}`;
}

// ── 1. accuracy on labelled fixtures ─────────────────────────────────────────
async function accuracy() {
  const rows: { name: string; category: string; expect: Outcome[]; got: Outcome; ms: number }[] = [];
  for (const fixture of GATE_EVALUATION) {
    // A repeated call would hit the verdict cache and look like a fast-path pass.
    gate = freshGate();
    const tool = fixture.tool ?? "bash";
    const input = fixture.input ?? { command: fixture.command };
    const { outcome: got, ms } = await outcome(tool, input);
    rows.push({ name: fixture.name, category: fixture.category, expect: fixture.expect, got, ms });
  }
  const failures = rows.filter(row => !row.expect.includes(row.got));
  const unsafeFast = failures.filter(row => row.got === "fast");
  const byCategory = Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
    const subset = rows.filter(row => row.category === category);
    return [category, `${subset.filter(row => row.expect.includes(row.got)).length}/${subset.length}`];
  }));
  report["accuracy"] = { total: rows.length, passed: rows.length - failures.length, unsafeFast: unsafeFast.length, byCategory, failures, latencyMs: latency(rows.map(row => row.ms)) };
  log(`accuracy: ${rows.length - failures.length}/${rows.length} as labelled, ${unsafeFast.length} unsafe fast-path acceptances`);
  for (const [category, score] of Object.entries(byCategory)) log(`  ${category.padEnd(26)} ${score}`);
  for (const row of failures) log(`  MISS [${row.category}] ${JSON.stringify(row.name)} expected ${row.expect.join("|")} got ${row.got}`);
}

// ── 2. replay of real agent commands ─────────────────────────────────────────
function transcriptCommands(): { command: string; cwd?: string }[] {
  const found = new Map<string, { command: string; cwd?: string }>();
  const visit = (path: string) => {
    let entries: string[];
    try { entries = readdirSync(path); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry);
      let stat; try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) { visit(full); continue; }
      if (!entry.endsWith(".jsonl")) continue;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.includes('"Bash"') && !line.includes('"bash"')) continue;
        let record: any; try { record = JSON.parse(line); } catch { continue; }
        for (const part of record?.message?.content ?? []) {
          // Claude Code: tool_use/Bash/input; omp: toolCall/bash/arguments.
          const command = part?.type === "tool_use" && part.name === "Bash" ? part.input?.command
            : part?.type === "toolCall" && part.name === "bash" ? part.arguments?.command : undefined;
          if (typeof command === "string" && !found.has(command)) found.set(command, { command, cwd: record.cwd });
        }
      }
    }
  };
  for (const root of TRANSCRIPTS) visit(root);
  return [...found.values()];
}

async function previousFastPath(): Promise<((command: string) => boolean) | null> {
  // The fast path before compound support, for a before/after comparison.
  try {
    const source = execFileSync("git", ["show", "154aa70:plugins/tool-gate/src/classify-input.ts"], { cwd: import.meta.dir, encoding: "utf8" });
    const path = join(mkdtempSync(join(tmpdir(), "tool-gate-prev-")), "classify-input.ts");
    writeFileSync(path, source);
    const previous = await import(path);
    return command => previous.isReadOnlyCommand(command);
  } catch { return null; }
}

let replayFast: { command: string; cwd?: string }[] = [];
async function replay() {
  const commands = transcriptCommands();
  const previous = await previousFastPath();
  const counts: Record<Outcome, number> = { fast: 0, classify: 0, prompt: 0, deny: 0 };
  const reasons = new Map<string, number>();
  const ms: number[] = [];
  let previousFast = 0;
  for (const [index, entry] of commands.entries()) {
    if (index % 2000 === 0) log(`  replay ${index}/${commands.length}`);
    const result = await outcome("bash", { command: entry.command });
    counts[result.outcome]++;
    ms.push(result.ms);
    if (result.outcome === "fast") replayFast.push(entry);
    if (result.outcome === "classify") reasons.set(missReason(entry.command), (reasons.get(missReason(entry.command)) ?? 0) + 1);
    if (previous && (result.outcome === "fast" || result.outcome === "classify") && previous(entry.command)) previousFast++;
  }
  const total = commands.length;
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  const fastPrograms = new Map<string, number>();
  for (const { command } of replayFast) for (const words of parseSegments(command) ?? []) {
    const key = words[0] === "git" ? `git ${words[1]}` : words[0]!;
    fastPrograms.set(key, (fastPrograms.get(key) ?? 0) + 1);
  }
  report["replay"] = {
    distinctCommands: total, counts,
    fastRate: round(counts.fast / Math.max(1, total)),
    previousFastRate: previous ? round(previousFast / Math.max(1, total)) : null,
    classifierReasons: Object.fromEntries(top),
    fastPrograms: Object.fromEntries([...fastPrograms.entries()].sort((a, b) => b[1] - a[1])),
    latencyMs: latency(ms),
  };
  log(`replay: ${total} distinct real commands → fast ${counts.fast} (${(100 * counts.fast / Math.max(1, total)).toFixed(1)}%), classifier ${counts.classify}, rule prompt ${counts.prompt}, rule deny ${counts.deny}`);
  if (previous) log(`  previous fast path (154aa70) would have accepted ${previousFast} (${(100 * previousFast / Math.max(1, total)).toFixed(1)}%)`);
  log("  top reasons a command still reaches the classifier:");
  for (const [reason, count] of top.slice(0, 15)) log(`    ${String(count).padStart(6)}  ${reason}`);
}

// ── 3. fuzzing with a zsh execution oracle ───────────────────────────────────
const STUBS = ["ls", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "pwd", "whoami", "date", "which", "type", "echo", "printf", "rg", "grep", "git", "jq", "tr", "cut", "diff", "comm", "realpath", "basename", "dirname", "find", "sed", "cd"];
const ZSH_PRELUDE = [
  // Every allowed program is a function that records its argv and does nothing else.
  `for f in ${STUBS.join(" ")}; do functions[$f]='local r=$0; for a in "$@"; do r+=$'"'"'\\x1f'"'"'$a; done; print -rn -u3 -- "$r"$'"'"'\\x1e'"'"'; return 0'; done`,
  // Anything else that tries to run is recorded too.
  `command_not_found_handler() { print -rn -u3 -- "!notfound:$1"$'\\x1e'; return 127 }`,
].join("\n");

interface Probe { command: string; source: string }
interface Finding { command: string; source: string; problem: string; detail?: string }

/** Builtins of zsh/bash in the fast-path list. With `realBuiltins` they run for
 * real, so builtin semantics (printf arithmetic, cd hooks) are exercised too. */
const BUILTINS = new Set(["echo", "printf", "pwd", "cd", "type", "which"]);

function runOracle(probe: Probe, realBuiltins = false): Promise<Finding | null> {
  const parsed = parseSegments(probe.command);
  if (parsed === null) return Promise.resolve(null);
  // `/usr/bin/git` runs the real binary, not the stub, so it leaves no argv record;
  // the empty PATH and the file check still cover it.
  const segments = parsed.filter(words => !words[0]!.includes("/") && !(realBuiltins && BUILTINS.has(words[0]!)));
  const prelude = realBuiltins ? ZSH_PRELUDE.replace(STUBS.join(" "), STUBS.filter(name => !BUILTINS.has(name)).join(" ")) : ZSH_PRELUDE;
  const root = mkdtempSync(join(tmpdir(), "tool-gate-fuzz-"));
  const home = join(root, "home"); const work = join(root, "work"); const bin = join(root, "bin");
  mkdirSync(home); mkdirSync(work); mkdirSync(bin);
  const recordFile = join(root, "argv");
  const script = `${prelude}\nexec 3>${recordFile}\n${probe.command}`;
  return new Promise(resolve => {
    const child = spawn("/bin/zsh", ["-f", "-c", script], { cwd: work, env: { HOME: home, PATH: bin }, stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", () => {
      const created = [...readdirSync(work), ...readdirSync(home), ...readdirSync(bin)];
      const records = existsSync(recordFile) ? readFileSync(recordFile, "utf8").split("\x1e").filter(Boolean) : [];
      const expected = segments.map(words => words.map(word => word === "~" ? home : word.startsWith("~/") ? home + word.slice(1) : word).join("\x1f"));
      const remaining = [...expected];
      for (const record of records) {
        if (record.startsWith("!notfound:")) return resolve({ ...probe, problem: "ran a program the parser did not see", detail: record.slice(10) });
        const index = remaining.indexOf(record);
        if (index === -1) return resolve({ ...probe, problem: "argv differs from the parser's words", detail: JSON.stringify({ zsh: record.split("\x1f"), parser: expected.map(e => e.split("\x1f")) }) });
        remaining.splice(index, 1);
      }
      if (created.length > 0) return resolve({ ...probe, problem: "created a file", detail: created.join(", ") });
      if (records.length === 0 && segments.length > 0 && !realBuiltins) return resolve({ ...probe, problem: "zsh ran nothing although the parser accepted it", detail: stderr.slice(0, 200) });
      resolve(null);
    });
  });
}

async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!); }
  }));
  return results;
}

function generated(count: number, random: () => number): Probe[] {
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const programs = [...STUBS, "sh", "touch", "eval", "exec", "rm", "xargs", "env", "command", "builtin", "source", ".", "nohup", "sort", "sed", "find", "awk", "python3", "zsh"];
  const flags = ["-n", "-la", "-z", "-uz", "--pre=sh", "--pre", "-o", "-o out", "--output=out", "-i", "-c", "-e", "--upload-pa=sh", "--compress-program=sh", "-S", "-C", "-v", "--", "-", "-1", "--ext-diff", "--textconv", "-p"];
  const words = ["file", "a.txt", "~/x", "~", "~root", "/etc/hosts", "'$HOME'", "\"$HOME\"", "\"a b\"", "'a;b'", "$IFS", "${x}", "$(id)", "`id`", "*", "?", "[a]", "{a,b}", "=ls", "^x", "#c", "!x", ".", "..", "./x", "\"`id`\"", "'it''s'", "\"\\\"\"", "a\\ b", "x=y", "status", "log", "diff", "show", "'\\x41'", " ", "；", "%x", "@x", "+x", ",x", ":x", "'argv[$(touch x)]'", "'a[$(touch x)]'", "'%d'", "'%*s'", "'%s'", "'%c'", "HEAD~1", "a=~/x", "-v", "-P", "+1"];
  const operators = ["&&", "||", ";", "|", "&", "|&", ";;", ">", ">>", ">|", "<", "<<<", "2>/dev/null", "2>&1", "&>/dev/null", "> /dev/null", "2>x", "1>&2", ">/dev/nullx", "(", ")", "{", "}", "\n", "\r"];
  const joins = [" ", " ", " ", "", "\t", "  "];
  const out: Probe[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const segments = 1 + Math.floor(random() * 3);
    for (let s = 0; s < segments; s++) {
      parts.push(pick(programs));
      const n = Math.floor(random() * 4);
      for (let k = 0; k < n; k++) parts.push(random() < 0.4 ? pick(flags) : pick(words));
      if (s < segments - 1 || random() < 0.2) parts.push(pick(operators));
    }
    out.push({ command: parts.map((part, index) => index === 0 ? part : pick(joins) + part).join(""), source: "grammar" });
  }
  return out;
}

function mutated(seeds: string[], count: number, random: () => number): Probe[] {
  const alphabet = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "\t", "\n", "\r", " ", " ", "；", "​", "$(", "${", "`", "&&", "||", ">", "2>", "<("];
  const out: Probe[] = [];
  for (let i = 0; i < count; i++) {
    let command = seeds[Math.floor(random() * seeds.length)]!;
    const edits = 1 + Math.floor(random() * 3);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(random() * (command.length + 1));
      const roll = random();
      if (roll < 0.6) command = command.slice(0, at) + alphabet[Math.floor(random() * alphabet.length)] + command.slice(at);
      else if (roll < 0.8) command = command.slice(0, at) + command.slice(at + 1);
      else command = command.slice(0, at) + command.slice(at, at + 4) + command.slice(at);
    }
    out.push({ command, source: "mutation" });
  }
  return out;
}

async function fuzz() {
  if (!existsSync("/bin/zsh")) { log("fuzz: skipped, /bin/zsh not found"); return; }
  const random = prng(0x70019a7e);
  const seeds = [...GATE_EVALUATION.filter(c => c.expect.includes("fast") && c.command).map(c => c.command!), ...replayFast.slice(0, 500).map(e => e.command)];
  const probes = [...generated(Math.floor(FUZZ / 2), random), ...mutated(seeds, Math.ceil(FUZZ / 2), random)];
  const accepted = probes.filter(probe => isReadOnlyCommand(probe.command));
  const started = performance.now();
  const stubbed = (await pool(accepted, 16, probe => runOracle(probe))).filter((finding): finding is Finding => finding !== null);
  const builtins = (await pool(accepted, 16, probe => runOracle(probe, true))).filter((finding): finding is Finding => finding !== null)
    .map(finding => ({ ...finding, problem: `real builtins: ${finding.problem}` }));
  // Repeat each finding once: pipelines race, so a lone argv mismatch may be ordering noise.
  const confirmed = (await pool([...stubbed, ...builtins], 8, finding => runOracle(finding, finding.problem.startsWith("real builtins"))))
    .filter((finding): finding is Finding => finding !== null);
  report["fuzz"] = { generated: probes.length, acceptedByFastPath: accepted.length, executed: accepted.length * 2, findings: confirmed, seconds: round((performance.now() - started) / 1000) };
  log(`fuzz: ${probes.length} probes, ${accepted.length} accepted by the fast path and executed under zsh stubs → ${confirmed.length} findings`);
  for (const finding of confirmed.slice(0, 20)) log(`  FINDING ${finding.problem}: ${JSON.stringify(finding.command)} ${finding.detail ?? ""}`);
}

// ── 4. real binaries under a no-write, no-network sandbox ────────────────────
const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`;

async function sandbox() {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) { log("sandbox: skipped, needs macOS sandbox-exec"); return; }
  const random = prng(0x5a4db0c5);
  const fuzzAccepted = [...generated(4000, random)].filter(probe => isReadOnlyCommand(probe.command)).map(probe => ({ command: probe.command, cwd: undefined as string | undefined }));
  const candidates = [...replayFast.filter(entry => entry.cwd && existsSync(entry.cwd)).slice(0, SANDBOX), ...fuzzAccepted.slice(0, 500)];
  const scratch = mkdtempSync(join(tmpdir(), "tool-gate-sandbox-"));
  const violation = /Operation not permitted|sandbox|deny\(|Read-only file system/i;
  const findings: { command: string; stderr: string }[] = [];
  await pool(candidates, 8, entry => new Promise<void>(resolve => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", SANDBOX_PROFILE, "/bin/zsh", "-f", "-c", entry.command], {
      cwd: entry.cwd ?? scratch, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "1" }, stdio: ["ignore", "ignore", "pipe"], timeout: 5000,
    });
    let stderr = "";
    child.stderr.on("data", chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.on("close", () => { if (violation.test(stderr)) findings.push({ command: entry.command, stderr: stderr.split("\n").filter(line => violation.test(line)).slice(0, 3).join(" | ") }); resolve(); });
  }));
  report["sandbox"] = { executed: candidates.length, deniedWrites: findings };
  log(`sandbox: ${candidates.length} fast-path commands run with real binaries, ${findings.length} attempted a denied write or network call`);
  for (const finding of findings.slice(0, 20)) log(`  WRITE ${JSON.stringify(finding.command.slice(0, 160))} → ${finding.stderr.slice(0, 200)}`);
}

// ── 5. performance and ReDoS ─────────────────────────────────────────────────
async function performanceProbes() {
  const commands = GATE_EVALUATION.flatMap(c => c.command ? [c.command] : []);
  let iterations = 0;
  const started = performance.now();
  while (performance.now() - started < 1000) { for (const command of commands) isReadOnlyCommand(command); iterations += commands.length; }
  const parsePerSecond = Math.round(iterations / ((performance.now() - started) / 1000));

  const repo = join(mkdtempSync(join(tmpdir(), "tool-gate-perf-")), "repo");
  execFileSync("git", ["init", "-q", repo]);
  const gitMs: number[] = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); isReadOnlyCommand("git status", { cwd: repo }); gitMs.push(performance.now() - t); }
  const hookFast: number[] = [];
  for (let i = 0; i < 200; i++) hookFast.push((await outcome("bash", { command: "cd /repo && rg -n TODO src | head -20" })).ms);
  const hookGit: number[] = [];
  for (let i = 0; i < 30; i++) hookGit.push((await outcome("bash", { command: "git status --short" })).ms);

  // ReDoS: every rule regex and the whole hook against long, pattern-shaped input.
  const fragments = ["a", " ", "-", "-a ", "rm ", "/", "x/", "'", "\"", "$", "\\", "| ", "&& ls ", ".env", "~/.ssh/", "-rf ", "curl -d ", "git push ", "cat ", "--", "=", "*", "{", "(", "\t"];
  const regexes: { id: string; regex: RegExp }[] = [];
  for (const rule of DEFAULT_RULES) {
    if (rule.command) { const regex = compileCommand(rule.command); if (regex) regexes.push({ id: `${rule.id}:command`, regex }); }
    for (const path of rule.paths ?? []) regexes.push({ id: `${rule.id}:${path}`, regex: globToRegExp(path) });
  }
  let worstRegex = { id: "", input: "", ms: 0 };
  for (const { id, regex } of regexes) {
    const own = regex.source.replace(/[\\^$.*+?()[\]{}|]/g, "");
    for (const fragment of [...fragments, own.slice(0, 12)]) {
      const input = fragment.repeat(Math.ceil(20000 / Math.max(1, fragment.length))) + "!";
      const t = performance.now(); regex.test(input); const ms = performance.now() - t;
      if (ms > worstRegex.ms) worstRegex = { id, input: `${JSON.stringify(fragment)} x ${input.length}`, ms };
    }
  }
  let worstHook = { input: "", ms: 0 };
  for (const fragment of fragments) {
    const input = fragment.repeat(Math.ceil(100000 / fragment.length));
    const { ms } = await outcome("bash", { command: input });
    if (ms > worstHook.ms) worstHook = { input: `${JSON.stringify(fragment)} x ${input.length}`, ms };
  }
  report["performance"] = {
    parserCallsPerSecond: parsePerSecond, gitConfigProbeMs: latency(gitMs), hookFastPathMs: latency(hookFast), hookGitFastPathMs: latency(hookGit),
    regexCount: regexes.length, worstRegex: { ...worstRegex, ms: round(worstRegex.ms) }, worstHookOn100kInput: { ...worstHook, ms: round(worstHook.ms) },
  };
  log(`perf: parser ${parsePerSecond.toLocaleString()} calls/s; hook fast path p50 ${round(percentile(hookFast, 0.5))} ms p99 ${round(percentile(hookFast, 0.99))} ms; git config probe p50 ${round(percentile(gitMs, 0.5))} ms`);
  log(`  ReDoS: ${regexes.length} rule regexes, worst ${round(worstRegex.ms)} ms (${worstRegex.id} on ${worstRegex.input}); whole hook on 100k input worst ${round(worstHook.ms)} ms (${worstHook.input})`);
}

const SECTIONS = option("--sections")?.split(",") ?? ["accuracy", "replay", "fuzz", "sandbox", "perf"];
if (SECTIONS.includes("accuracy")) await accuracy();
if (SECTIONS.includes("replay")) await replay();
if (SECTIONS.includes("fuzz")) await fuzz();
if (SECTIONS.includes("sandbox")) await sandbox();
if (SECTIONS.includes("perf")) await performanceProbes();
if (OUTPUT) { writeFileSync(OUTPUT, JSON.stringify(report, null, 2)); log(`report written to ${OUTPUT}`); }
