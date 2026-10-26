/**
 * Config loading and the shipped default policy.
 *
 * Deny before prompt before allow. Within an action, project, user, then
 * defaults determines which matching rule supplies the explanation.
 *
 * Default action is `allow`: the guard is a blocklist for genuinely dangerous
 * operations, not a gate on ordinary work. A blocklist that defaults to deny
 * gets switched off within a day.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compileCommand } from "./match.ts";
import type { Action, ClassifierConfig, GateConfig, Mode, Rule } from "./types.ts";

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
    command: String.raw`\brm\s+(?:(?:-[A-Za-z-]+|--)\s+)*(?:["']?(?:/\*?|~\/?|\$HOME\/?|\$\{HOME\}\/?)["']?)(?=[\s"'\x60;|&)]|$)`.replace("\\x60", "`"),
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
    command: String.raw`\bgit\s+clean\s+(?![^\n;&|]*(?:--dry-run\b|-[A-Za-z]*n[A-Za-z]*(?=\s|$)))(?:-[A-Za-z]*f[A-Za-z]*\s*)+`,
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
    id: "pipe-to-shell",
    action: "deny",
    tool: "bash",
    command: String.raw`\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|dash)\b`,
    reason: "piping text into a shell executes it unreviewed; run the script after reading it",
  },
  {
    id: "dd-device",
    action: "deny",
    tool: "bash",
    command: String.raw`\bdd\b[^\n]*\bof=/dev/(?!null\b|zero\b|stdout\b|stderr\b)`,
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

  {
    id: "find-delete-root",
    action: "deny",
    tool: "bash",
    command: String.raw`\bfind\s+(?:/|~|\$HOME|\$\{HOME\})(?:/|\s)[^\n]*(?:-delete\b|-exec\s+rm\b|\|\s*xargs\s+rm\b)`,
    reason: "find on a whole root or home tree deletes files with no listing",
  },
  {
    id: "find-delete-tree",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bfind\s+\.(?:\s|/)[^\n]*-delete\b`,
    reason: "deletes every match under the working tree",
  },
  {
    id: "git-push-refspec-force",
    action: "deny",
    tool: "bash",
    command: String.raw`\bgit\s+push\b[^\n]*(?:\s\+\S|--mirror\b)`,
    reason: "a +refspec or --mirror rewrites the remote's refs",
  },
  {
    id: "process-substitution-exec",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:ba|z|k|da)?sh\s+<\(\s*(?:curl|wget)\b`,
    reason: "executing a downloaded script through process substitution skips review",
  },
  {
    id: "secret-read-bash",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:cat|bat|less|more|head|tail|strings|base64|xxd|od)\b[^\n]*(?:\.ssh/|\.aws/|\.gnupg/|\bid_(?:rsa|ed25519|ecdsa)\b|\.pem\b|secrets/env\.sh|\.env(?!\.(?:example|sample|template)))`,
    reason: "reads credential material; use the user's own terminal",
  },
  {
    id: "upload-secrets",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:curl\s+[^\n]*-T|scp|rsync)\b[^\n]*(?:\.ssh/|\bid_(?:rsa|ed25519|ecdsa)\b|\.pem\b|secrets/env\.sh|\.env(?!\.(?:example|sample|template)))`,
    reason: "sends credential files off the machine",
  },
  {
    id: "crontab-remove",
    action: "deny",
    tool: "bash",
    command: String.raw`\bcrontab\s+-r\b`,
    reason: "removes every scheduled job with no backup",
  },

  {
    id: "reverse-shell",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:nc|ncat|netcat)\b[^\n]*\s-e\s|/dev/(?:tcp|udp)/`,
    reason: "reverse shells hand an interactive session to someone else",
  },
  {
    id: "db-migration-force",
    action: "deny",
    tool: "bash",
    command: String.raw`\b(?:drizzle-kit\s+push\b[^\n;&|]*--force|prisma\s+(?:migrate\s+reset|db\s+push\b[^\n;&|]*--force-reset)|rails\s+db:(?:drop|reset)|alembic\s+downgrade\s+base|knex\s+migrate:rollback\s+--all|flyway\s+clean)\b`,
    reason: "resets or drops schema and data without a backup step",
  },
  {
    id: "destroy-remote-api",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:curl|http|gh\s+api)\b[^\n]*(?:-X|--request)(?:\s*|=)["']?DELETE\b`,
    reason: "a destructive API call can remove remote infrastructure and its backups",
  },
  {
    id: "docker-privileged",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bdocker\s+run\b[^\n]*(?:--privileged|-v\s+/:|--pid=host|--net=host|/var/run/docker\.sock)`,
    reason: "the container can reach the host",
  },
  {
    id: "gate-tamper",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:rm|mv|cp|truncate|shred|tee)\b[^\n]*tool-gate\.(?:json|log)|>>?\s*\S*tool-gate\.(?:json|log)|sed\s+-i[^\n]*tool-gate\.json`,
    reason: "the guard's own policy or audit trail is being rewritten",
  },

  {
    id: "self-approve-or-merge-pr",
    action: "deny",
    tool: "bash",
    command: String.raw`\bgh(?:\s+(?:--repo(?:=|\s+)|-R\s*|--hostname(?:=|\s+))\S+)*\s+pr\s+(?:merge\b|review\b[^\n]*(?:--approve\b|\s-[A-Za-z]*a[A-Za-z]*(?=\s|$)))`,
    reason: "an agent must not approve or merge its own pull request",
  },
  {
    id: "print-credential",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgh\s+auth\s+token\b|\b(?:echo|printf|printenv|env)\b[^\n]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\b[^\n]*\b(?:grep|sed|awk|cut)\b|\bprintenv\s+(?:\w*TOKEN|\w*SECRET|\w*KEY)\b`,
    reason: "prints a live credential into the transcript",
  },
  {
    id: "git-stash-destroy",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgit\s+stash\s+(?:drop|clear)\b`,
    reason: "permanently discards stashed work",
  },
  {
    id: "registry-bypass",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:npm|bun|pnpm|yarn)\b[^\n]*(?:--registry\s+\S*registry\.npmjs\.org|config\s+set\s+registry\s+\S*registry\.npmjs\.org)`,
    reason: "routes installs around the configured internal registry",
  },
  {
    id: "disarm-tls-guard",
    action: "prompt",
    tool: "bash",
    command: String.raw`\b(?:curl|wget)\b[^\n]*\s(?:--insecure|-k)\b`,
    reason: "disables certificate verification",
  },
  {
    id: "unattended-agent-loop",
    action: "prompt",
    tool: "bash",
    command: String.raw`--dangerously-skip-permissions\b|--yes-always\b|--no-sandbox\b`,
    reason: "starts another agent with approval and isolation disabled",
  },
  {
    id: "dns-or-tls-write",
    action: "prompt",
    tool: "bash",
    command: String.raw`\baws\s+route53\b|\b(?:cloudflare|flarectl|certbot|acme\.sh)\b`,
    reason: "changes DNS records or TLS certificates",
  },
  {
    id: "ci-disable",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgh\s+workflow\s+disable\b`,
    reason: "turns off CI checks",
  },
  {
    id: "tmp-wildcard-delete",
    action: "prompt",
    tool: "bash",
    command: String.raw`\brm\s+-[A-Za-z]*[rf][A-Za-z]*\s+(?:/tmp|\$TMPDIR)/\*`,
    reason: "wildcard deletion in a shared scratch directory",
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
    id: "git-discard-worktree",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgit\s+(?:restore|checkout)\s+(?:--\s+)?\.(?:\s|$)`,
    reason: "discards uncommitted changes across the working tree",
  },
  {
    id: "git-branch-force-delete",
    action: "prompt",
    tool: "bash",
    command: String.raw`\bgit\s+branch\s+-D\b`,
    reason: "deletes a branch even when it is not merged",
  },
  {
    id: "launchctl-unload",
    action: "prompt",
    tool: "bash",
    command: String.raw`\blaunchctl\s+(?:unload|bootout)\b`,
    reason: "stops a system or user service",
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
    tool: "read|write|edit|grep|glob|ls|find|search",
    excludePaths: ["**/.env.example", "**/.env.sample", "**/.env.template"],
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
      "~/.omp/agent/tool-gate.json",
      "~/.omp/agent/tool-gate.log",
      "~/.config/opencode/opencode.json",
    ],
    reason: "changing live permissions requires confirmation, including their symlinked source files",
  },
];

