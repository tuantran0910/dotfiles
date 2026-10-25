/**
 * Verdict handling for the classifier.
 *
 * The model is forced to answer through a tool whose schema only permits
 * allow/deny/prompt, so a chatty answer cannot be mistaken for consent. Free-text
 * JSON is not accepted as consent; anything else is "no verdict", which the caller
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
  const stop = (message as { stopReason?: unknown }).stopReason;
  if (stop !== undefined && stop !== "toolUse" && stop !== "stop") return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  const calls = content.filter(block => block && typeof block === "object" && block.type === "toolCall");
  if (calls.length !== 1 || calls[0].name !== VERDICT_TOOL.name) return null;
  return fromArguments(calls[0].arguments);
}

function fromArguments(value: unknown): Verdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "decision" && key !== "reason")) return null;
  const decision = record["decision"];
  if (decision !== "allow" && decision !== "deny" && decision !== "prompt") return null;
  const reason = typeof record["reason"] === "string" && record["reason"].trim() !== "" ? record["reason"].trim() : undefined;
  return reason === undefined ? null : { action: decision, reason };
}
