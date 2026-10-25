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

1. `<project>/.omp/tool-gate.json`
2. `<agent dir>/tool-gate.json` (this machine: `~/.omp/agent/tool-gate.json`, tracked in dotfiles)
3. the built-in defaults in `src/config.ts`

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
| history loss | `git push --force` (not `--force-with-lease`), `git reset --hard`, `git clean -fdx` | deny |
| unreviewed execution | `curl … \| bash`, `wget … \| sh` | deny |
| disk destruction | `dd of=/dev/…`, `mkfs`, `diskutil erase*` | deny |
| machine control | `shutdown`, `reboot`, fork bombs, writing `/etc` | deny |
| exfiltration | `env \| curl`, `cat ~/.ssh/id_rsa \| nc` | deny |
| credentials | reads/writes of `~/.ssh/**`, `~/.aws/**`, `**/.env`, `**/*.pem`, `secrets/env.sh` | deny |
| agent's own config | writes to `~/.claude/settings.json`, `~/.omp/agent/config.yml` | prompt |
| infra | `sudo`, `docker system prune`, `kubectl delete ns`, `terraform destroy`, destructive SQL | prompt |
| publishing | `npm/bun publish`, `cargo publish`, `twine upload`, history rewrite | prompt |
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

## Development

```sh
bun install
bun run typecheck
bun test --isolate     # 77 tests: matching, rules, config precedence, hook behaviour
```