export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  enabled: false,
  backend: "model",
  model: "@smol",
  timeoutMs: 15000,
  maxPerSession: 200,
  onError: "deny",
  minAllowProbability: 0.95,
};

interface RawConfig {
  mode?: unknown;
  defaultAction?: unknown;
  log?: unknown;
  replaceDefaults?: unknown;
  rules?: unknown;
  classifier?: unknown;
}

export interface LoadedConfig {
  config: GateConfig;
  sources: string[];
  warnings: string[];
}

function readJson(path: string, warnings: string[]): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RawConfig;
    warnings.push(`${path}: config must be an object; unmatched calls will be denied`);
    return null;
  } catch {
    warnings.push(`${path}: cannot read or parse config; unmatched calls will be denied`);
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
    const excludePaths = candidate["excludePaths"];
    if (excludePaths !== undefined && (!Array.isArray(excludePaths) || !excludePaths.every(entry => typeof entry === "string" && entry !== ""))) {
      warnings.push(`${origin}: rule ${id} has invalid excludePaths`);
      continue;
    }
    if ((paths !== undefined && (paths as string[]).length === 0) ||
        (candidate["tool"] !== undefined && (typeof candidate["tool"] !== "string" || !(candidate["tool"] as string).trim()))) {
      warnings.push(`${origin}: rule ${id} has an empty path list or invalid tool`);
      continue;
    }
    rules.push({
      id,
      action: action as Action,
      tool: typeof candidate["tool"] === "string" ? (candidate["tool"] as string) : undefined,
      command: command as string | undefined,
      paths: paths as string[] | undefined,
      excludePaths: excludePaths as string[] | undefined,
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
  const project = readJson(projectPath, warnings);
  const user = readJson(userPath, warnings);
  let brokenConfig = warnings.length > 0;
  if (user) {
    const validSettings: Record<string, (value: unknown) => boolean> = {
      mode: value => MODES.includes(value as Mode),
      defaultAction: value => ACTIONS.includes(value as Action),
      log: value => typeof value === "boolean",
      replaceDefaults: value => typeof value === "boolean",
      rules: value => Array.isArray(value),
      classifier: () => true, // validated below
    };
    for (const [key, value] of Object.entries(user)) {
      if (!Object.hasOwn(validSettings, key) || !validSettings[key]!(value)) {
        warnings.push(`${userPath}: invalid or unknown setting ${key}`);
        brokenConfig = true;
      }
    }
  }
  if (project) sources.push(projectPath);
  if (user) sources.push(userPath);

  // A project file can tighten policy but never loosen it: an agent may be able
  // to write into the repository, so project settings must not disable the gate.
  const projectRules = validateRules(project?.rules, projectPath, warnings).filter((rule) => {
    if (rule.action === "allow") {
      warnings.push(`${projectPath}: rule ${rule.id} ignored (project files cannot add allow rules)`);
      return false;
    }
    return true;
  });
  const beforeUserRules = warnings.length;
  const userRules = validateRules(user?.rules, userPath, warnings);
  if (warnings.length > beforeUserRules) brokenConfig = true;
  const replaceDefaults = user?.replaceDefaults === true;
  if (project?.replaceDefaults === true) {
    warnings.push(`${projectPath}: replaceDefaults is user-only and was ignored`);
  }

  const mode = ((): Mode => {
    const candidate = user?.mode;
    if (typeof candidate === "string" && MODES.includes(candidate as Mode)) return candidate as Mode;
    return "enforce";
  })();

  let defaultAction = ((): Action => {
    if (brokenConfig) return "deny";
    const candidate = user?.defaultAction;
    if (typeof candidate === "string" && ACTIONS.includes(candidate as Action)) return candidate as Action;
    return "allow";
  })();

  const log = user?.log !== false;

  // The classifier can be enabled (tightening) but a project file must not be
  // able to turn it off or change its error policy.
  const classifier = { ...DEFAULT_CLASSIFIER };
  if (project?.classifier !== undefined) {
    warnings.push(`${projectPath}: classifier settings are user-only and were ignored`);
  }
  const rawClassifier = user?.classifier;
  if (rawClassifier !== undefined) {
    if (typeof rawClassifier !== "object" || rawClassifier === null || Array.isArray(rawClassifier)) {
      warnings.push(`${userPath}: classifier must be an object`);
      brokenConfig = true;
    } else {
      const record = rawClassifier as Record<string, unknown>;
      const valid: Record<string, (value: unknown) => boolean> = {
        enabled: value => typeof value === "boolean",
        backend: value => value === "model" || value === "opencode-jev",
        model: value => typeof value === "string" && value.trim() !== "",
        timeoutMs: value => typeof value === "number" && Number.isFinite(value) && value >= 500 && value <= 120000,
        maxPerSession: value => typeof value === "number" && Number.isSafeInteger(value) && value >= -1,
        onError: value => value === "allow" || value === "deny" || value === "prompt",
        minAllowProbability: value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
        fallbackModel: value => typeof value === "string" && value.trim() !== "",
      };
      for (const [key, value] of Object.entries(record)) {
        if (!Object.hasOwn(valid, key) || !valid[key]!(value)) {
          warnings.push(`${userPath}: invalid classifier setting ${key}`);
          brokenConfig = true;
        }
      }
      if (typeof record["enabled"] === "boolean") classifier.enabled = record["enabled"];
      if (record["backend"] === "model" || record["backend"] === "opencode-jev") classifier.backend = record["backend"];
      if (typeof record["model"] === "string" && record["model"] !== "") classifier.model = record["model"];
      if (typeof record["timeoutMs"] === "number" && Number.isFinite(record["timeoutMs"]) && record["timeoutMs"] >= 500 && record["timeoutMs"] <= 120000) classifier.timeoutMs = record["timeoutMs"];
      if (valid["maxPerSession"]!(record["maxPerSession"])) {
        classifier.maxPerSession = record["maxPerSession"] as ClassifierConfig["maxPerSession"];
      }
      if (record["onError"] === "allow" || record["onError"] === "deny" || record["onError"] === "prompt") classifier.onError = record["onError"];
      if (typeof record["minAllowProbability"] === "number" && valid["minAllowProbability"]!(record["minAllowProbability"])) classifier.minAllowProbability = record["minAllowProbability"];
      if (typeof record["fallbackModel"] === "string" && record["fallbackModel"].trim() !== "") classifier.fallbackModel = record["fallbackModel"];
    }
  }
  if (classifier.backend === "opencode-jev" && !/^jev-\d+\.\d+(?:\.\d+)?(?:-free)?$/.test(classifier.model)) {
    warnings.push(`${userPath}: opencode-jev requires a versioned Jev model id`);
    brokenConfig = true;
  }

  // Reserve built-in ids first so repository rules cannot borrow a trusted
  // rule's session grant. Custom rules also have unique ids across both files.
  const ids = new Set(replaceDefaults ? [] : DEFAULT_RULES.map(rule => rule.id));
  const unique = (rules: Rule[], origin: string) => rules.filter(rule => {
    if (ids.has(rule.id)) {
      warnings.push(`${origin}: duplicate rule id ${rule.id} ignored`);
      return false;
    }
    ids.add(rule.id);
    return true;
  });
  const uniqueUser = unique(userRules, userPath);
  const uniqueProject = unique(projectRules, projectPath);
  if (brokenConfig) defaultAction = "deny";

  return {
    config: {
      mode: brokenConfig ? "enforce" : mode,
      defaultAction,
      log,
      rules: [...uniqueProject, ...uniqueUser, ...(replaceDefaults ? [] : DEFAULT_RULES)],
      classifier: brokenConfig ? { ...classifier, enabled: false } : classifier,
    },
    sources,
    warnings,
  };
}
