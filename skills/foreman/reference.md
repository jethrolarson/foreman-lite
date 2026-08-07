# Task file format

Read/write these directly with your normal file tools — there is no API for task state.

## Location

`<project-root>/.claude/foreman-lite/tasks/<task-id>/` in the **main checkout**, not inside any task's worktree. Worktrees are separate directories; a task working in its own worktree still reads/writes task state via the main checkout's absolute path (passed to it in its assignment prompt), so state stays visible regardless of which worktree happens to be active.

## `task.json`

```json
{
  "id": "104",
  "title": "...",
  "description": "...",
  "source": "https://github.com/org/repo/issues/104",
  "status": "active | blocked | complete",
  "decisions": [{ "title": "...", "decision": "...", "why": "...", "date": "..." }],
  "unresolved": ["..."],
  "artifacts": ["..."],
  "updatedAt": "..."
}
```

Not a strict schema — extend it when a task genuinely needs more, don't pre-build fields nothing uses yet. `source` holds wherever the task came from (issue link, etc.) when there is one.

## `handoff.md`

Free-form append-only log. Whoever is about to end their turn appends what the next reader (possibly a future invocation with none of this working memory) would otherwise have to rediscover — not a transcript, the nygard-lite version: decision, why, what's still open.

## `adr/`

Only for decisions weighty enough to want their own file. Most decisions belong inline in `task.json`'s `decisions` array; reach for a separate ADR when one decision needs more than a couple sentences of context.
