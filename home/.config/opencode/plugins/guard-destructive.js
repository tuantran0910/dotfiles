// guard-destructive.js
// Manually managed. Additive to herdr-agent-state.js — do not merge.
//
// Dual-mode plugin (plain object export, NO imports): the installed SDKs are
// V1 (`@opencode-ai/plugin`) and V2 (`@opencode/plugin` is not installed), so
// importing either would throw and silently disable the guard.
//   V2 runtime -> calls setup(ctx)   -> ctx.permission.hook("evaluate")
//   V1 runtime -> calls server()     -> "tool.execute.before" (throw to block)
//
// Posture: ASK for risky-but-legitimate actions (destructive commands, secrets
// access, destructive MCP tools); DENY only guard/config tampering. V1 cannot
// "ask", so on V1 these behave as deny (and allow-list mode denies unknowns).
//
// Scope (defense-in-depth, NOT a sandbox):
//   shell -> RISKY shapes escalate to ASK, ALLOW known-safe reads/builds.
//            Inline interpreters (python -c, heredocs) are intentionally NOT
//            matched; the AGENTS.md policy + the OS sandbox cover that class.
//   read  -> ASK on secrets dirs (.ssh/.aws/.gnupg)
//   edit  -> ASK on secrets (.ssh/.aws/.gnupg/.env*); DENY guard/config files
//   mcp   -> ASK on destructive tool names (delete/remove/purge/...)
//
// Self-protection: edit/write to this plugins dir and to opencode.json(c) is
// DENIED (not merely asked) so the guard cannot be talked out of existence.
// Maintain it via temp + `cp` (see sandbox/README.md).

const TAG = "guard.destructive";

