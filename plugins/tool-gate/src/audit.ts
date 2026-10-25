/**
 * JSONL audit log: one line per guarded call.
 *
 * Rotation is size-based (2 MB) so a long-running session cannot fill the disk.
 * Logging never throws: a failed write must not change an enforcement decision.
 */

import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export interface AuditRecord {
  tool: string;
  decision: string;
  ruleId: string;
  /** Where the decision came from: a rule, the classifier, or the default action. */
  source?: "rule" | "classifier" | "default";
  wouldBe?: string;
  detail?: string;
}

export function auditPath(agentDir: string): string {
  return join(agentDir, "tool-gate.log");
}

export function appendAudit(agentDir: string, record: AuditRecord): void {
  const path = auditPath(agentDir);
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // auditing is best effort by design
  }
}
