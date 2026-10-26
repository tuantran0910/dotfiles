/**
 * tool-gate: argument-level permission policy for omp tool calls.
 *
 * Decision order:
 *   1. explicit rules (deny before prompt before allow; source order breaks ties)
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
import { heredocWrite, isReadOnlyCommand, needsClassification, readOnlyPaths } from "./classify-input.ts";
import { dataBlankedCommand } from "./data-view.ts";
import { shellStateChange } from "./shell-state.ts";
import { buildClassifierPrompt, MAX_CLASSIFIER_ARGS, type ClassifyFn } from "./classifier.ts";
import { AuthorizationContext } from "./authorization.ts";
import { createGuardClassifier } from "./classifier-router.ts";
import { loadConfig } from "./config.ts";
import { evaluate } from "./decide.ts";
import { canonicalTarget, extractPaths, resolveTarget } from "./match.ts";
import type { Action, Mode } from "./types.ts";
import type { Verdict } from "./verdict.ts";

const MODES: Mode[] = ["off", "observe", "enforce"];
const PLUGIN_VERSION = "0.3.10";
const OVERSIZED_RULE = "oversized-command";
const SHELL_STATE_RULE = "persistent-shell-change";

export default function toolGate(pi: ExtensionAPI, options: { classify?: ClassifyFn } = {}): void {
  const agentDir = process.env["TOOL_GATE_STATE_DIR"] ?? getAgentDir();
  const home = homedir();
  const sessionAllowed = new Set<string>();
  const authorization = new AuthorizationContext();
  const verdicts = new Map<string, Verdict>();
  let classifierCalls = 0;
  /** Set once an allowed call redefined commands in omp's persistent session shell. */
  let shellRedefined = false;
  const pending = new Map<string, Promise<Verdict | null>>();
  const classifierAllowed = new Set<string>();
  let generation = 0;

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
    generation++;
    verdicts.clear();
    pending.clear();
    sessionAllowed.clear();
    classifierAllowed.clear();
    for (const warning of loaded.warnings) pi.logger.warn(`tool-gate: ${warning}`);
    if (loaded.sources.length > 0) {
      pi.logger.info(`tool-gate: config from ${loaded.sources.join(", ")}`);
    }
  }

  pi.logger.info(
    `tool-gate: loaded ${PLUGIN_VERSION} (${loaded.config.mode}, ${loaded.config.rules.length} rules, default ${loaded.config.defaultAction}, classifier ${loaded.config.classifier.enabled ? "on" : "off"})`,
  );

  // Remember what the user asked for, so the classifier can judge intent.
  pi.on("input", (event, ctx) => {
    const text = event.text?.trim();
    if (text !== undefined && text !== "") {
      generation++;
      pending.clear();
      authorization.observe(text, ctx?.sessionManager);
    }
    return undefined;
  });

  function resetSession(): void {
    authorization.clear();
    classifierCalls = 0;
    shellRedefined = false;
    modeOverride = null;
    reload(loadedCwd);
  }
  pi.on("session_start", resetSession);
  pi.on("session_switch", resetSession);

  pi.registerCommand("tool-gate", {
    description:
      "Show or change the tool gate. Usage: /tool-gate [status|mode <off|observe|enforce>|allow <rule>|reload]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (ctx.cwd !== loadedCwd) reload(ctx.cwd);
      const [verb, argument] = args.trim().split(/\s+/, 2);

      if (verb === "mode") {
        if (argument === undefined || !MODES.includes(argument as Mode)) {
          ctx.ui.notify(`tool-gate: usage /tool-gate mode <${MODES.join("|")}>`, "error");
          return;
        }
        modeOverride = argument as Mode;
        loaded.config.mode = modeOverride;
        generation++;
        pending.clear();
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
        `version: ${PLUGIN_VERSION} (${import.meta.dir})`,
        `classifier: ${loaded.config.classifier.enabled ? `on (${loaded.config.classifier.backend ?? "model"}/${loaded.config.classifier.model}${loaded.config.classifier.fallbackModel ? `, fallback ${loaded.config.classifier.fallbackModel}` : ""}, ${classifierCalls}/${loaded.config.classifier.maxPerSession === -1 ? "unlimited" : loaded.config.classifier.maxPerSession} calls, ${verdicts.size} cached)` : "off"}`,
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

    const config = loaded.config;
    const callGeneration = generation;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const resolvedPaths = extractPaths(input).map(path => canonicalTarget(resolveTarget(path, ctx.cwd, home)));
    const call = { tool: event.toolName, input, cwd: ctx.cwd, home, resolvedPaths };
    const command = event.toolName === "bash" && typeof input["command"] === "string" ? input["command"] : undefined;
    // Rule regexes such as `\bgit\s+push\b[^\n]*…` backtrack quadratically; a
    // command past the classifier's own limit is confirmed by a person instead.
    const oversized = config.mode !== "off" && command !== undefined && command.length > MAX_CLASSIFIER_ARGS;
    let evaluated: ReturnType<typeof evaluate> = oversized
      ? { action: "prompt", ruleId: OVERSIZED_RULE, reason: `the command is too long to evaluate (${command!.length} characters, limit ${MAX_CLASSIFIER_ARGS})`, source: "rule" }
      : evaluate(config, call, sessionAllowed);
    // A rule that matched only a search pattern, a commit message or literal file
    // content is not a verdict on what runs: the call takes the normal path, where
    // only the fast path or the classifier can allow it. Without a classifier to
    // review it, the rule stands.
    let dataOnlyRule: string | undefined;
    if (!oversized && command !== undefined && evaluated.source === "rule" && evaluated.action !== "allow" && config.classifier.enabled) {
      const view = dataBlankedCommand(command);
      const viewed = view === command ? evaluated : evaluate(config, { ...call, input: { ...input, command: view } }, sessionAllowed);
      const rank = { allow: 0, prompt: 1, deny: 2 };
      if (rank[viewed.action] < rank[evaluated.action]) {
        dataOnlyRule = evaluated.ruleId;
        evaluated = viewed.action === "allow"
          ? { action: config.defaultAction, ruleId: "default", reason: `rule ${evaluated.ruleId} matched only data`, source: "default" }
          : viewed;
      }
    }
    // Redefining a fast-path program, a hook, a sensitive variable or a shell
    // option changes what every later call runs; a person confirms it.
    const shellChange = oversized || command === undefined ? null : shellStateChange(command);
    if (shellChange === "redefines" && config.mode !== "off" && evaluated.action !== "deny" && !sessionAllowed.has(SHELL_STATE_RULE)) {
      evaluated = { action: "prompt", ruleId: SHELL_STATE_RULE, reason: "this call changes the persistent session shell (functions, aliases, options or sensitive variables), so later commands may not run what they name", source: "rule" };
    }
    if (!oversized && command !== undefined && isReadOnlyCommand(command)) {
      const fileDecision = evaluate(config, { ...call, tool: "read", input: { paths: readOnlyPaths(command) } }, sessionAllowed);
      const rank = { allow: 0, prompt: 1, deny: 2 };
      if (fileDecision.source === "rule" && rank[fileDecision.action] > rank[evaluated.action]) evaluated = fileDecision;
    }
    // A literal heredoc write meets the same file rules as the write tool.
    const heredoc = oversized || command === undefined ? null : heredocWrite(command);
    if (heredoc !== null) {
      const fileDecision = evaluate(config, { ...call, tool: "write", input: { path: heredoc.path } }, sessionAllowed);
      const rank = { allow: 0, prompt: 1, deny: 2 };
      if (fileDecision.source === "rule" && rank[fileDecision.action] > rank[evaluated.action]) evaluated = fileDecision;
    }

    let action: Action = evaluated.action;
    let ruleId = evaluated.ruleId;
    let reason = evaluated.reason;
    let detail = evaluated.detail;
    let source: "rule" | "classifier" | "default" = evaluated.source;
    let classifierVerdict: Action | undefined;
    let classifierUnavailable = false;
    let approval: "once" | "session" | "denied" | undefined;

    const classifier = config.classifier;
    let classifierKey: string | undefined;
    let reviewedInstructions: string | undefined;
    if (evaluated.source === "default" && classifier.enabled && (needsClassification(event.toolName, input, { cwd: ctx.cwd, home }) || (shellRedefined && command !== undefined))) {
      const context = authorization.read(ctx.sessionManager);
      reviewedInstructions = JSON.stringify(context);
      const activeModel = classifier.model === "@current" || classifier.fallbackModel === "@current" ? ctx.models?.current?.() : undefined;
      const key = JSON.stringify([event.toolName, input, ctx.cwd, home, resolvedPaths, context, activeModel?.provider, activeModel?.id, activeModel?.baseUrl]);
      classifierKey = key;
      let verdict = verdicts.get(key);
      if (verdict === undefined) {
        let completeInput = true;
        try { buildClassifierPrompt(call, context); } catch { completeInput = false; }
        if (!completeInput) {
          verdict = { action: "prompt", reason: "the complete call or user context exceeds the classifier review limit" };
        } else if (pending.has(key)) {
          verdict = (await pending.get(key)) ?? undefined;
        } else if (classifier.maxPerSession !== -1 && classifierCalls >= classifier.maxPerSession) {
          verdict = { action: classifier.onError, reason: "classifier budget exhausted for this session" };
        } else {
          classifierCalls += 1;
          const classify = options.classify ?? createGuardClassifier(pi, ctx, classifier, {
            reserveFallback: () => {
              if (callGeneration !== generation) return false;
              if (classifier.maxPerSession !== -1 && classifierCalls >= classifier.maxPerSession) return false;
              classifierCalls++;
              return true;
            },
          });
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const request = Promise.race([
            Promise.resolve().then(() => classify(call, context, controller.signal)).catch(() => null),
            new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, classifier.timeoutMs); }),
          ]).finally(() => { clearTimeout(timer); if (pending.get(key) === request) pending.delete(key); });
          pending.set(key, request);
          verdict = (await request) ?? undefined;
          // Only a real answer is cached. An outage must not poison a call for
          // the rest of the session after the provider recovers.
          if (verdict && callGeneration === generation) verdicts.set(key, verdict);
        }
      }
      if (verdict === undefined) classifierUnavailable = true;
      verdict ??= { action: classifier.onError, reason: "the classifier was unavailable (no verdict: outage, rate limit, timeout or unparseable answer)" };
      classifierVerdict = verdict.action;
      action = classifierAllowed.has(key) && verdict.action === "prompt" ? "allow" : verdict.action;
      ruleId = "classifier";
      reason = verdict.reason ?? "classifier decision";
      detail = typeof input["command"] === "string" ? input["command"].slice(0, 200) : undefined;
      source = "classifier";
    }

    if (callGeneration !== generation || (reviewedInstructions !== undefined && reviewedInstructions !== JSON.stringify(authorization.read(ctx.sessionManager)))) {
      action = "deny";
      reason = "policy or session changed while this decision was pending; retry the call";
    }
    const observed = callGeneration === generation && config.mode === "observe";
    let effective: Action = observed ? "allow" : action;

    const audit = () => {
      if (!config.log) return;
      appendAudit(agentDir, {
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        tool: event.toolName,
        decision: effective,
        ruleId,
        source,
        wouldBe: observed ? action : undefined,
        verdict: classifierVerdict,
        dataOnlyRule,
        approval,
        reason: source === "default" ? undefined : reason,
        detail,
      });
    };

    if (effective === "deny") {
      audit();
      const authority = source === "classifier" ? "the classifier" : source === "default" ? "the default policy" : `rule "${ruleId}"`;
      const recovery = source === "rule"
        ? `Ask the user to run it themselves, or use /tool-gate allow ${ruleId} for this session.`
        : source === "classifier" && classifierUnavailable
          ? "This is not a judgment of this call's content: do not reword or split it, or switch tools to get around it. Retry the same call shortly, or ask the user to run it."
          : source === "classifier" ? "Ask the user to clarify authorization, then retry." : "Correct the policy or ask the user to run it themselves.";
      return {
        block: true,
        reason: `tool-gate: blocked by ${authority} — ${reason}. ${recovery}`,
      };
    }

    if (effective === "prompt") {
      const approve = ctx.ui.approve?.bind(ctx.ui);
      if (approve === undefined) {
        effective = "deny";
        audit();
        return {
          block: true,
          reason: `tool-gate: ${source === "classifier" ? "the classifier wants confirmation" : `rule "${ruleId}" requires confirmation`} (${reason}), and this session has no UI to ask. Ask the user, then retry.`,
        };
      }

      let answer;
      try {
        answer = await approve({
          full: `tool-gate wants confirmation for ${event.toolName}\n\n${source === "classifier" ? "Classifier" : `Rule: ${ruleId}`}\n${reason}\n\nArguments:\n${JSON.stringify(input, null, 2)}`,
          compact: `${event.toolName}: ${source === "classifier" ? "classifier" : ruleId}`,
          // An oversized command skipped every rule, so it is never granted for the session.
          session: classifierKey ? "Allow this exact call for this session" : source === "rule" && ruleId !== OVERSIZED_RULE ? `Allow ${ruleId} for this session` : undefined,
        });
      } catch { answer = "deny"; }

      if ((answer !== "once" && answer !== "session") || callGeneration !== generation || (reviewedInstructions !== undefined && reviewedInstructions !== JSON.stringify(authorization.read(ctx.sessionManager)))) {
        effective = "deny";
        approval = "denied";
        audit();
        return { block: true, reason: `tool-gate: the user denied this call (${ruleId}).` };
      }
      approval = answer;
      if (answer === "session") {
        if (classifierKey) classifierAllowed.add(classifierKey);
        else sessionAllowed.add(ruleId);
        pi.logger.info(`tool-gate: ${ruleId} approved for this session`);
      }
      effective = "allow";
    }

    if (shellChange !== null) shellRedefined = true;
    audit();
    return undefined;
  });
}
