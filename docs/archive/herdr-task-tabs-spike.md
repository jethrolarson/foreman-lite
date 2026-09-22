# Herdr task-tab and Git worktree spike

**Status:** completed
**Date:** 2026-08-10
**Shelf life:** keep while task provisioning is being redesigned; archive once implemented and live-verified.

## Question

Can one Foreman Herdr workspace contain one tab per Task Thread while an implementation Worker gets an isolated Git worktree and creates its own branch?

## Results

### `herdr worktree create --workspace` does not group under that workspace

In a disposable repository and Herdr workspace `w3H`, this command:

```sh
herdr worktree create --workspace w3H --label no-branch --no-focus
```

created a new Git worktree **and a separate Herdr workspace** (`w3J`), not a new tab inside `w3H`. Omitting `--branch` created an attached branch automatically (`worktree/brave-cloud-5988`), so this command cannot preserve Worker ownership of branch selection.

Also, `--workspace` and `--cwd` are mutually exclusive for `herdr worktree create`.

### Manual detached Git worktree plus `herdr tab create` supports the desired topology

The tested sequence was:

```sh
git -C <repo> worktree add --detach <path> HEAD
herdr tab create \
  --workspace <foreman-workspace-id> \
  --cwd <path> \
  --label <task-label> \
  --no-focus
```

This produced:

```text
Foreman Herdr workspace w3H
├── original tab w3H:t1
└── task tab w3H:t2
    └── task pane w3H:p2, cwd = detached Git worktree
```

The detached worktree initially reported `HEAD (no branch)`. Running this inside it succeeded without affecting the main checkout:

```sh
git switch -c task/worker-owned
```

That allows infrastructure to provide isolation while the Worker owns branch creation.

### Tasks that do not need isolation

`herdr tab create --workspace <id> --cwd <existing-directory>` can create a task tab rooted in Foreman's checkout or any existing checkout/worktree. A Git worktree is therefore a placement option, not part of Herdr task grouping and not the definition of a Task Thread.

## Design implication

Use Herdr tabs for Task Thread layout. Provisioning should separately choose the pane directory:

- existing directory,
- existing Git worktree/checkout,
- or newly created detached Git worktree.

Do not use `herdr worktree create` for the one-Foreman-workspace / one-tab-per-task topology. It couples Git worktree creation to a new top-level Herdr workspace and creates a branch before Worker starts.

The spike resources were removed after testing; no project repository or live Foreman workspace was changed.
