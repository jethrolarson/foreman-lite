# Lifecycle edge-case audit

**Status:** findings; follow-up implementation needed
**Date:** 2026-08-10
**Trigger:** abort-reminder fix and review-flow redesign

## High priority

1. **Close propagation:** `close_task` updates the Worker record, but an already-created Verifier has its own registry record. The Verifier may continue delivering signals after closure unless closure is propagated to every record or the plugin reads canonical task metadata.
2. **Event loss:** the plugin routes the last event when a status change arrives. Two signals can be appended before one status event, causing the first signal to be skipped. Delivery needs a durable event sequence/cursor, not last-line lookup.
3. **Verifier race:** `start_verifier` currently launches pi before registering the new pane. A fast Verifier can emit a signal before the registry contains it.
4. **Shared-worktree race:** Foreman can start verification while the Worker is still modifying files. Starting a Verifier should require a completed/idle Worker state or make the snapshot boundary explicit.
5. **Close does not stop work:** closing suppresses routing but does not interrupt a running Worker/Verifier. Define close semantics: refuse while working, or halt children before marking closed.

## Medium priority

6. **Prompt-channel collision:** signals are injected as user text. A human message can be concatenated with or imitate the marker. Prefer a structured/custom event channel; at minimum require a complete first-line envelope and validate fields.
7. **Failure visibility:** error/aborted runs intentionally skip reminders, but provider failures currently do not necessarily produce a new Foreman event. A task can silently stall unless herdr blocked/error state is routed distinctly.
8. **Concurrent state writes:** registry and event writes are read-modify-write without locking or atomic replacement. Concurrent task events can lose registry entries.
9. **Repeated explicit signals:** dedupe is based on timestamp and plugin state, but a Worker can intentionally signal twice. Define whether every signal is meaningful, or enforce an event identity/acknowledgement contract.
10. **Task identity collisions:** IDs rely on millisecond time. Concurrent `create_task` calls can collide; use a collision-resistant suffix and fail safely if state already exists.

The first five affect correctness of the new Foreman-owned lifecycle and should be addressed before claiming the redesign is stable. The remainder are robustness work unless reproduced in dogfooding.
