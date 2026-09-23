# 0003. Deterministic mechanics test seams

Status: accepted

## Context

Transport and orchestration regressions were reaching live Herdr sessions even though most of the affected behavior is deterministic and testable without a model call or a running Herdr server.

## Decision

Vitest is the default local suite. Extension integration tests use Pi's public `DefaultResourceLoader`, `ExtensionRunner`, and `SessionManager.inMemory()` to exercise tool registration, prompt hooks, lifecycle events, and structured message delivery without a model call. Live Herdr validation remains separate and documented in `docs/archive/foreman-judgment-redesign.md`'s evidence record; default tests require no Herdr server and make no model calls.

Seams drawn to make mechanics independently testable:

- **Inbox protocol vs. Pi lifecycle adapter.** The filesystem protocol is separate from its Pi adapter. Production supplies `~/.foreman`, `Date.now`, and `randomUUID`; tests supply a temporary root, clock, and IDs. Messages and receipts remain real files so atomic create-if-absent behavior is exercised rather than simulated.
- **Owner claims** use two records: `owner.json` selects the current token, `owners/<token>.json` proves that token is still live. Shutdown removes only its own token record, avoiding a check-then-unlink race where an old session could delete a newer session's claim. The selector may outlive shutdown but can't authorize delivery without its matching claim; no inbox-retention policy is implied.
- **Delivery leasing.** Each send acquires an atomic `delivering/<message>.json` lease, then revalidates inbox ownership while holding it. That revalidation is the delivery-authority linearization point: a takeover between preliminary discovery and lease acquisition makes the old session stale before it can send, while a session still owning the inbox at revalidation may finish its synchronous `sendMessage` and receipt even if another session claims the inbox afterward. The lease stops the new owner from concurrently redelivering that in-flight message. A thrown send releases the lease for the next drain; a lease whose recorded process is dead is reclaimable, preserving crash recovery.
- **Command construction vs. execution.** `extensions/foremanMechanics.ts` returns executable/argument plans; `foreman.ts` retains filesystem state, retry behavior, and contextual tool policy. `createForemanExtension` accepts a narrow runner with `run` and `runJson` — production binds it to `execFileSync`, tests record deterministic Git/Herdr calls and outcomes. Intentionally narrower than a general command framework.
- **Herdr hook.** Event selection and notification construction live in `plugins/task-events/notify-core.mjs`, a pure module that never exits a process or starts another role. `notify.mjs` stays the process/environment adapter and the only module that may query Herdr.

## Consequences

Keep while the inbox protocol, command-planning module, and task-event plugin remain in use; revise if those boundaries move.

Intentionally left unresolved by this seam work: task closure, worktree cleanup after successful task creation, inbox message retention, and broader lifecycle transitions.
