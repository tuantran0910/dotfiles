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

1. **Rules** — deny → prompt → allow. Project → user → defaults breaks ties within an action. A prompt or session grant cannot mask another rule's denial.
2. **Read-only fast path** — `read`/`grep`/`glob`, and literal shell reads like `ls`, `git status`, `rg`, `cat` skip the classifier. Literal shell operands also pass through file path policy. Interpreters, package runners, newlines, expansion, executable hooks, and mutating flags require classification.
3. **Classifier** (optional) — only calls that matched no rule. It sees the complete arguments, canonical file targets, working directory, and retained user instructions. Tool results are excluded directly; hostile text can still reach it through proposed arguments.
4. **Default action** — `allow` unless configured otherwise.

The tracked policy uses **Jev Free through OpenCode Console**, with the session's
current coding model as an operational fallback. Jev uses a direct typed HTTP
request; it does not generate a text verdict or start a Bun child process.

The optional `model` backend uses pi-ai and can run in a child Bun process when
marketplace resolution prevents in-process loading. Its 2048-token output budget
leaves room for providers whose "disable reasoning" option actually maps to low
reasoning effort. Both inference and credential lookup receive the host session ID.

A classifier answer is `allow`, `deny` or `prompt`. Jev supplies a typed Choice with
validated probabilities; the model backend supplies one schema-valid `verdict`
tool call with a reason. Free-text JSON, conflicting verdicts, and aborted
or errored model completions are rejected. No answer (timeout, provider error,
unparseable response, budget exhausted) becomes `onError` — **deny by default**, the same
fail-closed choice Claude Code documents.

```json
"classifier": {
  "enabled": true,
  "backend": "opencode-jev",
  "model": "jev-1.13-free",
  "fallbackModel": "@current",
  "minAllowProbability": 0.95,
  "timeoutMs": 15000,
  "maxPerSession": -1,
  "onError": "deny"
}
```

