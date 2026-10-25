/**
 * Verdict handling for the classifier.
 *
 * The model is forced to answer through a tool whose schema only permits
 * allow/deny/prompt, so a chatty answer cannot be mistaken for consent. Free-text
 * JSON is accepted as a fallback; anything else is "no verdict", which the caller
 * treats as an error and fails closed.
 */

import type { Action } from "./types.ts";

export interface Verdict {
  action: Action;
  reason?: string;
}

/** Forced tool schema handed to the model. */
export const VERDICT_TOOL = {
  name: "verdict",
  description: "Report the safety decision for the pending tool call.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "reason"],
    properties: {
      decision: { type: "string", enum: ["allow", "deny", "prompt"] },
      reason: { type: "string", description: "One sentence a human can audit." },
    },
  },
} as const;

/** Extracts a verdict from an assistant message's tool call or text. */
export function parseVerdict(message: unknown): Verdict | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "toolCall" && record["name"] === VERDICT_TOOL.name) {
      const verdict = fromArguments(record["arguments"]);
      if (verdict !== null) return verdict;
    }
  }

  // Fallback: some models answer with a JSON object in plain text.
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "text" || typeof record["text"] !== "string") continue;
    const match = /\{[\s\S]*\}/.exec(record["text"]);
    if (!match) continue;
    try {
      const verdict = fromArguments(JSON.parse(match[0]) as unknown);
      if (verdict !== null) return verdict;
    } catch {
      // not a verdict
    }
  }

  return null;
}

function fromArguments(value: unknown): Verdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const decision = record["decision"] ?? record["action"] ?? record["verdict"];
  if (decision !== "allow" && decision !== "deny" && decision !== "prompt") return null;
  const reason = typeof record["reason"] === "string" && record["reason"].trim() !== "" ? record["reason"].trim() : undefined;
  return reason === undefined ? { action: decision } : { action: decision, reason };
}
