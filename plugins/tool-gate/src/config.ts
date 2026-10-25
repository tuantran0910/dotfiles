/**
 * Config loading and the shipped default policy.
 *
 * Precedence: project `.omp/tool-gate.json` rules, then user
 * `<agent dir>/tool-gate.json` rules, then the built-in defaults. Within that
 * list the first matching rule wins, so a project can override a default by
 * adding a rule above it.
 *
 * Default action is `allow`: the guard is a blocklist for genuinely dangerous
 * operations, not a gate on ordinary work. A blocklist that defaults to deny
 * gets switched off within a day.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compileCommand } from "./match.ts";
import type { Action, GateConfig, Mode, Rule } from "./types.ts";

const ACTIONS: Action[] = ["allow", "deny", "prompt"];
const MODES: Mode[] = ["off", "observe", "enforce"];

export const DEFAULT_RULES: Rule[] = [
  // ── destructive shell ─────────────────────────────────────────────────────
  {
    id: "rm-no-preserve-root",
    action: "deny",
    tool: "bash",
    command: String.raw`--no-preserve-root`,
    reason: "refusing --no-preserve-root",
  },
  {
    id: "rm-root",
    action: "deny",
    tool: "bash",
    command: String.raw`\brm\s+(?:-[A-Za-z-]+\s+)*(?:/|/\*|~|~/|\$HOME/?)(?=\s|$|;|&|\|)`,
    reason: "refusing to remove a root or home directory",
  },
  {
    id: "force-push",
    action: "deny",
    tool: "bash",
    command: String.raw`\bgit\s+push\b[^\n]*(?:\s--force(?![\w-])|(?<![\w-])-f(?=\s|$))`,
    reason: "force-pushing rewrites shared history; use --force-with-lease after inspecting the remote",
  },
  {
    id: "git-reset-hard",
    action: "deny",
    tool: "bash",
    command: String.raw`\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b`,
    reason: "git reset --hard discards uncommitted work; stash first or target specific paths",
  },
  {
    id: "git-clean-force",
    action: "deny",
    tool: "bash",
    command: String.raw`\bgit\s+clean\s+(?:-[A-Za-z]*[fdx][A-Za-z]*\s*)+`,
    reason: "git clean deletes untracked files permanently; list them with `git clean -nd` first",
  },
  {
    id: "git-history-rewrite",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgit\s+(?:filter-branch|filter-repo)\b`,
    reason: "history rewriting is irreversible for anyone who already pulled",
  },
  {
    id: "curl-pipe-shell",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|dash)\b`,
    reason: "piping a download into a shell executes unreviewed code; download, inspect, then run",
  },
  {
    id: "dd-device",
    action: "deny",
    tool: "bash",
    command: String.raw`\bdd\b[^\n]*\bof=/dev/`,
    reason: "writing to a block device can destroy the disk",
  },
  {
    id: "mkfs-or-erase",
    action: "deny",
    tool: "bash",
    command: String.raw`\bmkfs(?:\.[a-z0-9]+)?\b|\bdiskutil\s+erase\w*`,
    reason: "formatting or erasing a volume destroys its contents",
  },
  {
    id: "chmod-root",
    action: "deny",
    tool: "bash",
    command: String.raw`\bch(?:own|mod)\s+(?:-[A-Za-z]+\s+)*[^\s]+\s+(?:/|/\*|~|~/|\$HOME/?)(?=\s|$|;|&|\|)`,
    reason: "recursive permission changes on / or ~ break the machine and its credentials",
  },
  {
    id: "fork-bomb",
    action: "deny",
    tool: "bash",
    command: String.raw`:\s*\(\s*\)\s*\{[^}]*:\s*\|`,
    reason: "fork bombs exhaust the process table and stall the machine",
  },
  {
    id: "shutdown",
    action: "deny",
    tool: "bash",
    command: String.raw`(?:^|[;&|]\s*)(?:shutdown|reboot|halt|poweroff)\b`,
    reason: "power control is a human decision",
  },
  {
    id: "write-etc",
    action: "deny",
    tool: "bash",
    command: String.raw`>>?\s*/etc/`,
    reason: "writing into /etc needs a human in the loop",
  },
  {
    id: "pipe-secrets",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:env|printenv|cat\s+[^\n]*(?:\.env|credentials|id_rsa|id_ed25519|secrets/env\.sh))[^\n]*\|\s*(?:curl|wget|nc|ncat|ssh)\b`,
    reason: "piping environment or credential files to the network is exfiltration",
  },

  // ── infrastructure, prompts rather than blocks ────────────────────────────
  {
    id: "sudo",
    action: "prompt",
    tool: "bash",
    command: String.raw`(?:^|[;&|]\s*)sudo\b`,
    reason: "elevated privileges",
  },
  {
    id: "docker-destructive",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bdocker\s+(?:system\s+prune|volume\s+rm|rm\s+-f)|\bdocker\s+container\s+prune\s+-f`,
    reason: "removes containers, volumes or images",
  },
  {
    id: "kube-delete",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bkubectl\s+delete\s+(?:ns|namespace|pvc|pv|all|deploy|deployment|sts|statefulset)\b`,
    reason: "deletes cluster resources",
  },
  {
    id: "terraform-destroy",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bterraform\s+destroy\b`,
    reason: "destroys infrastructure",
  },
  {
    id: "sql-destructive",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:DROP|TRUNCATE)\s+(?:DATABASE|SCHEMA|TABLE)\b`,
    reason: "destructive SQL",
  },
  {
    id: "package-publish",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:npm|bun|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b`,
    reason: "publishing is outward-facing and hard to undo",
  },

  // ── credential paths (file tools) ─────────────────────────────────────────
  {
    id: "env-templates",
    action: "allow",
    tool: "read|write|edit",
    paths: ["**/.env.example", "**/.env.sample", "**/.env.template"],
    reason: "templates carry variable names, not values",
  },
  {
    id: "secret-paths",
    action: "deny",
    tool: "read|write|edit",
    paths: [
      "~/.ssh/**",
      "~/.aws/**",
      "~/.gnupg/**",
      "~/.config/gh/hosts.yml",
      "~/.omp/agent/agent.db",
      "~/.claude/.credentials.json",
      "~/.codex/auth.json",
      "**/.env",
      "**/.env.*",
      "**/secrets/env.sh",
      "**/*.pem",
    ],
    reason: "credential material: read it with a human, not with an agent",
  },
  {
    id: "agent-own-config",
    action: "prompt",
    tool: "write|edit",
    paths: [
      "~/.claude/settings.json",
      "~/.codex/config.toml",
      "~/.omp/agent/config.yml",
      "~/.config/opencode/opencode.json",
    ],
    reason: "the agent would be changing its own permissions; edit the dotfiles repo instead",
  },
];

interface RawConfig {
  mode?: unknown;
  defaultAction?: unknown;
  log?: unknown;
  replaceDefaults?: unknown;
  rules?: unknown;
}

export interface LoadedConfig {
  config: GateConfig;
  sources: string[];
  warnings: string[];
}

function readJson(path: string): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RawConfig;
    return null;
  } catch {
    return null;
  }
}

function validateRules(value: unknown, origin: string, warnings: string[]): Rule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${origin}: "rules" must be an array`);
    return [];
  }
  const rules: Rule[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") {
      warnings.push(`${origin}: rule ${index} is not an object`);
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const id = candidate["id"];
    const action = candidate["action"];
    const reason = candidate["reason"];
    if (typeof id !== "string" || id === "") {
      warnings.push(`${origin}: rule ${index} has no id`);
      continue;
    }
    if (!ACTIONS.includes(action as Action)) {
      warnings.push(`${origin}: rule ${id} has an invalid action`);
      continue;
    }
    if (typeof reason !== "string" || reason === "") {
      warnings.push(`${origin}: rule ${id} has no reason`);
      continue;
    }
    const command = candidate["command"];
    if (command !== undefined && (typeof command !== "string" || compileCommand(command) === null)) {
      warnings.push(`${origin}: rule ${id} has an invalid command pattern`);
      continue;
    }
    const paths = candidate["paths"];
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string"))) {
      warnings.push(`${origin}: rule ${id} has invalid paths`);
      continue;
    }
    rules.push({
      id,
      action: action as Action,
      tool: typeof candidate["tool"] === "string" ? (candidate["tool"] as string) : undefined,
      command: command as string | undefined,
      paths: paths as string[] | undefined,
      reason,
    });
  }
  return rules;
}

