# Foreman-lite

Talk to one orchestrator agent (**Foreman**) while persistent **Workers** handle Task Threads and optional **Verifiers** independently check results. Code supplies sessions, isolation, and durable message delivery; Foreman decides contextually what happens next.

Built on [Herdr](https://herdr.dev) for visible task tabs and [Pi](https://github.com/earendil-works/pi-coding-agent) for agents. State transitions are pushed to Foreman without polling or typing into the human's editor.

## How it works

One Foreman Herdr workspace contains one tab per Task Thread. A task tab has a Worker pane and, when Foreman chooses independent checking, a persistent Verifier pane.

When creating a task, Foreman explicitly chooses:

- **shared** — use Foreman's current directory, including non-Git work;
- **git-worktree** — create a detached worktree for isolation while leaving branch and PR decisions to Worker.

Each role reports facts through signals:

- Worker: `planned(context)` · `done(context)` · `flag(context)`
- Verifier: `approve(context)` · `deny(context)` · `flag(context)`

`done(context)` may identify prose, a report, spec, path, commit, PR, or another artifact. Signals do not automatically spawn review or remediation. Foreman may message the existing Worker, start or reuse a Verifier with a contextual review request, alert the human, or take no action.

A Herdr plugin observes pane transitions and writes atomic messages to per-pane inboxes under `~/.foreman`. Role extensions deliver those messages with Pi's `sendMessage()` API. This keeps unfinished human editor drafts separate from machine events.

## Setup

```sh
brew install herdr
herdr integration install pi
herdr plugin link /path/to/foreman-lite/plugins/task-events
```

## Run

Start Foreman from the directory whose context tasks should share or isolate, inside a Herdr pane:

```sh
foreman-lite/bin/foreman
```

Ask Foreman to create work, research, reviews, or other Task Threads. Attach directly to any live role session with:

```sh
herdr agent attach <pane-id>
```

## Project layout

```text
extensions/                  role tools, task provisioning, structured inbox
roles/                       always-on Foreman/Worker/Verifier directives
skills/foreman/SKILL.md      on-demand operational and recovery reference
plugins/task-events/         signal observation and inbox delivery
docs/vision.md               user-owned source of truth
docs/plans/                  active implementation plans
```

## Status

The Foreman-judgment redesign is implemented and live-validated across shared non-Git tasks, detached-worktree tasks, arbitrary completion context, Worker/Verifier reuse, halt behavior, deduplicated delivery, and preservation of unsent editor drafts. See `docs/plans/foreman-judgment-redesign.md` for the evidence record.
