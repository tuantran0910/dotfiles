/**
 * Remembers worktrees that the agent created outside the managed placement
 * directory, so a later session in that repository can point at them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Incident {
  path: string;
  at: string;
}

type IncidentsByRepo = Record<string, Incident[]>;

export class IncidentStore {
  private readonly file: string;

  constructor(agentDir: string) {
    this.file = join(agentDir, "worktree-kit-incidents.json");
  }

  private read(): IncidentsByRepo {
    if (!existsSync(this.file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as IncidentsByRepo;
      }
    } catch {
      // corrupt store: start clean rather than lose the session
    }
    return {};
  }

  private write(data: IncidentsByRepo): void {
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  add(repo: string, path: string, at = new Date().toISOString()): void {
    const data = this.read();
    const existing = data[repo] ?? [];
    if (existing.some((incident) => incident.path === path)) return;
    data[repo] = [...existing, { path, at }];
    this.write(data);
  }

  list(repo: string): Incident[] {
    return this.read()[repo] ?? [];
  }

  clear(repo: string, path: string): void {
    const data = this.read();
    const remaining = (data[repo] ?? []).filter((incident) => incident.path !== path);
    if (remaining.length === 0) delete data[repo];
    else data[repo] = remaining;
    this.write(data);
  }
}
