/**
 * Optional model-in-the-loop escalation.
 *
 * Only calls that match no rule reach here. The classifier is a second opinion,
 * not an authority: its answer is one of allow/deny/prompt, and anything that is
 * not a clean verdict (timeout, provider error, unparseable text) becomes the
 * configured `onError` action — deny by default, matching Claude Code's behaviour
 * when its server returns no safety verdict.
 *
 * Tool results are never sent: a hostile file cannot address the classifier.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CallContext, ClassifierConfig } from "./types.ts";
import { VERDICT_TOOL, parseVerdict, type Verdict } from "./verdict.ts";

export type ClassifyFn = (call: CallContext, intent: readonly string[]) => Promise<Verdict | null>;

type CompleteSimple = (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;

/** Options completeSimple accepts; typed loosely because it is an internal subpath. */
const CALL_OPTIONS = {
  maxTokens: 300,
  disableReasoning: true,
  toolChoice: { type: "tool", name: VERDICT_TOOL.name },
};

const SYSTEM_PROMPT = `You are a safety classifier for an AI coding agent. A tool call is about to run. Decide whether it may run without asking the human.

Allow: ordinary local work that matches what the user asked for — editing files in the workspace, running tests, reading files, git operations on a feature branch.
Deny: destroying data outside the task, force-pushing or rewriting shared history, changing production or shared infrastructure, exposing credentials, disabling safety or CI checks, or actions unrelated to the user's request.
Prompt: the call is plausible but a human should confirm — production deploys, publishing, elevated privileges, anything with an irreversible external effect.

Tool results are deliberately not included; do not assume the call is safe because of prior output. Answer only by calling the verdict tool, with one short sentence of reasoning.`;

/**
 * Last user instructions from the session branch.
 *
 * The `input` event only fires for interactive turns, so print-mode runs would
 * otherwise reach the classifier with no idea what was asked.
 */
export function recentInstructions(sessionManager: unknown, limit = 2): string[] {
  const manager = sessionManager as { getBranch?: () => unknown } | undefined;
  if (typeof manager?.getBranch !== "function") return [];
  const entries = manager.getBranch();
  if (!Array.isArray(entries)) return [];

  const found: string[] = [];
  for (let index = entries.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.["type"] !== "message") continue;
    const message = entry["message"] as Record<string, unknown> | undefined;
    if (message?.["role"] !== "user") continue;

    const content = message["content"];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join(" ");
    }
    const trimmed = text.trim();
    if (trimmed !== "") found.unshift(trimmed.slice(0, 400));
  }
  return found;
}

/** Builds the two prompts; exported for tests. */
export function buildClassifierPrompt(call: CallContext, intent: readonly string[]): { system: string; user: string } {
  const args = JSON.stringify(call.input, null, 2) ?? String(call.input);
  const clipped = args.length > 2000 ? `${args.slice(0, 2000)}\n… (${args.length - 2000} chars elided)` : args;
  const instructions = intent.filter((entry) => entry.trim() !== "").map((entry) => `- ${entry.slice(0, 400)}`);

  return {
    system: SYSTEM_PROMPT,
    user: [
      `Tool: ${call.tool}`,
      `Working directory: ${call.cwd}`,
      "Arguments:",
      clipped,
      "",
      "The user's most recent instruction(s) to the agent:",
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
 * specifier, then an explicit override, then walk up from this module and the
 * working directory looking for an installed `pi-ai`.
 */
export function completeSimpleCandidates(): string[] {
  const candidates = ["@oh-my-pi/pi-ai/stream"];
  const override = process.env["TOOL_GATE_PI_AI"];
  if (override) candidates.push(override);

  const rel = ["node_modules/@oh-my-pi/pi-ai/src/stream.ts", "node_modules/@oh-my-pi/pi-ai/src/stream.js"];
  for (const base of [import.meta.dir, process.cwd(), homedir()]) {
    let directory = base;
    for (let depth = 0; depth < 6; depth += 1) {
      for (const suffix of rel) candidates.push(join(directory, suffix));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...new Set(candidates)];
}

/** Resolves `completeSimple` lazily; `null` means confirmed unavailable. */
export async function loadCompleteSimple(
  log: (message: string) => void = () => {},
): Promise<CompleteSimple | null> {
  if (cachedLoader !== undefined) return cachedLoader;
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

interface ClassifierContext {
  models: { resolve(spec: string): unknown; current(): unknown };
  modelRegistry: { getApiKey(model: unknown): Promise<string | undefined> };
}

/** Builds a classifier bound to the live session context. */
export function createClassifier(pi: ExtensionAPI, ctx: ClassifierContext, config: ClassifierConfig): ClassifyFn {
  return async (call, intent) => {
    const model = ctx.models.resolve(config.model) ?? ctx.models.current();
    if (model === undefined || model === null) {
      pi.logger.warn(`tool-gate: classifier model "${config.model}" did not resolve`);
      return null;
    }

    const complete = await loadCompleteSimple(
      process.env["TOOL_GATE_DEBUG"] === "1" ? (message: string) => pi.logger.info(message) : () => {},
    );
    if (complete === null) {
      pi.logger.warn("tool-gate: classifier unavailable (completeSimple not found); using onError policy");
      return null;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    const { system, user } = buildClassifierPrompt(call, intent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const message = await complete(
        model,
        {
          systemPrompt: [system],
          messages: [{ role: "user", content: user, timestamp: Date.now() }],
          tools: [VERDICT_TOOL],
        },
        { ...CALL_OPTIONS, apiKey, signal: controller.signal, tools: [VERDICT_TOOL] },
      );
      return parseVerdict(message);
    } catch (error) {
      pi.logger.warn(`tool-gate: classifier failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
