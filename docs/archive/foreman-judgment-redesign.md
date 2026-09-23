# Restore Foreman judgment

**Status:** implemented and live-validated
**Shelf life:** retain as the implementation/evidence record; archive when the redesign has been stable through normal dogfooding.

## Problem

The implementation narrowed the flexible workflow in `docs/vision.md` into code-enforced assumptions: every task received an infrastructure-owned branch/worktree, Worker `done` required a PR, completion spawned/re-prompted a Verifier, and denial reactivated the Worker. Noolang dogfooding showed those mechanics fail on the second task shape: review output was itself the human’s deliverable, and remediation needed to preserve an existing PR rather than create another.

The intended boundary is:

- Code provides isolation, sessions, durable signals, and delivery mechanics.
- Worker reports contextual facts through `planned`, `done(context)`, and `flag`.
- Foreman decides what happens next, including whether and what to verify.
- PRs, branches, remediation, and verification are contextual choices, not protocol requirements.

Never edit `docs/vision.md`, `AGENTS.md`, or `CLAUDE.md`.

## Agreed task layout and placement

One Foreman Herdr workspace contains one tab per Task Thread:

```text
Foreman workspace
├── Foreman tab
├── Task A tab
│   ├── Worker pane
│   └── optional persistent Verifier pane
└── Task B tab
    └── Worker pane
```

`create_task` explicitly asks Foreman to choose placement:

- `shared`: Worker tab starts in Foreman’s current directory.
- `git-worktree`: infrastructure creates a detached Git worktree, then starts the Worker tab there. Worker owns any later branch and PR decisions.

A worktree is an isolation option, not the definition of a Task Thread. Foreman may not be running in a Git repository; shared placement must work without Git.

### Herdr spike evidence

`docs/research/herdr-task-tabs-spike.md` records the live disposable test:

- `herdr worktree create --workspace <id>` created a separate top-level Herdr workspace and an attached branch; it does not implement task tabs or Worker-owned branches.
- `git worktree add --detach <path> HEAD` followed by `herdr tab create --workspace <id> --cwd <path>` created the desired task tab.
- Worker-style `git switch -c ...` succeeded afterward without affecting the main checkout.

## Safe automated message transport

Observed bug: `herdr agent prompt` types into the live editor and presses Enter. If the human has an unfinished draft, the draft and machine signal become one confusing message.

Automated messages must not use terminal input. Implement a structured file inbox watched by each role extension, which injects messages with Pi’s public `pi.sendMessage()` API. Required properties:

- Persist event before delivery.
- Scope delivery ownership to the active Pi session.
- Process queued events at `session_start`; close watcher at `session_shutdown`.
- Use structured custom messages, not user-role marker prose.
- Mark dedupe only after accepted delivery; retry failures.
- Fall back from `fs.watch` to polling.
- Use the same channel for Foreman signals and later Worker/Verifier directives.

Acceptance test: type an unsent Foreman draft, deliver a Worker signal, and confirm the draft is unchanged while a distinct signal is processed exactly once. Repeat while Foreman is working.

## pi-subagents reference spike

The installed `pi-subagents` 0.45.1 source was reviewed by a fresh read-only subagent. Conclusion: **keep foreman-lite independent; borrow transport/lifecycle patterns through public Pi APIs.**

Why not adopt:

- Children are headless `pi --mode json -p` processes with ignored stdin, not persistent visible sessions (`src/runs/background/subagent-runner.ts`).
- Herdr integration opens inspector dashboards, not attachable Task Thread conversations (`src/inspectors/herdr/actions.ts`).
- Resume revives a replacement from session JSONL rather than preserving an idle visible Worker (`src/runs/background/async-resume.ts`).
- Managed worktrees create `pi-parallel-*` branches and are patch/cleanup oriented (`src/runs/shared/worktree.ts`).
- Missions infer lifecycle from process results, which must not replace Foreman judgment.

Patterns to borrow:

- Session-owned persisted result watcher.
- `pi.sendMessage()` custom-message delivery.
- Retry and polling fallback.
- Mark-after-ack dedupe.
- Correlated supervisor request/reply envelopes.
- Explicit live-steer versus session-revival distinction.

The attractive implementation modules are internal package files, not supported exports. Reproduce the small patterns; do not deep-import them.

## Implementation record

The working tree contains both human changes and this redesign. Do not blindly reset or commit everything. Human-owned/protected changes appear in `AGENTS.md`, `CLAUDE.md`, and `docs/vision.md`; leave them untouched and out of automated cleanup.

Implemented:

- [x] Structured per-pane inbox with session ownership, startup drain, shutdown cleanup, `fs.watch` plus polling, immutable messages, and post-`sendMessage` delivery receipts.
- [x] Plugin reduced to role-specific signal observation, atomic inbox writes, and durable dedupe. It contains no workflow routing or terminal prompting.
- [x] Explicit `FOREMAN_TASK_ID`; task identity no longer depends on directory names.
- [x] `create_task` creates a tab in `HERDR_WORKSPACE_ID` with explicit `shared` or detached `git-worktree` placement.
- [x] Task metadata records discriminated placement plus workspace/tab/pane identity; branch and PR fields are not required.
- [x] Worker `done(context)` accepts arbitrary results without a PR URL.
- [x] `message_worker` safely reuses the persistent Worker session.
- [x] `start_verifier` accepts arbitrary contextual criteria and starts or reuses one persistent Verifier pane in the task tab.
- [x] Worker, Verifier, Foreman roles and derived operational docs generalized beyond PR workflows.

Live evidence:

- [x] Shared task ran in a disposable non-Git directory and returned a prose `done` with no PR.
- [x] Foreman workspace contained exactly the Foreman tab and one task tab.
- [x] Worker signal was delivered as `foreman-task-signal` and received a post-acceptance receipt in `delivered/`.
- [x] An unfinished Foreman editor draft remained visible and unchanged while signal delivery triggered during an active Foreman turn.
- [x] Concurrent duplicate plugin invocations for one Worker event produced one immutable message, and role filtering ignored a later Verifier event in the same task log.
- [x] A post-refactor protocol probe retained the immutable message and wrote a separate delivery receipt after `sendMessage()` returned.
- [x] Non-PR artifact verification created one Verifier pane; a second `start_verifier` request was delivered to that same pane.
- [x] Detached-worktree placement began on detached HEAD under `~/.foreman/worktrees/<id>` while the main checkout remained on `main`.
- [x] TypeScript, Prettier, plugin syntax, and whitespace checks pass.

Final live evidence:

- [x] Draft-preservation delivery passed while Foreman was idle as well as while actively working.
- [x] Halting a Worker during `sleep 60` produced `Operation aborted`, zero task events, and no corrective reminder; Herdr reported the preserved Pi pane as settled `done`.
- [x] `message_worker` drove `planned → directive → done` with the Worker reporting `cobalt`; Herdr's Pi session path was identical before and after.
- [x] The earlier Herdr spike proved a Worker can create its own branch after detached provisioning; the redesigned live test proved provisioning itself starts detached.

Do not edit the vision.
