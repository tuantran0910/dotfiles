/** Policy model for tool-gate. Kept free of omp imports so it can be unit-tested. */

export type Action = "allow" | "deny" | "prompt";
export type Mode = "off" | "observe" | "enforce";

export interface Rule {
  /** Stable id, used in the audit log and by `/tool-gate allow <id>`. */
  id: string;
  action: Action;
  /** Tool-name glob. Defaults to `*` (every tool). */
  tool?: string;
  /** Regular expression tested against a Bash command (bash only). */
  command?: string;
  /** Glob patterns tested against file targets (read/write/edit). */
  paths?: string[];
  /** Shown to the model when the rule denies, and to the user when it prompts. */
  reason: string;
}

/** Optional model-in-the-loop escalation for calls no rule matched. */
export interface ClassifierConfig {
  enabled: boolean;
  /** Model spec or role alias resolved through `ctx.models`. */
  model: string;
  timeoutMs: number;
  /** Hard cap on classifier calls per session. */
  maxPerSession: number;
  /** What to do when the classifier is unavailable, errors, times out, or answers garbage. */
  onError: "allow" | "deny";
}

export interface GateConfig {
  mode: Mode;
  /** Action when no rule matches. Defaults to `allow`. */
  defaultAction: Action;
  /** Append decisions to `<agent dir>/tool-gate.log`. Defaults to true. */
  log: boolean;
  rules: Rule[];
  classifier: ClassifierConfig;
}

export interface Decision {
  action: Action;
  /** Rule that produced the decision, or `default`. */
  ruleId: string;
  reason: string;
}

/** What the hook knows about a call: a tool name, its arguments, and the cwd. */
export interface CallContext {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  home: string;
}
