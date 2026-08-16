# Testability refactor and test backfill

**Status:** implemented 2026-08-10; retain until the suite has proved stable enough to archive
**Why now:** the Foreman-judgment redesign is live-validated, but its regression evidence is mostly manual. Transport, lifecycle, and command construction are deterministic mechanics and should fail quickly in local tests rather than during orchestration.
**Shelf life:** keep until the suite covers the mechanics below; then convert remaining gaps into ordinary issues and archive this plan.

## Decision

Use Vitest for automated tests. Pi's own package declares Vitest as its test runner, so matching it reduces tooling novelty. The published Pi package does not include a dedicated extension-test harness, but it publicly exports enough SDK surface to test extension registration and events without model calls:

- `createExtensionRuntime`
- `ExtensionRunner`
- `SessionManager.inMemory()`
- `DefaultResourceLoader` with inline extension factories

Prefer real temporary files for filesystem protocol tests. Inject the state root, clock, and ID generation where determinism matters; do not build a broad fake filesystem.

Keep live Herdr tests separate from the default suite. They prove terminal/editor integration that unit tests cannot, but they require shared machine infrastructure and should not make `npm test` flaky.

## Refactor boundaries

### Inbox protocol

Separate the durable protocol from the Pi lifecycle adapter:

- Protocol owns immutable message creation, owner claims, undelivered discovery, failure receipts, and delivery receipts.
- Adapter owns `session_start`, `session_shutdown`, `fs.watch`, polling, and `pi.sendMessage()`.
- Pass the state root, `now()`, and `newId()` into protocol construction. REASON: tests need isolated paths and deterministic receipts; production still supplies `~/.foreman`, `Date.now`, and `randomUUID` at the edge.
- Preserve atomic create-if-absent semantics. REASON: concurrent Herdr plugin processes must converge on one immutable message without marking an event delivered before Pi accepts it.

Do not add asynchronous abstractions unless an actual awaited operation appears. Current delivery is synchronous; pretending otherwise previously created unnecessary reentrancy state.

### Foreman mechanics

Extract command planning from command execution only where a test needs the seam:

- Git worktree argument construction and rollback decision.
- Herdr task-tab and pane-run argument construction.
- Worker/Verifier launch command construction.
- New-versus-reused Verifier decision.

Use a narrow injected command runner rather than mocking Node globally. Do not turn every helper into a public API; tests may exercise exported internal helpers from a clearly named mechanics module.

### Signal extensions

Make reminder decisions directly testable for Worker and Verifier:

- signal present,
- ordinary omission,
- provider/model error,
- explicit abort,
- reminder limit.

Keep Worker and Verifier policy tests separate initially. Consolidate their similar code only if the tests demonstrate that one shared concept reduces divergence; duplication alone is not sufficient reason.

### Herdr plugin

Move pure event-to-message behavior out of the executable top-level module. Keep `notify.mjs` as a thin environment/process adapter so importing testable logic never calls `process.exit`.

Use subprocess tests for the wrapper with a temporary `HOME`; this verifies the real environment contract and atomic cross-process dedupe.

## Backfill matrix

### Inbox

- Two concurrent writers with the same ID produce one complete immutable message.
- A different ID produces a distinct message.
- Successful `sendMessage` writes one delivery receipt.
- A thrown `sendMessage` writes no delivery receipt and the next drain retries.
- Malformed input receives a failure receipt without blocking later messages.
- A stale session owner cannot deliver or delete the current owner's claim.
- Session shutdown closes watcher/poller and removes only its own owner claim.
- Existing messages are drained at session startup.
- Polling still delivers after watcher setup or watcher notification fails.

### Task and signal state

- Missing or blank `FOREMAN_TASK_ID` fails clearly.
- Shared tasks with the same directory retain distinct IDs.
- `done(context)` accepts prose, path, commit, and PR-shaped context without a dedicated PR field.
- Worker and Verifier skip reminders after `error` and `aborted` stop reasons.
- Ordinary omission triggers a reminder and the configured bound stops further turns.
- Calling the role's signal resets its reminder cycle.

### Foreman tools

- Shared placement performs no Git command.
- Git-worktree placement resolves the repository and uses `git worktree add --detach` without a branch flag.
- Tab creation targets `HERDR_WORKSPACE_ID`, supplies the selected directory and `FOREMAN_TASK_ID`, and does not create another workspace.
- Tab failure attempts worktree rollback; rollback failure remains visible in diagnostics.
- Worker launch carries explicit task ID, provider, model, extension, and prompt file.
- Verification accepts arbitrary context without a PR.
- First verification creates one pane; later verification queues to the existing pane.
- `message_worker` targets the recorded Worker pane.
- Halt targets the Worker pane and does not mutate Task Thread lifecycle state.

### Plugin

- Untracked panes and non-reactable statuses are ignored.
- Worker status uses the latest Worker event even when a newer Verifier event exists.
- Verifier status uses the latest Verifier event.
- Missing Foreman pane produces no message.
- Concurrent duplicate invocations produce one immutable message.
- The emitted message contains source, task, pane status, action, context, and event timestamp.
- No code path invokes `herdr agent prompt` or starts another role.

### Pi extension integration

Using Pi's public SDK without a model call:

- Foreman registers exactly the intended tools.
- Worker and Verifier register only their own signal tool.
- Role prompt hooks append the correct role and task ID.
- Inbox lifecycle handlers bind to session start/shutdown.
- Custom messages preserve `customType`, content, details, and delivery options.

## Commands and CI contract

Add:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`npm run check` remains the type gate and now enforces `noUnusedLocals` and `noUnusedParameters`. The completion gate for this plan is:

```sh
npm test
npm run check
npm run format:check
node --check plugins/task-events/notify.mjs
git diff --check
```

## Non-goals

- Do not test model judgment or exact prose. The role prompts align contextual decisions; deterministic tests should cover mechanics and structural authority boundaries.
- Do not run paid model calls in the default suite.
- Do not require a running Herdr server in the default suite.
- Do not invent task-close, cleanup, or inbox-retention semantics while adding tests. Those boundaries remain intentionally unresolved.

## Acceptance

The backfill is complete when a fresh checkout can run the commands above without external services, the live validation matrix remains documented separately, and each previously observed regression has a deterministic test at the lowest practical layer.
