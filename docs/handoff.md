# Handoff / checkpoint

**Current plan:** `docs/plans/foreman-judgment-redesign.md`
**Source of truth:** user-owned `docs/vision.md` (never edit it)

## Current implementation

The redesign now encodes mechanics rather than a fixed PR workflow:

- `extensions/foreman.ts`
  - Creates one Herdr tab per Task Thread in `HERDR_WORKSPACE_ID`.
  - Requires explicit `shared` or `git-worktree` placement.
  - Creates detached worktrees under `~/.foreman/worktrees/<id>` without creating a branch.
  - Starts persistent Workers with explicit `FOREMAN_TASK_ID`.
  - Provides `message_worker` through the structured inbox.
  - Starts or reuses a persistent Verifier with arbitrary contextual review criteria.
  - Retains `halt_worker` and human OS `flag`.
- `extensions/inboxProtocol.ts` and `extensions/inbox.ts`
  - Separate the durable filesystem protocol from Pi session/watch/poll lifecycle mechanics.
  - Own one inbox per Herdr pane/session.
  - Processes queued files at session start.
  - Uses `fs.watch` plus polling.
  - Keeps immutable messages and writes a `delivered/` receipt only after Pi `sendMessage()` accepts them.
  - Closes watchers and releases ownership at session shutdown.
- `plugins/task-events/notify.mjs`
  - Observes Worker/Verifier pane transitions.
  - Writes atomic, deduplicated structured messages to Foreman's inbox.
  - Contains no automatic verification, denial routing, or terminal prompting.
- `extensions/worker.ts`
  - Resolves identity only from `FOREMAN_TASK_ID`.
  - `done(context)` accepts any ready result; no PR field is required.
- `extensions/verifier.ts`
  - Verifies arbitrary artifacts or claims; PR comments are optional durable surfaces rather than protocol requirements.
- Worker and Verifier turn-end reminders skip provider errors and explicit aborts.

## Durable state

```text
~/.foreman/
├── registry.json
├── tasks/<id>/
│   ├── meta.json
│   └── events.jsonl
├── inboxes/<encoded-pane-id>/
│   ├── owner.json
│   ├── owners/<token>.json
│   ├── delivering/
│   ├── messages/
│   ├── delivered/
│   └── failed/
├── prompts/
└── worktrees/
```

Task records contain discriminated placement metadata, workspace/tab/pane IDs, and optional Verifier pane ID. They do not require branch, PR, or worktree fields. `owner.json` selects a session token while `owners/<token>.json` proves the claim is live, so stale shutdown cannot unlink a newer claim. Atomic `delivering/` leases plus ownership revalidation while the lease is held serialize synchronous send/receipt authority across session takeover; leases are reclaimed when their recorded process is dead.

## Live validation evidence

Previously live-verified facts that remain relevant:

- `herdr pane run` avoids the startup-timeout input-injection bug.
- `herdr agent send-keys <pane> esc` interrupts the turn while preserving the Pi session.
- Detached Git worktree + `herdr tab create --workspace` supports Worker-owned branch creation; see `docs/research/herdr-task-tabs-spike.md`.

The redesigned code passed TypeScript, formatting, plugin syntax, and whitespace checks. Disposable live tests also established:

1. A shared Task Thread runs in a non-Git directory and returns prose through `done(context)` without a PR.
2. Detached-worktree placement starts on detached HEAD while the main checkout stays on its existing branch.
3. Foreman and each Task Thread occupy separate tabs in one workspace.
4. Structured signals arrive without terminal prompting; unfinished Foreman drafts survive both idle and active-turn delivery.
5. `message_worker` drives `planned → directive → done` without changing the Worker's Pi session path.
6. `start_verifier` accepts non-PR criteria and a second request reuses the same Verifier pane.
7. Halting a Worker produces no task event or corrective reminder; the interrupted Pi session remains present.
8. Duplicate plugin invocations produce one immutable message, and role-specific lookup does not confuse Worker and Verifier events.

The test workspaces, task records, inboxes, and disposable repositories were removed afterward.

## Known boundaries

- No task-close or automatic cleanup command exists. Lifecycle and resource-retention semantics remain intentionally unspecified rather than guessed.
- Immutable inbox messages and receipts currently have no pruning policy. This favors recoverability during dogfooding; add retention only after real volume establishes a safe boundary.
- Historical registry/task records from the pre-redesign schema are not migrated. They remain incident evidence, but new orchestration tools should be used with newly created Task Threads.

## Repository safety

The working tree contains human-owned changes to `AGENTS.md`, `CLAUDE.md`, and `docs/vision.md`. Never reset, rewrite, stage indiscriminately, or otherwise overwrite them. Historical incident evidence is in `docs/bugs/`; the policy decision is in `docs/decisions/foreman-owned-policy.md`.
