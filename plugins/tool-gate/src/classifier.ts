/**
 * Optional model-in-the-loop escalation.
 *
 * Only calls that match no rule reach here. The classifier is a second opinion,
 * not an authority: its answer is one of allow/deny/prompt, and anything that is
 * not a clean verdict (timeout, provider error, unparseable text) becomes the
 * configured `onError` action — deny by default, matching Claude Code's behaviour
 * when its server returns no safety verdict.
 *
 * Tool results are never sent directly. Proposed arguments can still contain
 * hostile text copied from a file, so the classifier is not an isolation boundary.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AUTHORIZATION_POLICY, sessionInstructions } from "./authorization.ts";
import { join } from "node:path";

import type { CallContext, ClassifierConfig } from "./types.ts";
import { VERDICT_TOOL, parseVerdict, type Verdict } from "./verdict.ts";

export type ClassifyFn = (call: CallContext, intent: readonly string[], signal?: AbortSignal) => Promise<Verdict | null>;

export const MAX_CLASSIFIER_ARGS = 16000;
export const MAX_CLASSIFIER_INTENT = 16000;

type CompleteSimple = (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;

/** Options completeSimple accepts; typed loosely because it is an internal subpath. */
const CALL_OPTIONS = {
  // Some providers map disableReasoning to their lowest effort rather than
  // non-thinking mode. That reasoning shares the output budget with the verdict.
  maxTokens: 2048,
  disableReasoning: true,
  toolChoice: { type: "tool", name: VERDICT_TOOL.name },
};

const SYSTEM_PROMPT = `${AUTHORIZATION_POLICY}\nAnswer only by calling the verdict tool, with one short sentence of reasoning.`;

/**
 * Last user instructions from the session branch.
 *
 * The `input` event only fires for interactive turns, so print-mode runs would
 * otherwise reach the classifier with no idea what was asked.
 */
export function recentInstructions(sessionManager: unknown, limit = 2): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  return (sessionInstructions(sessionManager) ?? []).slice(-limit);
}

/** Builds the two prompts; exported for tests. */
export function buildClassifierPrompt(call: CallContext, intent: readonly string[]): { system: string; user: string } {
  const args = JSON.stringify(call.input, null, 2) ?? String(call.input);
  const instructions = intent.filter((entry) => entry.trim() !== "").map((entry) => `- ${entry}`);
  if (args.length > MAX_CLASSIFIER_ARGS || instructions.join("\n").length > MAX_CLASSIFIER_INTENT) {
    throw new Error("complete call or user context exceeds the classifier review limit");
  }

  return {
    system: SYSTEM_PROMPT,
    user: [
      `Tool: ${call.tool}`,
      `Working directory: ${call.cwd}`,
      ...(call.resolvedPaths?.length ? [`Resolved file targets: ${JSON.stringify(call.resolvedPaths)}`] : []),
      "Arguments:",
      args,
      "",
      "User instructions, oldest first; later restrictions override earlier permission:",
      instructions.length > 0 ? instructions.join("\n") : "(no explicit user instruction captured)",
    ].join("\n"),
  };
}

let cachedLoader: CompleteSimple | null | undefined;

/**
 * Candidate specifiers for `completeSimple`.
 *
 * omp does not expose a completion API to extensions, and a marketplace plugin is
 * loaded from a path where a bare specifier may not resolve. So: try the bare
 * specifier, then an explicit user override, then the plugin's own dependency.
 */
export function completeSimpleCandidates(): string[] {
  const candidates = ["@oh-my-pi/pi-ai/stream"];
  const override = process.env["TOOL_GATE_PI_AI"];
  if (override) candidates.push(override);

  const rel = ["node_modules/@oh-my-pi/pi-ai/src/stream.ts", "node_modules/@oh-my-pi/pi-ai/src/stream.js"];
  // Only the plugin's dependency directory is trusted. Searching the working
  // repository or ancestor node_modules can import an attacker-supplied judge.
  for (const suffix of rel) candidates.push(join(import.meta.dir, "..", suffix));
  return [...new Set(candidates)];
}

/** Resolves `completeSimple` lazily; `null` means confirmed unavailable. */
export async function loadCompleteSimple(
  log: (message: string) => void = () => {},
): Promise<CompleteSimple | null> {
  if (cachedLoader !== undefined) return cachedLoader;
  // omp's compiled binary only maps literal import specifiers in plugin source
  // onto its bundled pi-ai; a marketplace plugin has no node_modules of its own.
  try {
    const module = (await import("@oh-my-pi/pi-ai")) as { completeSimple?: CompleteSimple };
    if (typeof module.completeSimple === "function") {
      log("tool-gate: completeSimple loaded from the host's pi-ai");
      cachedLoader = module.completeSimple;
      return cachedLoader;
    }
  } catch (error) {
    log(`tool-gate: host pi-ai import failed: ${error instanceof Error ? error.message.slice(0, 80) : "error"}`);
  }
  const candidates = completeSimpleCandidates();
  log(`tool-gate: probing ${candidates.length} completeSimple candidates (module dir ${import.meta.dir})`);
  for (const spec of candidates) {
    if (spec.startsWith("/") && !existsSync(spec)) continue;
    try {
      const module = (await import(spec)) as { completeSimple?: CompleteSimple };
      if (typeof module.completeSimple === "function") {
        log(`tool-gate: completeSimple loaded from ${spec}`);
        cachedLoader = module.completeSimple;
        return cachedLoader;
      }
    } catch (error) {
      log(`tool-gate: candidate failed ${spec}: ${error instanceof Error ? error.message.slice(0, 80) : "error"}`);
    }
  }
  log(`tool-gate: no completeSimple candidate resolved (tried ${candidates.slice(0, 4).join(", ")})`);
  cachedLoader = null;
  return null;
}

