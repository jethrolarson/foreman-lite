# 0005. Detached `git worktree` + `herdr tab create`, not `herdr worktree create --workspace`

Status: accepted

## Context

Task provisioning needs one Foreman Herdr workspace containing one tab per Task Thread, with an implementation Worker getting an isolated Git worktree while still owning its own branch creation.

`herdr worktree create --workspace <id>` does not produce that topology: tested against a disposable repo, it created a new Git worktree **and a separate Herdr workspace**, not a tab inside the given one. Omitting `--branch` also auto-created an attached branch (`worktree/brave-cloud-5988`), which takes branch selection away from the Worker. `--workspace` and `--cwd` are also mutually exclusive on that command, so it can't be pointed at an existing checkout either.

## Decision

Provisioning uses:

```sh
git -C <repo> worktree add --detach <path> HEAD
herdr tab create --workspace <foreman-workspace-id> --cwd <path> --label <task-label> --no-focus
```

Git worktree creation and Herdr tab/task grouping are kept as two separate, composable steps — not `herdr worktree create`'s combined one. The pane starts on detached HEAD; the Worker runs `git switch -c <branch>` itself. A task pane's directory is otherwise just an existing directory or existing checkout/worktree — a new detached worktree is one placement option, not part of what defines a Task Thread.

## Consequences

Do not reach for `herdr worktree create --workspace` for task provisioning even though it looks like the obvious single command — it collapses task-tab grouping and worktree creation together in a way that breaks both the one-workspace topology and Worker-owned branch creation.
