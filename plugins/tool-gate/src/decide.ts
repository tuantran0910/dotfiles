/** Pure rule evaluation: no omp, no filesystem, no clock. */

import { compileCommand, extractPaths, matchesAnyPath, matchesTool } from "./match.ts";
import type { CallContext, Decision, GateConfig, Rule } from "./types.ts";

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
    return { matched: true, detail: command.slice(0, 200) };
  }

  if (hasPaths) {
    const targets = extractPaths(ctx.input);
    if (targets.length === 0) return { matched: false };
    const hit = matchesAnyPath(rule.paths!, targets, ctx.cwd, ctx.home);
    if (hit === null) return { matched: false };
    return { matched: true, detail: hit };
  }

  // Tool-only rule: a deliberate broad match.
  return { matched: true };
}

/**
 * Walks the rules in order and returns the first match.
 *
 * `sessionAllowed` holds rule ids the user approved for this session; a matching
 * id downgrades its rule to allow without changing the rule order.
 */
export function evaluate(
  config: GateConfig,
  ctx: CallContext,
  sessionAllowed: ReadonlySet<string> = new Set(),
): Decision & { detail?: string } {
  if (config.mode === "off") return { action: "allow", ruleId: "mode:off", reason: "guard disabled" };

  for (const rule of config.rules) {
    const result = ruleMatches(rule, ctx);
    if (!result.matched) continue;
    if (sessionAllowed.has(rule.id)) {
      return { action: "allow", ruleId: rule.id, reason: "approved for this session", detail: result.detail };
    }
    return { action: rule.action, ruleId: rule.id, reason: rule.reason, detail: result.detail };
  }

  return {
    action: config.defaultAction,
    ruleId: "default",
    reason: `no rule matched (default ${config.defaultAction})`,
  };
}
