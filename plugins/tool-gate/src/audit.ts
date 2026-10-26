/**
 * JSONL audit log: one line per guarded call.
 *
 * Rotation is size-based (2 MB) so a long-running session cannot fill the disk.
 * Logging never throws: a failed write must not change an enforcement decision.
 */

import { appendFileSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export interface AuditRecord {
  toolCallId?: string;
  cwd?: string;
  tool: string;
  decision: string;
  ruleId: string;
  /** Where the decision came from: a rule, the classifier, or the default action. */
  source?: "rule" | "classifier" | "default";
  wouldBe?: string;
  /** The classifier's own answer, before any session approval or user prompt. */
  verdict?: string;
  /** How the user answered a confirmation prompt. */
  approval?: "once" | "session" | "denied";
  /** Why the rule or classifier decided as it did. */
  reason?: string;
  detail?: string;
}

export function auditPath(agentDir: string): string {
  return join(agentDir, "tool-gate.log");
}

export function appendAudit(agentDir: string, record: AuditRecord): void {
  const path = auditPath(agentDir);
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile()) return;
      if (stat.size > MAX_BYTES) renameSync(path, `${path}.1`);
    }
    // Never echo likely live credentials into a second, persistent transcript.
    const sensitive = /(?:authorization|bearer|token|password|secret|api[_-]?key|credential)|:\/\/[^\s/]+:[^\s/@]+@/i;
    const redact = (text?: string) => text && sensitive.test(text) ? "[redacted: credential-bearing arguments]" : text;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record, reason: redact(record.reason), detail: redact(record.detail) });
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (fstatSync(fd).isFile()) {
        fchmodSync(fd, 0o600);
        appendFileSync(fd, `${line}\n`, "utf8");
      }
    } finally { closeSync(fd); }
  } catch {
    // auditing is best effort by design
  }
}
