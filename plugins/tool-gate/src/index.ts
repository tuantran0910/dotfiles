/**
 * tool-gate: argument-level permission policy for omp tool calls.
 *
 * Decision order (first match wins):
 *   1. explicit rules (deny/prompt/allow) from project, user, then defaults
 *   2. read-only calls pass without a model
 *   3. everything else that matched no rule may go to the classifier
 *   4. configured default action
 *
 * The classifier is optional and never overrides a rule. If it is unavailable,
 * errors, times out, or answers something that is not a verdict, `onError` applies
 * (deny by default).
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";

import { appendAudit, auditPath } from "./audit.ts";
import { needsClassification } from "./classify-input.ts";
import { createClassifier, recentInstructions, type ClassifyFn } from "./classifier.ts";
import { loadConfig } from "./config.ts";
import { evaluate } from "./decide.ts";
import type { Action, Mode } from "./types.ts";
import type { Verdict } from "./verdict.ts";

const ACTIONS: Action[] = ["allow", "deny", "prompt"];
const MODES: Mode[] = ["off", "observe", "enforce"];

/** Cheap stable key for the classifier cache. */
function callKey(tool: string, input: Record<string, unknown>): string {
  const text = `${tool}:${JSON.stringify(input)}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${tool}:${hash}`;
}

export default function toolGate(pi: ExtensionAPI, options: { classify?: ClassifyFn } = {}): void {
  const agentDir = process.env["TOOL_GATE_STATE_DIR"] ?? getAgentDir();
  const home = homedir();
  const sessionAllowed = new Set<string>();
  const intent: string[] = [];
  const verdicts = new Map<string, Verdict>();
  let classifierCalls = 0;
  let classifierFn: ClassifyFn | null | undefined;

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
    `tool-gate: loaded (${loaded.config.mode}, ${loaded.config.rules.length} rules, default ${loaded.config.defaultAction}, classifier ${loaded.config.classifier.enabled ? "on" : "off"})`,
  );

  // Remember what the user asked for, so the classifier can judge intent.
  pi.on("input", (event) => {
    const text = event.text?.trim();
    if (text !== undefined && text !== "") {
      intent.push(text.slice(0, 400));
      if (intent.length > 2) intent.shift();
    }
    return undefined;
  });

  pi.registerCommand("tool-gate", {
    description:
      "Show or change the tool gate. Usage: /tool-gate [status|mode <off|observe|enforce>|allow <rule>|reload]",
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
        `classifier: ${loaded.config.classifier.enabled ? `on (${loaded.config.classifier.model}, ${classifierCalls}/${loaded.config.classifier.maxPerSession} calls, ${verdicts.size} cached)` : "off"}`,
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
    const call = { tool: event.toolName, input, cwd: ctx.cwd, home };
    const evaluated = evaluate(loaded.config, call, sessionAllowed);

    let action: Action = evaluated.action;
    let ruleId = evaluated.ruleId;
    let reason = evaluated.reason;
    let detail = evaluated.detail;
    let source: "rule" | "classifier" | "default" = evaluated.ruleId === "default" ? "default" : "rule";

    const classifier = loaded.config.classifier;
    if (evaluated.ruleId === "default" && classifier.enabled && needsClassification(event.toolName, input)) {
      const key = callKey(event.toolName, input);
      let verdict = verdicts.get(key);
      if (verdict === undefined) {
        if (classifierCalls >= classifier.maxPerSession) {
          verdict = { action: classifier.onError, reason: "classifier budget exhausted for this session" };
        } else {
          classifierFn ??= options.classify ?? createClassifier(pi, ctx, classifier);
          classifierCalls += 1;
          const context = intent.length > 0 ? intent : recentInstructions(ctx.sessionManager);
          const answer = await classifierFn(call, context);
          verdict =
            answer ?? {
              action: classifier.onError,
              reason: "no verdict from the classifier (unavailable, timeout or unparseable answer)",
            };
        }
        verdicts.set(key, verdict);
      }
      action = verdict.action;
      ruleId = "classifier";
      reason = verdict.reason ?? "classifier decision";
      detail = typeof input["command"] === "string" ? input["command"].slice(0, 200) : undefined;
      source = "classifier";
    }

    const observed = loaded.config.mode === "observe";
    const effective: Action = observed ? "allow" : action;

    if (loaded.config.log) {
      appendAudit(agentDir, {
        tool: event.toolName,
        decision: effective,
        ruleId,
        source,
        wouldBe: observed ? action : undefined,
        detail,
      });
    }

    if (effective === "deny") {
      return {
        block: true,
        reason: `tool-gate: blocked by ${source === "classifier" ? "the classifier" : `rule "${ruleId}"`} — ${reason}. Ask the user to run it themselves, or run /tool-gate allow ${ruleId} for this session.`,
      };
    }

    if (effective === "prompt") {
      const approve = ctx.ui.approve?.bind(ctx.ui);
      if (approve === undefined) {
        return {
          block: true,
          reason: `tool-gate: ${source === "classifier" ? "the classifier wants confirmation" : `rule "${ruleId}" requires confirmation`} (${reason}), and this session has no UI to ask. Ask the user, then retry.`,
        };
      }

      const answer = await approve({
        full: `tool-gate wants confirmation for ${event.toolName}\n\n${source === "classifier" ? "Classifier" : `Rule: ${ruleId}`}\n${reason}${detail ? `\n\nTarget: ${detail}` : ""}`,
        compact: `${event.toolName}: ${source === "classifier" ? "classifier" : ruleId}`,
        session: `Allow ${ruleId} for this session`,
      });

      if (answer === "deny" || answer === undefined) {
        return { block: true, reason: `tool-gate: the user denied this call (${ruleId}).` };
      }
      if (answer === "session") {
        sessionAllowed.add(ruleId);
        pi.logger.info(`tool-gate: ${ruleId} approved for this session`);
      }
    }

    return undefined;
  });
}