/**
 * Loads project + user config over the defaults.
 *
 * An unreadable or malformed file is reported and ignored: the defaults still
 * apply, so a typo cannot silently disable protection.
 */
export function loadConfig(agentDir: string, cwd: string): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];

  const projectPath = join(cwd, ".omp", "tool-gate.json");
  const userPath = join(agentDir, "tool-gate.json");
  const project = readJson(projectPath);
  const user = readJson(userPath);
  if (project) sources.push(projectPath);
  if (user) sources.push(userPath);

  const projectRules = validateRules(project?.rules, projectPath, warnings);
  const userRules = validateRules(user?.rules, userPath, warnings);
  const replaceDefaults = project?.replaceDefaults === true || user?.replaceDefaults === true;

  const mode = ((): Mode => {
    const candidate = project?.mode ?? user?.mode;
    if (typeof candidate === "string" && MODES.includes(candidate as Mode)) return candidate as Mode;
    return "enforce";
  })();

  const defaultAction = ((): Action => {
    const candidate = project?.defaultAction ?? user?.defaultAction;
    if (typeof candidate === "string" && ACTIONS.includes(candidate as Action)) return candidate as Action;
    return "allow";
  })();

  const log = project?.log !== false && user?.log !== false;

  return {
    config: {
      mode,
      defaultAction,
      log,
      rules: [...projectRules, ...userRules, ...(replaceDefaults ? [] : DEFAULT_RULES)],
    },
    sources,
    warnings,
  };
}
