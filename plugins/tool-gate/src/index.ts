/**
 * tool-gate: argument-level permission policy for omp tool calls.
 *
 * omp already decides *which tools* need approval (`tools.approvalMode` plus
 * `tools.approval.<tool>`); that gate is per tool, and in print mode an
 * unresolved prompt becomes a denial. This plugin adds the layer omp does not
 * have: rules on the *arguments* — a bash command pattern or a file path — with a
 * deterministic decision and an audit trail.
 *
 * Modes: `enforce` (default), `observe` (log only), `off`.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";

import { appendAudit, auditPath } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { evaluate } from "./decide.ts";
import type { Action, Mode } from "./types.ts";

const ACTIONS: Action[] = ["allow", "deny", "prompt"];
const MODES: Mode[] = ["off", "observe", "enforce"];

export default function toolGate(pi: ExtensionAPI): void {
  const agentDir = process.env["TOOL_GATE_STATE_DIR"] ?? getAgentDir();
  const home = homedir();
  const sessionAllowed = new Set<string>();

  let loadedCwd = "";
  /** Runtime override from /tool-gate mode; survives reloads. */
  let modeOverride: Mode | null = null;
  let loaded = loadConfig(agentDir, process.cwd());
  for (const warning of loaded.warnings) pi.logger.warn(`tool-gate: ${warning}`);
  loadedCwd = process.cwd();

  function reload(cwd: string): void {
    loaded = loadConfig(agentDir, cwd);
    if (modeOverride !== null) loaded.config.mode = modeOverride;
    loadedCwd = cwd;
    for (const warning of loaded.warnings) pi.logger.warn(`tool-gate: ${warning}`);
    if (loaded.sources.length > 0) {
      pi.logger.info(`tool-gate: config from ${loaded.sources.join(", ")}`);
    }
  }

  pi.logger.info(
    `tool-gate: loaded (${loaded.config.mode}, ${loaded.config.rules.length} rules, default ${loaded.config.defaultAction})`,
  );

  pi.registerCommand("tool-gate", {
    description: "Show or change the tool gate. Usage: /tool-gate [status|mode <off|observe|enforce>|allow <rule>|reload]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const [verb, argument] = args.trim().split(/\s+/, 2);

      if (verb === "mode") {
        if (argument === undefined || !MODES.includes(argument as Mode)) {
          ctx.ui.notify(`tool-gate: usage /tool-gate mode <${MODES.join("|")}>`, "error");
          return;
        }
        modeOverride = argument as Mode;
        loaded.config.mode = modeOverride;
        pi.logger.info(`tool-gate: mode set to ${argument}`);
      } else if (verb === "allow") {
        if (argument === undefined) {
          ctx.ui.notify("tool-gate: usage /tool-gate allow <rule-id>", "error");
          return;
        }
        if (!loaded.config.rules.some((rule) => rule.id === argument)) {
          ctx.ui.notify(`tool-gate: unknown rule "${argument}"`, "error");
          return;
        }
        sessionAllowed.add(argument);
        pi.logger.info(`tool-gate: rule ${argument} approved for this session`);
      } else if (verb === "reload") {
        reload(ctx.cwd);
      } else if (verb !== undefined && verb !== "" && verb !== "status") {
        ctx.ui.notify(`tool-gate: unknown argument "${verb}". Use status, mode, allow or reload.`, "error");
        return;
      }

      const lines = [
        `tool-gate: ${loaded.config.mode} — ${loaded.config.rules.length} rules, default ${loaded.config.defaultAction}`,
        `config: ${loaded.sources.length > 0 ? loaded.sources.join(", ") : "defaults only"}`,
        `audit: ${auditPath(agentDir)}`,
      ];
      if (sessionAllowed.size > 0) lines.push(`approved this session: ${[...sessionAllowed].join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (ctx.cwd !== loadedCwd) reload(ctx.cwd);
    if (modeOverride !== null) loaded.config.mode = modeOverride;

    const input = (event.input ?? {}) as Record<string, unknown>;
    const decision = evaluate(
      loaded.config,
      { tool: event.toolName, input, cwd: ctx.cwd, home },
      sessionAllowed,
    );

    const observed = loaded.config.mode === "observe";
    const effective: Action = observed ? "allow" : decision.action;

    if (loaded.config.log) {
      appendAudit(agentDir, {
        tool: event.toolName,
        decision: effective,
        ruleId: decision.ruleId,
        wouldBe: observed ? decision.action : undefined,
        detail: decision.detail,
      });
    }

    if (effective === "deny") {
      return {
        block: true,
        reason: `tool-gate: blocked by rule "${decision.ruleId}" — ${decision.reason}. Ask the user to run it themselves, or run /tool-gate allow ${decision.ruleId} for this session.`,
      };
    }

    if (effective === "prompt") {
      const approve = ctx.ui.approve?.bind(ctx.ui);
      if (approve === undefined) {
        return {
          block: true,
          reason: `tool-gate: rule "${decision.ruleId}" requires confirmation (${decision.reason}), and this session has no UI to ask. Ask the user, then retry with /tool-gate allow ${decision.ruleId}.`,
        };
      }

      const answer = await approve({
        full: `tool-gate wants confirmation for ${event.toolName}\n\nRule: ${decision.ruleId}\n${decision.reason}${decision.detail ? `\n\nTarget: ${decision.detail}` : ""}`,
        compact: `${event.toolName}: ${decision.ruleId}`,
        session: `Allow ${decision.ruleId} for this session`,
      });

      if (answer === "deny" || answer === undefined) {
        return {
          block: true,
          reason: `tool-gate: the user denied this call (rule "${decision.ruleId}").`,
        };
      }
      if (answer === "session") {
        sessionAllowed.add(decision.ruleId);
        pi.logger.info(`tool-gate: rule ${decision.ruleId} approved for this session`);
      }
    }

    return undefined;
  });
}