/**
 * Script run in a child `bun` process.
 *
 * In-process resolution of `pi-ai` fails in a marketplace plugin: the package is
 * found by absolute path, but its own bare imports resolve against the runtime's
 * root rather than the plugin's node_modules. A child process started in the
 * plugin directory resolves normally.
 */
const SUBCLASSIFIER_SCRIPT = `
const payload = JSON.parse(await Bun.stdin.text());
const { completeSimple } = await import("@oh-my-pi/pi-ai/stream");
const message = await completeSimple(payload.model, payload.context, payload.options);
process.stdout.write(JSON.stringify(message));
`;

export async function classifyInSubprocess(
  payload: unknown,
  signal: AbortSignal,
  cwd: string,
): Promise<unknown | null> {
  const bun = typeof Bun !== "undefined" ? Bun.which("bun") : null;
  if (bun === null) return null;
  if (signal.aborted) return null;

  const child = Bun.spawn([bun, "-e", SUBCLASSIFIER_SCRIPT], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => { child.kill(9); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    child.stdin.write(JSON.stringify(payload));
    await child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr.trim().slice(0, 200) || `bun exited ${code}`);
    return JSON.parse(stdout) as unknown;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export interface ClassifierContext {
  models: { resolve(spec: string): unknown; current(): unknown };
  modelRegistry: { getApiKey(model: unknown, sessionId?: string, options?: { signal: AbortSignal }): Promise<string | undefined> };
  sessionManager?: { getSessionId?(): string };
}

/** Injectable transport boundary for deterministic timeout/error tests. */
export interface ClassifierRuntime {
  loadComplete: typeof loadCompleteSimple;
  subprocess: typeof classifyInSubprocess;
}

/** Builds a classifier bound to the live session context. */
export function createClassifier(pi: ExtensionAPI, ctx: ClassifierContext, config: ClassifierConfig, runtime: ClassifierRuntime = { loadComplete: loadCompleteSimple, subprocess: classifyInSubprocess }): ClassifyFn {
  const fallbackSession = randomUUID();
  const checkedVerdict = (message: unknown): Verdict | null => {
    const verdict = parseVerdict(message);
    if (verdict !== null) return verdict;
    const response = message as { stopReason?: unknown; usage?: { output?: unknown; reasoningTokens?: unknown } } | null;
    const stop = response?.stopReason;
    const category = stop === "length" ? "output limit reached" : stop === "error" ? "provider error" : stop === "aborted" ? "request cancelled" : "invalid verdict schema";
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : "unknown";
    pi.logger.warn(`tool-gate: no classifier verdict: ${category} (output=${count(response?.usage?.output)}, reasoning=${count(response?.usage?.reasoningTokens)})`);
    return null;
  };
  return async (call, intent, parentSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parentSignal?.addEventListener("abort", cancel, { once: true });
    if (parentSignal?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
      if (controller.signal.aborted) resolve(null);
      timer = setTimeout(() => { controller.abort(); resolve(null); }, config.timeoutMs);
    });
    const run = async (): Promise<Verdict | null> => {
      // Only an explicit @current selector follows the session model. An
      // unresolved ordinary alias still fails closed rather than switching models.
      const model = config.model === "@current" ? ctx.models.current() : ctx.models.resolve(config.model);
      if (model === undefined || model === null) {
        pi.logger.warn(`tool-gate: classifier model "${config.model}" did not resolve`);
        return null;
      }

      const sessionId = ctx.sessionManager?.getSessionId?.() || fallbackSession;
      const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      const { system, user } = buildClassifierPrompt(call, intent);
      const context = {
        systemPrompt: [system],
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
        tools: [VERDICT_TOOL],
      };
      const options = { ...CALL_OPTIONS, apiKey, sessionId, tools: [VERDICT_TOOL] };
      const pluginDir = `${import.meta.dir}/..`;
      const debug = process.env["TOOL_GATE_DEBUG"] === "1";

      const complete = await runtime.loadComplete(debug ? (message) => pi.logger.info(message) : () => {});
      if (controller.signal.aborted) return null;
      if (complete !== null) {
        try {
          const message = await complete(model, context, { ...options, signal: controller.signal });
          return checkedVerdict(message);
        } catch {
          pi.logger.warn("tool-gate: in-process classifier failed; trying subprocess");
        }
      }

      if (controller.signal.aborted) return null;
      try {
        const message = await runtime.subprocess({ model, context, options }, controller.signal, pluginDir);
        if (debug) pi.logger.info(`tool-gate: subprocess classifier answered ${message === null ? "nothing" : "a message"}`);
        return checkedVerdict(message);
      } catch {
        pi.logger.warn("tool-gate: subprocess classifier failed");
        return null;
      }
    };
    try {
      return await Promise.race([run(), deadline]);
    } catch {
      pi.logger.warn("tool-gate: classifier setup failed");
      return null;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    }
  };
}