// --- shell: escalate to ASK ------------------------------------------------
const RISKY = [
  { name: "rm/rmdir", re: /(^|[\s;&|()])(rm|rmdir)\s/ },
  { name: "find -delete / -exec rm", re: /\bfind\b[^\n|;&]*(\s-delete\b|-exec\s+rm\b)/ },
  { name: "git clean -f", re: /\bgit\s+clean\b[^\n|;&]*-[a-zA-Z]*f/ },
  { name: "git push", re: /\bgit\s+push\b/ },
  { name: "truncate/dd/mkfs/diskutil", re: /\b(truncate|dd|mkfs|diskutil)\b/ },
  { name: "shutdown/reboot", re: /\b(shutdown|reboot|halt|poweroff)\b/ },
  { name: "sudo", re: /(^|[\s;&|(])sudo\b/ },
  { name: "chmod/chown -R", re: /\b(chmod|chown)\b[^\n|;&]*-[a-zA-Z]*R/ },
  { name: "shell -c wrapper", re: /\b(bash|sh|zsh|ksh|dash|fish)\b[^\n|;&]*\s-c\b/ },
  { name: "pipe into shell", re: /\|\s*(base64\b[^\n]*\|\s*)?(bash|sh|zsh|python[0-9.]*|perl|ruby|node)\b/ },
  { name: "truncating redirect", re: /(^|[^>0-9])>(?!>)\s*(?!\/dev\/null)\S/ },
  { name: "in-place edit", re: /\b(sed|perl)\b[^\n|;&]*\s-i\b/ },
  { name: "tee overwrite", re: /\|\s*tee\b/ },
  { name: "remote package runner", re: /\b(npx|bunx|uvx|pipx|pnpx)\b/ },
];

// --- shell: known-safe allow ---------------------------------------------
const ALLOW = [
  /^git (status|diff|log|show|branch|blame|fetch|rev-parse|ls-files|remote)\b/,
  /^(ls|pwd|cat|head|tail|wc|which|echo|printf|file|stat|date|whoami|cd)\b/,
  /^(grep|rg|fd|find|jq|sort|uniq|cut|awk|sed|tr|xargs|mkdir|chmod|cp)\b/,
  /^(node|npm|pnpm|bun|yarn|cargo|go|rustc|tsc|python3?|pip3?|trash)\s/,
  /^(make|cmake|gcc|clang)\b/,
  /^opencode\b/,
];

// --- read/edit: secrets dirs (regex on the target path) -------------------
const SECRETS_PATH = [
  /(^|[\\/])\.ssh([\\/]|$)/,
  /(^|[\\/])\.aws([\\/]|$)/,
  /(^|[\\/])\.gnupg([\\/]|$)/,
];
const SECRETS_EDIT = [...SECRETS_PATH, /(^|[\\/])\.env(\.|$)/];

// Guard/config tamper: never (hard deny).
const TAMPER = [
  /(^|[\\/])\.config[\\/]opencode[\\/]plugins[\\/]/,
  /(^|[\\/])\.config[\\/]opencode[\\/]opencode\.jsonc?$/,
];

// --- mcp: destructive tool names (action is "<server>_<tool>") ------------
const DESTRUCTIVE_MCP = /(^|_)(delete|remove|destroy|purge|drop|unlink|trash|erase|wipe)(_|$)/i;

// V1 runtimes cannot "ask", so allow-listing there means: deny anything not
// explicitly allowed. Default ON. Set OPENCODE_GUARD_V1_ALLOWLIST=0 to fall back
// to deny-only behaviour in V1.
const V1_ALLOWLIST = (() => {
  const v = (typeof process !== "undefined" && process.env && process.env.OPENCODE_GUARD_V1_ALLOWLIST) || "";
  return v === "" ? true : !/^(0|false|off|no)$/i.test(v);
})();

function classifyShell(command) {
  const cmd = String(command ?? "");
  const risky = RISKY.find((r) => r.re.test(cmd));
  if (risky) return { effect: "ask", reason: risky.name };
  if (ALLOW.some((re) => re.test(cmd.trim()))) return { effect: "allow" };
  return null; // unknown: leave to config/default
}

function splitCommands(command) {
  return String(command ?? "").split(/\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

export default {
  id: TAG,

  // ---- V2 ---------------------------------------------------------------
  async setup(ctx) {
    try {
      console.error(`[${TAG}] setup: starting`);
      const permission = ctx && ctx.permission;
      if (!permission || typeof permission.hook !== "function") {
        console.error(`[${TAG}] FATAL: ctx.permission.hook unavailable; guard INACTIVE`);
        return;
      }

      await permission.hook("evaluate", (event) => {
        try {
          if (!event) return;
          const action = String(event.action ?? "");
          const raw = Array.isArray(event.resources) ? event.resources : [event.resources];
          const hit = (list) => raw.some((r) => list.some((re) => re.test(String(r))));

          // Guard/config tamper: hard deny first (never merely asked).
          if (action === "edit" && hit(TAMPER)) {
            event.effect = "deny";
            event.message = `${TAG}: blocked edit to guard/config`;
            console.error(`[${TAG}] DENY tamper`);
            return;
          }

          if (DESTRUCTIVE_MCP.test(action)) {
            event.effect = "ask";
            event.message = `${TAG}: destructive MCP tool (${action}) — confirm`;
            return;
          }

          if (action === "read" && hit(SECRETS_PATH)) {
            event.effect = "ask";
            event.message = `${TAG}: read of secrets path — confirm`;
            return;
          }

          if (action === "edit" && hit(SECRETS_EDIT)) {
            event.effect = "ask";
            event.message = `${TAG}: edit of secrets path — confirm`;
            return;
          }

          if (action !== "shell") return;

          for (const r of raw) {
            const d = classifyShell(r);
            if (!d) continue;
            event.effect = d.effect;
            event.message = d.reason ? `${TAG}: ${d.reason} — confirm` : undefined;
            if (d.effect === "ask") {
              console.error(`[${TAG}] ASK ${d.reason}: ${String(r).slice(0, 200)}`);
              return;
            }
          }
        } catch (err) {
          console.error(`[${TAG}] evaluate error: ${err && err.message ? err.message : err}`);
          event.effect = "ask";
          event.message = `${TAG}: internal error; confirming`;
        }
      });

      console.error(`[${TAG}] setup: ACTIVE`);
    } catch (err) {
      console.error(`[${TAG}] setup error: ${err && err.message ? err.message : err}`);
    }
  },

  // ---- V1 (also runs on V2 builds for backwards compat) ------------------
  // V1 has no "ask"; risky/not-allowlisted commands must be blocked by throwing.
  async server() {
    return {
      "tool.execute.before": (input, output) => {
        if (!input || (input.tool !== "bash" && input.tool !== "shell")) return;
        const command = output && output.args ? output.args.command : "";
        const parts = splitCommands(command);
        const candidates = V1_ALLOWLIST ? parts : [String(command ?? ""), ...parts];
        for (const part of candidates) {
          if (!part) continue;
          const d = classifyShell(part);
          if (d && d.effect === "ask") {
            console.error(`[${TAG}] DENY(v1) ${d.reason}: ${part.slice(0, 200)}`);
            throw new Error(`${TAG}: blocked (${d.reason}) — V1 cannot ask`);
          }
          if (!d && V1_ALLOWLIST) {
            console.error(`[${TAG}] DENY(v1) not-allowlisted: ${part.slice(0, 200)}`);
            throw new Error(`${TAG}: blocked (not on allowlist)`);
          }
        }
      },
    };
  },
};
