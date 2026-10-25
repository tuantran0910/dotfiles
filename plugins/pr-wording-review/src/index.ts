/**
 * pr-wording-review runtime half.
 *
 * The rule files handle text that appears literally in a command or an MCP tool
 * call. This extension covers the one path they cannot see: a `gh pr create` or
 * `gh pr edit` whose description lives in a file (`--body-file` / `-F`).
 *
 * Policy mirrors the rules: interrupt once per file per session, then let the
 * retry through. Blocking forever would trap the agent behind a file it cannot
 * edit; allowing silently would defeat the check.
 */

import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiPullText, bodyFilePaths, redirectedText, stdinBody, usesFillFlag } from "./command.ts";
import { compileConditions, extractConditions, firstMatch } from "./patterns.ts";

const RULE_FILE = fileURLToPath(new URL("../rules/pr-wording-review.md", import.meta.url));

const INTERRUPT_REASON =
  "pr-wording-review: the PR description file contains wording that reads as machine-generated (%s). Rewrite those phrases, keep technical terms and identifiers, then retry the same command. If the flagged word is precise, keep it and say why.";

/** Commit messages that `--fill` would turn into the PR body. */
async function commitText(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const range = await pi.exec("git", ["-C", cwd, "log", "--format=%s%n%b", "@{upstream}..HEAD"]);
  if (range.code === 0 && range.stdout.trim() !== "") return range.stdout;

  const recent = await pi.exec("git", ["-C", cwd, "log", "--format=%s%n%b", "-n", "5"]);
  return recent.code === 0 && recent.stdout.trim() !== "" ? recent.stdout : null;
}

function loadPatterns(pi: ExtensionAPI): RegExp[] {
  try {
    return compileConditions(extractConditions(readFileSync(RULE_FILE, "utf8")));
  } catch (error) {
    pi.logger.warn(`pr-wording-review: rule file unreadable, body-file checks disabled: ${String(error)}`);
    return [];
  }
}

export default function prWordingReview(pi: ExtensionAPI): void {
  const patterns = loadPatterns(pi);
  const interrupted = new Set<string>();

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (event.toolName !== "bash") return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const command = input["command"];
    if (typeof command !== "string") return;

    const cwd = typeof input["cwd"] === "string" ? input["cwd"] : ctx.cwd;
    const sources: { id: string; text: string }[] = [];

    for (const path of bodyFilePaths(command)) {
      const absolute = isAbsolute(path) ? path : join(cwd, path);
      try {
        sources.push({ id: absolute, text: readFileSync(absolute, "utf8") });
      } catch {
        // Maybe the same command writes it first — test the redirected text.
        const redirected = redirectedText(command, path);
        if (redirected !== null) sources.push({ id: `redirect:${absolute}`, text: redirected });
      }
    }

    const stdin = stdinBody(command);
    if (stdin !== null) sources.push({ id: "stdin", text: stdin });

    const api = apiPullText(command);
    if (api !== null) sources.push({ id: "gh-api-pulls", text: api });

    if (usesFillFlag(command)) {
      const commits = await commitText(pi, cwd);
      if (commits === null) {
        pi.logger.debug("pr-wording-review: --fill used but no commit text could be read");
      } else {
        sources.push({ id: "fill", text: commits });
      }
    }

    if (sources.length === 0) return;

    const hits: string[] = [];
    for (const source of sources) {
      if (interrupted.has(source.id)) continue;
      const match = firstMatch(patterns, source.text);
      if (match === null) continue;
      interrupted.add(source.id);
      hits.push(`${source.id} matched ${match}`);
    }

    if (hits.length === 0) return;
    return {
      block: true,
      reason: INTERRUPT_REASON.replace("%s", hits.join("; ")),
    };
  });
}
