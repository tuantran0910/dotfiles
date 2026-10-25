# Global Agent Instructions

Single source of truth shared by OpenCode, Claude Code, and Codex. The per-tool
files symlink (or import) this one, so edit **here** and every agent picks it up:

- OpenCode  : `~/.config/opencode/AGENTS.md`      -> symlink to this file
- Codex     : `~/.codex/AGENTS.md`                -> symlink to this file
- Claude    : `~/.claude/rules/00-global-safety.md` -> symlink to this file

## Shell & Filesystem Safety

Machine-wide rules.

**Hard rule: any command whose purpose is destructive or irreversible — remove,
delete, overwrite, truncate, prune, reset, force, or mass-edit — must be
confirmed with the user first, regardless of which CLI or language runs it.**
That covers `rm`, `rmdir`, `find -delete`, `truncate`, `dd`, `shred`, `sed -i`,
shell `>`, `git clean` / `git reset --hard` / `git push --force`, `docker rm` /
`docker system prune`, `kubectl delete`, cloud and database CLIs — and equally
the same act performed inside `python`, `node`, `perl`, `ruby`, `bash -c`, or
any script.

Inline interpreters are allowed on this machine **by design**, so no technical
guard can see what they do. This policy is the control for that whole class.

- Never delete or overwrite data the user did not ask you to remove.
- Do not run "cleanup" / "reset" / "prune" steps without explicit confirmation.
- Prefer reversible operations: `trash <path>` over `rm`; keep git history.
- Ask first for anything irreversible, and state the plan instead of executing.
- If a task seems to require deleting files, stop and describe it.

This is a hard rule, not a style preference.

## Knowledge Base (OpenCode only)

Skip this section unless you have the `basic-memory` MCP server (project
`notes`, stored as Markdown in `~/basic-memory`).

- **Search before answering** questions about the current project, prior
  decisions, or domain concepts: call `search_notes`, then `build_context` to
  follow `[[wikilinks]]`.
- **Read-only by default — never write automatically.** Do NOT call
  `write_note`, `edit_note`, `delete_note`, or `move_note` unless the user
  explicitly asks you to save or update something. The user decides what is
  worth keeping so the knowledge base does not fill with noise.
- **Folder convention (always use a namespace folder; never a bare `notes/`):**
  - Repo-specific findings -> `Projects/<repo-name>/` (e.g.
    `Projects/risingwave-thealtoclef/`).
  - General/domain knowledge not tied to a repo (e.g. "what is Iceberg?") ->
    `Concepts/` (e.g. `Concepts/Apache Iceberg`). Cross-link to the projects
    that use it with `[[wikilinks]]`.
  - Notes about the knowledge base itself / setup -> `Meta/`.
  - Ecosystem topics spanning several repos (e.g. the RisingWave stack) ->
    `Topics/<topic>/`.
  - Namespace folders are Capitalized; `<repo-name>`/`<topic>` are kebab-case.
- **File naming:** namespace folders are Capitalized; project/topic subfolders
  are kebab-case (`Projects/risingwave-thealtoclef/`); notes are descriptive
  Title Case (`What is RisingWave.md`, `Apache Iceberg.md`); the main note of a
  project/topic folder is always `Overview.md`; the root map of content is
  `Home.md`. Never name a file the same as its parent folder.
- **Links:** link with `[[Note Title]]` when the title is unique. When a
  basename repeats (e.g. every project folder has `Overview.md`), link by
  path: `[[Projects/<repo>/Overview|<repo>]]`.
- **Note format:** title, then `## Observations` with `- [category] fact`
  lines, then optional `## Relations` with `- relation [[Other Note]]`.
- **Observation categories — use ONLY this fixed set:**
  `definition`, `decision`, `requirement`, `finding`, `risk`, `tip`,
  `question`, `reference`, `setup`. Do not invent new categories. The
  canonical reference is the `Meta/Note Conventions` note.
- Keep notes concise and factual. Prefer updating an existing note over
  creating duplicates.

@/Users/tranngoctuan0910/.codex/RTK.md
