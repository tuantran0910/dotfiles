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
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Resolves `completeSimple` lazily; `null` means confirmed unavailable. */
export async function loadCompleteSimple(): Promise<CompleteSimple | null> {
  if (cachedLoader !== undefined) return cachedLoader;
  const home = homedir();
  const candidates = [
    "@oh-my-pi/pi-ai/stream",
    join(home, ".bun/install/global/node_modules/@oh-my-pi/pi-ai/src/stream.ts"),
  ];
  for (const spec of candidates) {
    try {
      const module = (await import(spec)) as { completeSimple?: CompleteSimple };
      if (typeof module.completeSimple === "function") {
        cachedLoader = module.completeSimple;
        return cachedLoader;
      }
    } catch {
      // try the next candidate
    }
  }
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

    const complete = await loadCompleteSimple();
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
