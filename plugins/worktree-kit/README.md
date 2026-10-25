# worktree-kit

Durable git worktrees for agent tasks, with placement that the agent cannot
choose.

```text
worktree { action: "create", repository, branch, baseRef? }
worktree { action: "list", repository }
worktree { action: "remove", repository, path, force? }
```

## Placement

`create` takes a repository and a branch — **never a path**. Placement belongs to
the active backend:

| Backend | When | Where the worktree goes |
| --- | --- | --- |
| `herdr` | `HERDR_ENV=1` | wherever Herdr puts it; the tool asks `herdr worktree create` and reports the path Herdr chose |
| `git` | otherwise | `<repository>/.omp/worktrees/<branch-slug>` |

Inside Herdr, `create` runs `herdr worktree create --cwd <repo> --branch <b> --base <ref> --no-focus`,
`list` runs `herdr worktree list --cwd`, and `remove` resolves the workspace with
`herdr worktree open --path` before removing it by workspace id. A worktree whose
workspace hosts the current session is **refused**, because removing it would close
the pane and kill the running agent.

The git backend keeps worktrees under the repository:

`feat/parser` becomes `.omp/worktrees/feat-parser`. The directory is added to
`.git/info/exclude` so nested worktrees do not pollute `git status` in the main
checkout.

A branch that already exists is checked out as-is (`git worktree add <path> <branch>`);
a new one is created from `baseRef` (default `HEAD`). `main`, `master` and `HEAD`
are rejected as worktree branch names, as are names with whitespace or a leading
dash.

## Dirty main

Before creating, the tool reads `git status --porcelain` in the main checkout.
If it is dirty, the result carries a cutover reminder instead of silently
leaving your edits behind:

> Move only this task's changes into the new worktree, then undo only those in
> main — never `git clean`, `git restore .` or `git reset --hard`.

Creation never moves, cleans or commits anything.

## Direct `git worktree` commands

The tool does not block Bash. It watches model-issued `git worktree add` and
`git worktree move` commands with an **absolute** destination:

- inside `<repository>/.omp/worktrees/` → nothing happens
- outside it → the command still runs, a reminder is prepended to its result,
  and the path is recorded in `<agent dir>/worktree-kit-incidents.json`

On the next session in that repository the agent is told about the stray
worktrees once, as a `nextTurn` message, until `worktree remove` clears them.
User bang commands (`!git ...`) are not observed.

## Direct command observation inside Herdr

The "outside the managed root" reminder only applies to the git backend. Under
Herdr, placement is Herdr's business, so a path elsewhere is not treated as an
incident.

## Deliberate limits

| Not implemented | Consequence |
| --- | --- |
| `gitGlobalArgs` / `worktreeArgs` passthrough (including `--trust-repository`) | no custom flags reach `git worktree add` or `herdr worktree create`; destination and branch arguments are owned by the tool |
| `remove` of a branch whose worktree is gone | pruning is left to `git worktree prune` |
| Herdr list when Herdr is not on `PATH` | the call fails with Herdr's error; `HERDR_ENV=1` is the signal that Herdr is the owner |

Each of those is a deliberate trade: less surface, less to get wrong. Add them
in `src/placement.ts` with a test, not in the handler.

## Development

```sh
bun install
bun run typecheck
bun test --isolate     # 41 tests: placement, parsing, git + herdr backends
```
