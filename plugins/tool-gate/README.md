# tool-gate

Argument-level permission policy for omp tool calls: rules on **bash commands and
file paths**, a deterministic decision, and an audit trail.

## Why this exists (what omp already does, and what it doesn't)

Research into this omp build (18.12.6) and its SDK (`@oh-my-pi/pi-coding-agent`):

| omp mechanism | What it covers | Gap |
| --- | --- | --- |
| `tools.approvalMode` (`always-ask`, `always-ask-cached`, `write`, `yolo`) | decides *which capability tiers* prompt | all-or-nothing per tier; in print mode an unanswered prompt becomes a hard denial |
| `tools.approval.<tool>` (`allow`/`deny`/`prompt`) | per-tool override, authoritative even in `yolo` | keyed by tool name only — it cannot say "bash, except `rm -rf /`" |
| tool `approval` declarations | per-tool tier, optionally a function of args | only tools that ship one; not user-editable policy |
| extension `tool_call` hook | can block with a reason, or revise input | no policy layer ships with it |

On this machine the mode was `yolo` and `tools.approval` was `{}` — so nothing was
gated. Setting a stricter mode is not a substitute: with `--approval-mode=write`,
a headless run refuses *every* bash call ("no output was produced; nothing was
executed"), which breaks automation without protecting it.

`tool-gate` therefore gates **arguments**, not tools: `bash` stays usable, while
`rm -rf /` does not.

## How it composes with omp's own approval

- omp keeps deciding capability tiers and prompting as configured. If omp denies,
  this plugin never runs.
- `tool-gate` runs in the `tool_call` hook and can only make things stricter.
- It never *grants* what omp would ask about — approval is not a bypass.
- Recommended: leave `tools.approvalMode` as-is (this setup uses `yolo`) and let
  `tool-gate` be the argument-level layer. Set it stricter only if you also want
  per-tool prompts.

## Decision order

1. **Rules** — first match wins (project → user → defaults).
2. **Read-only fast path** — `read`/`grep`/`glob`, and shell commands like `ls`, `git status`, `rg`, `cat` skip the classifier.
3. **Classifier** (optional) — only calls that matched no rule. It sees the tool, the arguments, the working directory, and the user's last two instructions. It never sees tool results, so a hostile file cannot address it.
4. **Default action** — `allow` unless configured otherwise.

The classifier runs in a child `bun` process (in-process resolution of `pi-ai`
fails for marketplace plugins), so budget ~0.2 s of startup plus one small model
call. Measured here: 4 s was too short for a cold GLM call, hence the 15 s default.

A classifier answer is `allow`, `deny` or `prompt`; no answer (timeout, provider error,
unparseable text, budget exhausted) becomes `onError` — **deny by default**, the same
fail-closed choice Claude Code documents.

```json
"classifier": { "enabled": true, "model": "@smol", "timeoutMs": 15000, "maxPerSession": 200, "onError": "deny" }
```

Classifier settings are user-only: a repository cannot enable, disable or soften it.
Verdicts are cached per identical call for the session, and `/tool-gate` shows
calls used, cache size and model.

## Modes

| Mode | Behaviour |
| --- | --- |
| `enforce` (default) | deny/prompt rules act |
| `observe` | nothing is blocked; every decision is logged with `wouldBe` |
| `off` | guard disabled (still logged) |

Switch at runtime with `/tool-gate mode observe`. `/tool-gate` prints status,
`/tool-gate allow <rule-id>` grants one rule for the session, `/tool-gate reload`
re-reads config.

## Configuration

Files, highest precedence first — first matching rule wins:

1. `<project>/.omp/tool-gate.json` — **may only tighten**
2. `<agent dir>/tool-gate.json` (this machine: `~/.omp/agent/tool-gate.json`, tracked in dotfiles)
3. the built-in defaults in `src/config.ts`

A project file can add `deny`/`prompt` rules, but it cannot set `mode`,
`defaultAction`, `log` or `replaceDefaults`, and its `allow` rules are dropped
with a warning. An agent can often write into the repository it is working on, so
a repository must never be able to switch the guard off — the same principle as
Claude Code's "a deny rule can't be loosened by a more permissive project file".

```json
{
  "mode": "enforce",
  "defaultAction": "allow",
  "log": true,
  "replaceDefaults": false,
  "rules": [
    {
      "id": "no-deploy-from-agent",
      "action": "deny",
      "tool": "bash",
      "command": "\\bdeploy\\.sh\\b",
      "reason": "deployments are a human decision"
    },
    {
      "id": "protect-backups",
      "action": "deny",
      "tool": "read|write|edit",
      "paths": ["~/.dotfiles-backup/**"],
      "reason": "old configs may still contain credentials"
    }
  ]
}
```

Rule fields: `id` (unique), `action` (`allow`/`deny`/`prompt`), `tool` (glob, `|`
alternation, default `*`), `command` (regex, bash only), `paths` (globs matched
against resolved absolute paths; `~` expands), `reason` (shown to the model on
deny, to the user on prompt).

Invalid rules are dropped with a warning; a malformed file is ignored. Protection
never disappears because of a typo.

## Shipped rules

| Category | Examples | Action |
| --- | --- | --- |
| root/home destruction | `rm -rf /`, `~/`, `--no-preserve-root`, `chmod -R 777 /` | deny |
| history loss | `git push --force` (not `--force-with-lease`), `git reset --hard`, `git clean -f…` (`-n` dry runs pass) | deny |
| unreviewed execution | `curl … \| bash`, `wget … \| sh` | deny |
| disk destruction | `dd of=/dev/…` except `null`/`zero`/`stdout`/`stderr` sinks, `mkfs`, `diskutil erase*` | deny |
| machine control | `shutdown`, `reboot`, fork bombs, writing `/etc` | deny |
| exfiltration | `env \| curl`, `cat ~/.ssh/id_rsa \| nc` | deny |
| credentials | reads/writes of `~/.ssh/**`, `~/.aws/**`, `**/.env`, `**/*.pem`, `secrets/env.sh` | deny |
| agent's own config | writes to `~/.claude/settings.json`, `~/.omp/agent/config.yml` | prompt |
| infra | `sudo`, `docker system prune`, `kubectl delete ns`, `terraform destroy`, destructive SQL | prompt |
| publishing | `npm/bun publish`, `cargo publish`, `twine upload`, history rewrite | prompt |
| self-approval | `gh pr merge`, `gh pr review --approve` | deny |
| credential printing | `gh auth token`, `printenv *TOKEN*` | prompt |
| work loss | `git stash drop`/`clear` | prompt |
| registry bypass | installs forced to `registry.npmjs.org` | prompt |
| TLS / DNS | `curl --insecure`, `aws route53`, `certbot` | prompt |
| unattended agents | `--dangerously-skip-permissions`, `--yes-always` | prompt |
| CI / scratch | `gh workflow disable`, `rm -rf /tmp/*` | prompt |
| templates | `**/.env.example`, `.env.sample` | allow |

## Audit

`<agent dir>/tool-gate.log`, one JSON line per decision, rotated at 2 MB:

```json
{"ts":"2026-10-25T08:00:00.000Z","tool":"bash","decision":"deny","ruleId":"rm-root","detail":"rm -rf /"}
```

In `observe` mode the record carries `"wouldBe":"deny"`.

## Honest limits

- **Regex, not a shell parser.** `r''m -rf /`, `$(echo cm0gLXJm /)`, or a script
  file invoked by name can evade a command pattern. This raises the cost of an
  accident; it is not a sandbox.
- **Path rules only see file tools.** `bash` writing through `>` is covered by a
  few explicit rules (`/etc`), not by the path globs.
- **Prompts need a UI.** Without one, a `prompt` rule becomes a denial with an
  explanation — deliberate, since guessing is worse.
- **No model in the loop.** Deterministic by design: no judge to bribe, no latency
  on every call, no false confidence.
- **Session grants are memory-only.** A restart forgets them.
- **Symlinks are followed** for path rules (a workspace symlink to
  `~/.ssh/id_rsa` is still denied), including `~` resolved through
  `/var` → `/private/var` on macOS.
- **Policy tampering is prompted**, not silently allowed: rewriting
  `tool-gate.json`/`.log` through bash hits `gate-tamper`.

## Install note

`omp plugin install` copies the plugin but does not install its dependencies. The
classifier needs one:

```sh
cd ~/.omp/plugins/cache/plugins/tuantran0910-dotfiles___tool-gate___<version>
bun install --production
```

`bootstrap.sh --omp` does this automatically for any cached plugin that declares
dependencies. Without it the classifier cannot load, and `onError: deny` blocks
every unmatched non-read-only call — fail-closed, but not useful.

Measured on this machine: 0.22 s to start the child process, ~7 s end-to-end for a
cold GLM classifier call, ~0 s for a cached verdict. Only calls that match no rule
pay it.

## Development

```sh
bun install
bun run typecheck
bun test --isolate     # 241 tests, including a 131-case adversarial corpus
```

## How this compares to Claude Code's auto mode

Claude Code's `auto` mode replaces *you* with a second model. Its decision order
is: explicit allow/ask/deny rules first (critical-path `rm -rf /`/`~` removals are
never auto-approved and no allow rule can override them), then read-only actions
and in-workspace edits, then everything else goes to the classifier, and a
classifier denial returns the matched rule name. The classifier sees your
messages, the pending tool call and `CLAUDE.md`, but **not** tool results, so
hostile file content cannot address it directly. If the server returns no verdict,
the action is denied.

| | Claude auto mode | tool-gate |
| --- | --- | --- |
| Decision maker | classifier model (Sonnet 5 by default) | rules, then an optional `@smol` classifier for leftovers |
| Latency/cost | a model round-trip per judged call | microseconds |
| Novel situations | can reason about intent | miss unless a rule exists |
| Determinism | same input, may differ by model/version | same input, same answer |
| Injection resistance | tool results stripped; reviewed separately | no model to persuade |
| Loosening by project file | deny rules always win | project files can only tighten |
| Audit | transcript | JSONL, one line per decision |

They compose: use omp's mode for per-tool prompting, then this plugin for
argument-level rules that stay identical across models and sessions.
