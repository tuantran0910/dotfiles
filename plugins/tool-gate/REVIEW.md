# tool-gate 0.3.6 review and regression harness

## 0.3.9 follow-up: authorization retention and development criteria

Both judge transports now share explicit criteria for task-authorized source/test
edits (including append/heredoc), formatting and local verification, with separate
treatment of source-code strings and actual command effects. The allow threshold
remains 0.95. Authorization retains eight substantive user messages and the last
two messages; repeated continuation replies do not evict the task. Persisted user
messages are consulted even after interactive input, fixing omission of newer
branch-only restrictions. In-flight decisions and UI approvals are rejected if
their user context changes. This window remains bounded, so older instructions
can still be omitted; it is not permanent authorization storage.

`authorization.test.ts` exercises extraction, task retention, restriction ordering,
temporary manager failures, session clearing, branch-only updates, stale approvals
and cache isolation. The opt-in `scripts/evaluate-jev.ts` compares 20 labeled
synthetic proposals against the frozen 0.3.8 policy/context without executing tools
or invoking a paid fallback. The live comparison and historical call replay both
received HTTP 429, so model-quality improvement is unmeasured. The runner now
stops on the first provider failure. Loaded version and source are shown in status
to distinguish a running old plugin from updated files on disk.
Local validation passes 517 tests across 16 files, typecheck (including the
evaluation script), marketplace validation and the evaluation's network-free mode.

## 0.3.7 follow-up: live classifier failure and Jev Free

The blocked statistics-test edit was reproduced with judgment-only requests;
the proposed edit was never executed. The old 300-token limit returned
`stopReason: length`, with 287 reasoning tokens and no verdict. This provider
maps `disableReasoning` to its lowest effort, so that option did not remove
reasoning from the shared output budget. The model transport now allows 2048
tokens, passes the host session ID through authentication and inference, and
logs sanitized failure categories and token counts.

