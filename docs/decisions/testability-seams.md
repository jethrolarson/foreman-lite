# Deterministic mechanics test seams

**Status:** accepted 2026-08-10
**Why:** transport and orchestration regressions were reaching live Herdr sessions even though most affected behavior is deterministic.
**Shelf life:** keep while the inbox protocol, command-planning module, and task-event plugin remain in use; revise if those boundaries move.

## Decision

The inbox filesystem protocol is separate from its Pi lifecycle adapter. Production supplies `~/.foreman`, `Date.now`, and `randomUUID`; tests supply a temporary root, clock, and IDs. Messages and receipts remain real files so atomic create-if-absent behavior is exercised rather than simulated.

Owner claims use two records: `owner.json` selects the current token and `owners/<token>.json` proves that token is still live. Shutdown removes only its token record. This avoids the check-then-unlink race where an old session could delete a newer session's claim. The selector may remain after shutdown, but cannot authorize delivery without its matching claim; no inbox-retention policy is implied.

Each send also acquires an atomic `delivering/<message>.json` lease before its authority check can become stale. Lease acquisition is the delivery-authority linearization point: a session that owned the inbox there may finish its synchronous `sendMessage` and receipt even if another session claims the inbox during the call, while the new owner cannot concurrently redeliver that message. A thrown send releases the lease for the next drain. A lease whose recorded process is dead is reclaimable, preserving crash recovery; a live holder remains authoritative until it writes the receipt or releases after failure.

Foreman command construction lives in `extensions/foremanMechanics.ts`. It returns executable/argument plans while `foreman.ts` retains filesystem state, retry behavior, and contextual tool policy. `createForemanExtension` accepts a narrow runner with `run` and `runJson`; production binds it to `execFileSync`, while execution-level tests record deterministic Git/Herdr calls and outcomes. This is intentionally narrower than a general command framework.

The Herdr hook's event selection and notification construction live in `plugins/task-events/notify-core.mjs`. `notify.mjs` remains the process/environment adapter and the only module that may query Herdr. The pure module never exits a process or starts another role.

Vitest is the default local suite. Extension integration tests use Pi's public `DefaultResourceLoader`, `ExtensionRunner`, and `SessionManager.inMemory()` to exercise tool registration, prompt hooks, lifecycle events, and structured message delivery without a model call. Live Herdr validation remains separate and documented in `docs/handoff.md`; default tests require no Herdr server and make no model calls.

## Intentionally unresolved

The work does not define task closure, worktree cleanup after successful task creation, inbox message retention, or broader lifecycle transitions. Those remain outside this test backfill's authority.
