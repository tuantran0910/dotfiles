/** Pure rule evaluation: no omp, no filesystem, no clock. */

import { compileCommand, extractPaths, matchesAnyPath, matchesTool } from "./match.ts";
import type { Action, CallContext, Decision, GateConfig, Rule } from "./types.ts";

function ruleMatches(rule: Rule, ctx: CallContext): { matched: boolean; detail?: string } {
  if (!matchesTool(rule.tool, ctx.tool)) return { matched: false };

  const hasCommand = rule.command !== undefined;
  const hasPaths = rule.paths !== undefined && rule.paths.length > 0;

  // A command rule only ever applies to bash.
  if (hasCommand && ctx.tool !== "bash") return { matched: false };

  if (hasCommand) {
    const command = ctx.input["command"];
    if (typeof command !== "string") return { matched: false };
    const pattern = compileCommand(rule.command!);
    if (pattern === null || !pattern.test(command)) return { matched: false };
    if (!hasPaths) return { matched: true, detail: command.slice(0, 200) };
  }

  if (hasPaths) {
    const targets = extractPaths(ctx.input);
    if (targets.length === 0) return { matched: false };
    const relevant = targets.filter(target => !rule.excludePaths || matchesAnyPath(rule.excludePaths, [target], ctx.cwd, ctx.home, true) === null);
    const hit = matchesAnyPath(rule.paths!, relevant, ctx.cwd, ctx.home, rule.action === "allow");
    if (hit === null) return { matched: false };
    return { matched: true, detail: hit };
  }

  // Tool-only rule: a deliberate broad match.
  return { matched: true };
}

/**
 * Deny before prompt before allow; source order breaks ties. A project prompt or
 * a template in a multi-file edit must never hide a more restrictive match.
 *
 * `sessionAllowed` holds rule ids the user approved for this session; a matching
 * id downgrades its rule to allow without changing the rule order.
 */
export function evaluate(
  config: GateConfig,
  ctx: CallContext,
  sessionAllowed: ReadonlySet<string> = new Set(),
): Decision & { detail?: string; source: "rule" | "default" } {
  if (config.mode === "off") return { action: "allow", ruleId: "mode:off", reason: "guard disabled", source: "rule" };

  let decision: (Decision & { detail?: string }) | undefined;
  const rank: Record<Action, number> = { allow: 0, prompt: 1, deny: 2 };
  for (const rule of config.rules) {
    const result = ruleMatches(rule, ctx);
    if (!result.matched) continue;
    const approved = sessionAllowed.has(rule.id);
    const action = approved ? "allow" : rule.action;
    if (!decision || rank[action] > rank[decision.action]) {
      decision = { action, ruleId: rule.id, reason: approved ? "approved for this session" : rule.reason, detail: result.detail };
    }
    if (action === "deny") return { ...decision!, source: "rule" };
  }

  if (decision) return { ...decision, source: "rule" };

  return {
    action: config.defaultAction,
    ruleId: "default",
    reason: `no rule matched (default ${config.defaultAction})`,
    source: "default",
  };
}