The tracked policy now selects `jev-1.13-free` through the
[OpenCode Console System One API](https://opencode.ai/v2/docs/console/models/#jev).
Its typed choice, response model and probability distribution are validated;
an allow probability below 0.95 requires confirmation. Only an unavailable,
invalid or timed-out Jev answer can fall back to `@current`, resolved from the
active session at request time. There is no embedded fallback provider/model ID.
A valid deny or prompt never triggers fallback. Both attempts share the original
deadline and count against the session budget. The free model is not silently
replaced with paid Jev; the explicitly configured current-model fallback can
consume the current provider's allowance.

Seven live smoke cases matched their expected outcomes: the original test edit,
another authorized test edit and an authorized test command allowed; unrelated
private-key access, guard disablement, API deletion and infrastructure destruction
denied. Jev took approximately 0.38–0.92 seconds. A forced Jev outage successfully
used the actual session model for the original edit in approximately 2.3 seconds.
These were classification requests only, not tool execution or a model safety
benchmark. The deterministic harness adds typed-response, error, authentication,
deadline, cancellation, budget and dynamic-model regression coverage.
The complete local suite passes 490 tests across 14 files with `--isolate`;
typecheck, marketplace validation and `git diff --check` also pass.

The sections below record the original 0.3.6 review and its validation counts.

Reviewed on 2026-10-25 against 0.3.5, starting at repository commit `2d2099c`.
The original 244 tests and typecheck passed. The first added hook harness exposed
51 failures in 62 scenarios. Fixes and regression cases are included in this
working tree; this review does not claim that a regex/classifier gate is a sandbox.

## Findings fixed

| Priority | Finding in 0.3.5 | Reproduction / regression | Result in 0.3.6 |
| --- | --- | --- | --- |
| P1 | The read-only fast path approved arbitrary code execution | `python3 task.py`, `node -e ...`, `npm exec task`, `cargo run`, `npm test` | Interpreters, package runners and build/test commands require classification unless an explicit rule covers them. |
| P1 | Read-looking commands could mutate or execute helpers | Newline after `echo`, `sort -o`, `rg --pre`, `git diff --output`, a new Git branch, `/tmp/ls` | Literal-word parsing, conservative flags/subcommands and executable-path checks remove these fast paths. Quoted flags are decoded before checking. |
| P1 | A project prompt could weaken a built-in deny | Broad project prompt + `rm -rf /`; session grant made the prompt an allow | Matching deny beats prompt, which beats allow. Source order only breaks ties. A session grant cannot suppress another denial. |
| P1 | The first prompt in a compound command could hide a later deny | `curl -X DELETE ...; gh pr merge 12` | A matching deny wins before the UI is consulted. |
| P1 | Template allow rules bypassed credential denials | Multi-file edit of `.env.example` and `.env.production`; template symlink to a private key | Every target participates in the restrictive decision. Template exceptions require all aliases to be exempt. |
| P1 | Path resolution missed nonexistent children and policy aliases | New file below a symlink to `.ssh`; direct write to the tracked source of a symlinked live policy | Resolve existing ancestors of new targets, normalize absolute dot segments, and canonicalize literal policy paths too. Protected directory roots and explicit search targets are covered. |
| P1 | A 32-bit cache key could transfer permission between different calls | `touch Aa` and `touch B@` collide in the old hash | Full serialized call/context keys replace the hash. Canonical file targets, cwd and user intent participate. |
| P1 | Context changes and session switches could retain approval | Same call after “stop changing files”; cached verdict after cwd/reload; switch during pending approval | Reload/cwd/session changes clear verdicts and grants. Session changes reset budget, intent and runtime mode. Stale in-flight decisions are denied, including old observe-mode decisions. |
| P1 | The judge never saw the tail of long calls or user restrictions | Destructive intent after argument character 2000 or instruction character 400 | Complete inputs are supplied. Oversized arguments or intent require manual review instead of sending a clipped prompt. |
| P1 | A fallback import could load a project-supplied judge with credentials | Loader searched cwd and ancestor `node_modules` | Probe the normal import, explicit user override and plugin dependency directory only. |
| P2 | Failure handling was incomplete | Key lookup throws/hangs; loader hangs; completion ignores abort; subprocess hangs | Setup errors return no verdict. A total deadline covers all asynchronous phases, and cancellation kills the child. The configured fail-closed action is audited. |
| P2 | A missing judge alias silently selected the main model | `@smol` unresolved while the main model exists | Missing judge resolution returns no verdict, avoiding unintended provider/cost/safety changes. |
| P2 | The verdict parser accepted responses outside its forced schema | Free-text JSON, missing reason, conflicting calls, aborted/error responses | Exactly one valid verdict tool call with a nonempty reason is required. |
| P2 | Failure caching and concurrency harmed recovery and latency | Provider outage followed by recovery; eight simultaneous identical requests | Transient failures are retried, and identical in-flight requests share one judge call. Distinct concurrent requests still respect the session budget. |
| P2 | Classifier session approval was offered but ineffective | Approve a classifier prompt “for this session,” then repeat it | The grant covers the exact call and context; unrelated targets still require review. Duplicate rule ids cannot borrow trusted rule grants. |
| P2 | Audit logs recorded preliminary prompts rather than outcomes | UI denial and no-UI denial both logged as `prompt` | Record the final allow/deny, call id and cwd after the UI resolves. Private permissions, no-follow file opens and credential-detail redaction harden persistence. |
| P2 | Malformed policy silently lost classifier protection | Invalid JSON or misspelled classifier settings | Warn, enforce and deny unmatched calls until corrected. Missing files still use defaults. |
| P2 | Bootstrap skipped the actual plugin cache layout | Actual cache is `plugins/market___name___version/`; installer searched `plugins/*/*/` | A tested helper supports flat and nested caches, repairs incomplete installs and passes paths safely as arguments. |
| P2 | Ordinary CLI variants missed their advertised hard rules | `gh -R repo pr merge`, `gh pr review -a`, migration flags between subcommand and `--force`, `curl --request=DELETE` | Added matching variants and full-hook regressions. Forced Git clean dry runs remain usable. |

An existing “classifier prompt” test used `npm publish`, which was intercepted by
a deterministic rule before classification. It now uses an unmatched proposal and
asserts that the judge was actually consulted.

## Harness and validation

`test/harness.ts` instantiates the real extension entry point, records registered
hooks, supplies fixture policy and a fake UI/judge, and invokes the hook with inert
tool proposals. It never runs their command strings. Each instance has an isolated
temporary workspace and agent directory. Synthetic credentials are fixture text.

| Layer | What it verifies |
| --- | --- |
| Existing unit tests and frozen corpus | Original command/path behavior, matching, configuration and modes |
| `security.test.ts` | Full-hook fast-path bypasses, precedence, path aliases, cache collisions, approval outcomes and malformed settings |
| `invariants.test.ts` | Generated deny-monotonicity and target-order permutations, SDK hashline normalization, lifecycle races, budget concurrency and CLI spellings |
| `transport.test.ts` | Forced schema, setup/provider failures, every timeout phase, cancellation, trusted import candidates and complete context |
| `subprocess.test.ts` | Actual Bun child and pi-ai against a local canned HTTP/SSE provider, missing dependencies, pre-cancellation and cancellation of a running child |
| `audit.test.ts` | JSONL framing, rotation, permissions, symlink refusal, redaction and enforcement when logging fails |
| `bootstrap.test.ts` | Flat/nested fixture caches, incomplete installs, quoted paths and dry-run using a stub installer |

Run from `plugins/tool-gate`:

```sh
bun run typecheck
bun test --isolate
bun test --isolate --coverage
```

The local suite passes 427 tests across 13 files on macOS with Bun 1.3.10.
The reported coverage is 99.03% of lines and 97.42% of functions (including the
shared test harness); classifier source line coverage is 96.45%.
Typecheck, shell syntax checks, marketplace validation and `git diff --check`
also pass. CI now schedules plugin checks on Linux and macOS; those hosted runs
have not been executed from this working tree. The transport tests use no paid
model calls and do not establish the real judge model's detection accuracy.

## Compatibility and operation

- Rule precedence deliberately changes from global first-match to deny/prompt/allow.
  Trusted user allow rules no longer carve exceptions out of a deny. Remove/change
  the deny, deliberately replace defaults, or grant the relevant rule for the session.
- Commands such as `npm test` now reach the judge because package scripts execute
  arbitrary project code. A narrow trusted user allow rule can approve a known task.
- Reloads and cwd changes revoke session grants; a session switch also resets the
  runtime mode and budget. Explicit runtime modes still survive ordinary reloads.
- Oversized review input requires a UI; a headless session denies it. This can
  affect large generated-file writes and unusually long user instructions.
- Free-text judge responses no longer count as consent. Providers must support
  the verdict tool contract; failure applies `onError`, deny in the tracked policy.
- The package version is 0.3.6. The installed 0.3.5 marketplace cache is a separate
  copy and has not been updated or activated by these repository changes.

## Remaining risks and next priorities

1. **Process/filesystem isolation is still needed for a strong boundary.** Script
   contents, shell functions/aliases, Git-configured helpers, hard links, implicit
   recursive reads and concurrent symlink replacement are not fully mediated.
   For example, `rg pattern .` does not enumerate and authorize every descendant.
   Use OS-level filesystem/network restrictions and scoped credentials for work
   that must remain safe under hostile repository content.
2. **Custom regex can stall the host.** Project regex executes synchronously;
   `(a+)+$`-style patterns can block the event loop, where an async timeout cannot
   interrupt them. Treat project policy as trusted until matching moves to an
   interruptible worker or a linear-time regex engine. This is the next concrete
   hardening change, rather than adding more command patterns. Node's official
   [event-loop and ReDoS guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
   explains why timer-based deadlines do not solve synchronous regex exhaustion.
3. **Other host extensions are trusted code.** The installed SDK's extension
   runner aggregates input rewrites separately while each hook receives the tool
   event. The wrapper executes the aggregated replacement afterwards. This plugin
   therefore cannot guarantee that another extension's rewritten arguments are
   the exact arguments it authorized. Final-input validation needs host support;
   no upstream issue was filed.
4. **Judge quality is unmeasured here.** Excluding direct tool results does not
   prevent hostile content from being copied into proposed arguments. Keep a
   held-out, labeled evaluation set for real judge upgrades, including false
   positives and explicit user restrictions. Do not turn local mock-provider
   success or line coverage into a model safety claim. The two-message intent
   window can also omit older task constraints; persistent authorization needs
   a separate, explicitly maintained representation if that becomes a requirement.
5. **Cached approval does not inspect changed script contents or remote state.**
   Context and canonical-path keys fix permission transfer between calls, but
   identical script invocations can behave differently later. Prefer short-lived
   approval or no caching for state-sensitive operations if stronger assurance is
   required. A filesystem monitor alone would not cover remote-state changes.
6. **Audit and dependency delivery remain best effort.** Credential redaction is
   heuristic; concurrent multi-process rotation can lose entries. Repository CI
   intentionally forbids plugin lockfiles and uses the latest Bun, so installs are
   not fully reproducible despite the direct pi-ai pin. A dependency snapshot and
   pinned CI toolchain would improve upgrade reviewability under a revised policy.

Concurrency coalescing and the smaller trusted loader search are the useful
latency improvements in this change. Keep the 15-second fail-closed deadline;
lowering it to recover startup time would recreate cold-provider failures.
A persistent judge worker could save startup cost, but should follow bounded
concurrency, cancellation and credential-isolation design rather than precede it.

## Research checks

- [Claude Code permissions](https://code.claude.com/docs/en/permissions): documents
  deny before ask before allow, including precedence across rule specificity.
  The earlier claim that project prompts could only tighten first-match policy
  did not implement that property.
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes):
  documents dropping broad interpreter/package-run allow rules in auto mode,
  excluding direct tool results, and denying requests with no classifier verdict.
  These support conservative routing; they do not establish equivalent model
  quality or containment for this plugin.
- [GitHub CLI review options](https://cli.github.com/manual/gh_pr_review): confirms
  `-a` as the short form of `--approve`, now covered by the self-approval denial.
- The installed omp SDK source was inspected for hook input normalization,
  approval answers, exception handling and input rewrite behavior. No assumption
  was made that the current upstream main branch exactly matches the installed host.