Jev uses the [OpenCode Console System One endpoint](https://opencode.ai/v2/docs/console/models/#jev)
and your existing OpenCode Console/Go credential. It is separate from the Go chat
subscription endpoint; no TypeSafe account is needed. The configured model is the
limited-time free version, and the adapter does not substitute a paid Jev model.

An `allow` probability below 0.95 becomes `prompt`. This is a conservative routing
threshold, not a measured safety guarantee. A valid Jev denial or prompt is never
sent to the fallback to seek a more permissive answer. API errors, invalid responses
and timeouts can use `fallbackModel`; `@current` resolves the active session model
at the moment of fallback, without embedding a provider/model id in the guard.
The fallback may consume the current provider's paid/subscription allowance.

Jev gets up to three seconds (or half a shorter total timeout) when a fallback is
configured. The fallback gets the remaining overall deadline. Each provider attempt
counts against `maxPerSession`, including a fallback. With `onError: deny`, failure
of both backends blocks the tool. Omitting `fallbackModel` disables failover.

`maxPerSession: -1` removes the session attempt cap, as selected in the
tracked policy. A nonnegative integer keeps a finite cap; `0` permits no provider
attempts. The built-in default remains 200. Unlimited calls retain per-call
deadlines, caching, all rules and fail-closed error handling. Fallback attempts
can still consume the active model's paid/subscription allowance. With this code
already loaded, `/tool-gate reload` applies a changed limit without resetting the
usage counter; changing an exhausted finite limit to `-1` takes effect
immediately.

Classifier settings are user-only: a repository cannot enable, disable or soften it.
Authorization retains the eight most recent substantive user messages plus the
last two messages, in chronological order. Repeated short continuations such as
"continue" do not evict the task or its restrictions. The persisted session branch
is authoritative; interactive input is buffered only until persistence catches up.
Messages arriving without an input event are included too. Later restrictions
override older permissions, and historical tasks do not authorize unrelated work.
This is a bounded context window, not permanent authorization memory. Individual
instructions are never clipped; oversized review context still requires confirmation.

Both judge backends share a policy that explicitly covers authorized source/test
edits, appending test code, formatting, builds, typechecks and local tests. Shell
syntax and security-related words in source are not sufficient reasons to prompt;
every actual effect must still be authorized. Sensitive behavior hidden in tests,
heredocs or trailing commands remains subject to the same restrictions.

Verdicts are keyed by the complete call, cwd, canonical file targets and user
intent. Concurrent identical calls share one judge request. Transient failures
are not cached. Reloads, cwd changes and session switches invalidate the cache;
pending decisions are rejected after policy, session or intent changes.
`/tool-gate` shows calls used, cache size, model, loaded version and source directory.

One deadline covers the complete classification pipeline. An unresolved ordinary
judge alias fails closed; the session model is used only by an explicit `@current`.
Arguments or user context over 16,000 characters each require manual review;
the gate never sends a silently clipped call to the judge.

## Modes

| Mode | Behaviour |
| --- | --- |
| `enforce` (default) | deny/prompt rules act |
| `observe` | nothing is blocked; every decision is logged with `wouldBe` |
| `off` | guard disabled (still logged) |

Switch at runtime with `/tool-gate mode observe`. `/tool-gate` prints status,
`/tool-gate allow <rule-id>` grants one rule for the session, `/tool-gate reload`
re-reads config and clears cached verdicts and session grants. Cwd changes do the
same. A session switch also resets intent, the call budget and the runtime mode.
Classifier session approval covers the exact call and context shown in the prompt.

## Configuration

Files, in tie-breaking order (deny still outranks prompt and allow):

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

Rule fields: `id` (unique across all sources), `action` (`allow`/`deny`/`prompt`), `tool` (glob, `|`
alternation, default `*`), `command` (regex, bash only), `paths` (globs matched
against resolved absolute paths; `~` expands), optional `excludePaths` (every alias
must match an exception), `reason` (shown to the model on
deny, to the user on prompt).

Invalid rules and duplicate ids are dropped with warnings. An unreadable or
malformed existing file, invalid user rule, or invalid user/classifier setting
forces enforce mode and denies unmatched calls until corrected. Missing config
files still use the built-in defaults. User allow rules no longer override denies;
change the denying rule or explicitly replace defaults in trusted user config.

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

`<agent dir>/tool-gate.log`, one JSON line per final permission decision, rotated at
2 MB. Approval/denial, tool-call id and cwd are recorded after prompting. Logs use
0600 permissions and refuse symlink targets. Common credential-bearing command
details are redacted; this is a heuristic, not a guarantee that logs contain no secrets.

```json
{"ts":"2026-10-25T08:00:00.000Z","tool":"bash","decision":"deny","ruleId":"rm-root","detail":"rm -rf /"}
```

In `observe` mode the record carries `"wouldBe":"deny"`.

## Honest limits

- **Regex, not a shell parser.** `r''m -rf /`, `$(echo cm0gLXJm /)`, or a script
  file invoked by name can evade a command pattern. This raises the cost of an
  accident; it is not a sandbox.
- **Path rules see file tools and literal fast-path shell operands.** Arbitrary
  scripts and shell writes through `>` still rely on regex rules or the classifier.
  Implicit recursive reads such as `rg pattern .` can expose protected descendants;
  the path check covers the named target, not every file a subprocess may open.
- **Prompts need a UI.** Without one, a `prompt` rule becomes a denial with an
  explanation — deliberate, since guessing is worse.
- **The optional judge is fallible.** Rules are deterministic; classifier verdicts
  depend on model behavior. Withholding tool results reduces one injection channel,
  but does not remove prompt injection through tool arguments or script contents.
- **Session grants are memory-only.** A restart forgets them.
- **Symlinks are followed** for path rules, including existing parents of new
  files and symlinked literal policy targets (a workspace symlink to
  `~/.ssh/id_rsa` is still denied), including `~` resolved through
  `/var` → `/private/var` on macOS.
- **No filesystem or process isolation.** Concurrent path replacement, hard links,
  shell aliases/functions, Git hooks and hostile executables remain outside this
  guard's guarantees. Cached approval does not re-inspect changed script contents.
- **Custom regexes run synchronously.** A pathological project expression can
  stall the host. Project policy and other host extensions must be trusted;
  isolate regex execution or use a linear-time engine before accepting hostile policy.
- **Policy tampering is prompted**, not silently allowed: rewriting
  `tool-gate.json`/`.log` through bash hits `gate-tamper`.

## Install note

`omp plugin install` copies the plugin but does not install its dependencies. The
model backend (including fallback) needs one:

```sh
cd ~/.omp/plugins/cache/plugins/tuantran0910-dotfiles___tool-gate___<version>
bun install --production
```

`bootstrap.sh --omp` does this automatically for flat and nested cached plugins
that declare dependencies, including repairing incomplete installs. Without it the
model backend cannot load. Jev's direct HTTP adapter still works, but an unavailable
Jev request then has no usable model fallback and `onError: deny` blocks the call.

After upgrading the cached plugin, use `/restart` in an existing omp session to
load the new code and resume that session. `/tool-gate reload` reloads policy only.

## Judge evaluation

From this plugin directory, `bun run eval:jev` describes the evaluation without
making network requests. `bun run eval:jev --live --compare` sends the 20 labeled
synthetic proposals to Jev Free, comparing the frozen 0.3.8 prompt/context with the
current version. It never executes proposals or invokes the paid fallback.
Cases include authorized test appends, formatters, CSRF source refactors,
continuations, revocations, credential exposure, prompt injection and malicious
commands after a heredoc. `--output PATH` writes a new private JSON report and
refuses to overwrite existing files. A provider error stops the evaluation;
unavailable responses provide no evidence about model quality.

The 0.3.9 live comparison encountered HTTP 429 from the first request, including
the separate historical test-append replay. No improvement in model accuracy or
prompt frequency has been measured. The allow threshold remains 0.95.

Measured before 0.3.6 on this machine: 0.22 s to start the child process, ~7 s end-to-end for a
cold GLM classifier call, ~0 s for a cached verdict. Only calls that match no rule
pay it.

## Development

```sh
bun install
bun run typecheck
bun test --isolate
bun test --isolate --coverage
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
| Latency/cost | a model round-trip per judged call | fast rules; model round-trip for unmatched calls |
| Novel situations | can reason about intent | optional judge reasons about intent |
| Determinism | same input, may differ by model/version | rules deterministic; judge verdicts may vary |
| Injection resistance | tool results stripped; reviewed separately | tool results excluded directly; arguments remain an injection surface |
| Loosening by project file | deny rules always win | project files can only tighten |
| Audit | transcript | JSONL, one line per decision |

They compose: use omp's mode for per-tool prompting, then this plugin for
argument-level rules that stay identical across models and sessions.

The harness, review findings, compatibility changes and remaining risks are
documented in [REVIEW.md](REVIEW.md). CI runs the plugin tests on Linux and macOS.
