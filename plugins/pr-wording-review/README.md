# pr-wording-review

Stops machine-sounding text from reaching a pull request, before the PR exists.

Two halves, one pattern list:

- **rules/** — declarative rules that interrupt when the text appears literally in a
  command or an MCP tool call.
- **src/** — a small extension that covers what rules cannot see: a description
  passed as a file (`--body-file` / `-F`), where the command line holds only a path.

A match interrupts once and injects a reminder. Nothing is rewritten for you; the
agent decides whether to fix the wording or keep it with a reason.

## Coverage

| Write path | Handled by |
| --- | --- |
| MCP `*create_pull_request`, `*update_pull_request` | `rules/pr-wording-review.md` (41 patterns) |
| `gh pr create` / `gh pr edit` with inline `--title` / `--body` | `rules/pr-wording-review-bash.md` (9 pattern groups) |
| `gh pr create` / `gh pr edit` with `--body-file <path>`, `--body-file=<path>`, `-F <path>` | `src/index.ts` (reads the file, same patterns) |
| stdin: `-F -` with a heredoc or a pipe | `src/index.ts` (extracts the handed-over text) |
| a body file written earlier in the *same* command (`echo … > body.md && gh pr create -F body.md`) | `src/index.ts` (reads the redirected text) |
| `gh api /repos/<o>/<r>/pulls` with `title`/`body` fields | `src/index.ts` (reads the field values) |
| `--fill` / `--fill-first` (body from commit messages) | `src/index.ts` (inspects `@{upstream}..HEAD`, else the last 5 commits) |

The Bash rules require *both* a `gh pr create|edit` verb and a matched pattern in the
same command, expressed as paired lookaheads — otherwise `grep "seamless" notes.md`
would interrupt.

## Body-file behaviour

- Patterns are read from `rules/pr-wording-review.md` at runtime, so the runtime
  check and the rules can never drift apart.
- Paths resolve against the command's `cwd` (falling back to the session cwd).
- **Interrupts once per file per session**, then lets the retry through. Blocking
  forever would trap the agent behind a file it cannot edit; allowing silently
  would defeat the check. Inline rules use the same once-per-session idea.
- Fails open: an unreadable or not-yet-created file passes, because the command may
  be about to create it.

## Remaining limits

- `--fill` inspects `@{upstream}..HEAD` when an upstream exists; otherwise the last
  five commits. An unusual range can therefore miss or over-include commits.
- `gh pr review` (submitting a review, replying in review threads) is **not**
  covered — this plugin only guards PR *text*. Nothing currently blocks an agent
  from submitting a review.
- Patterns are heuristics. False positives are accepted: a review prompt costs one
  turn, a slop PR costs reviewer trust.

## Pattern families

- **Punctuation**: em dash, literal and escaped.
- **Praise adjectives**: `seamless`, `comprehensive`, `pivotal`, `crucial`,
  `vibrant`, `meticulous`, `cutting-edge`, `world-class`, `best-in-class`,
  `industry-leading`, `state-of-the-art`, `game-changer`, `revolutionary`.
- **Stock verbs**: `delve`, `leverage`, `utilize`, `foster`, `underscore`,
  `showcase`, `empower`, `unlock` + abstract noun.
- **Filler**: `it is worth noting`, `it is important to note`, `in order to`,
  `due to the fact that`, `in conclusion`, `to summarize`, `I hope this helps`,
  `let me know if you`.
- **Rhetorical shapes**: `not just … but …`, `in today's fast-paced world`,
  `in an era of`, `serves as`, `stands as`, `plays a crucial role`.
- **Uncited authority**: `experts believe`, `industry reports suggest`,
  `studies show that`.

Deliberate non-triggers: `within`, `across`, `feature`, `vector`, `robust` as a
technical property, identifiers in backticks. The selection is informed by published
observations of lexical over-representation in LLM-assisted writing (Juzek & Ward,
COLING 2025; Kobak et al., Science Advances 2025) — aggregate tendencies, not proof
that a given text was machine-written, hence a review prompt rather than a verdict.

## Install

```sh
omp plugin marketplace add tuantran0910/dotfiles
omp plugin install pr-wording-review@tuantran0910/dotfiles
```

Restart omp: rules and extensions load at session start.

## Development

```sh
bun install
bun run typecheck
bun test --isolate     # 31 tests: pattern extraction, command parsing, every write path
```

Adding a pattern: append one `- '(?i)...'` line to the rule file's `condition`
list. Both halves pick it up; nothing else to edit.
