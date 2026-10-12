# 0006. Foreman interprets unsignaled stops; no local nag loop

Status: proposed (on trial; keep or revert after live testing)

## Context

Worker and Verifier extensions enforced a signal at turn end with a bounded nag loop: up to 3 corrective turns, then a warning. The nag ran with no task context, the same fixed-policy-in-mechanics shape ADR 0004 removed from the plugin. It also hid stops from Foreman: the plugin keys notification ids to the latest event, so a stop with no new event after an earlier signal was deduplicated away (a provider error during a follow-up was silent).

Why a run ends without a signal varies: finished but forgot, asked a question in prose, answered Foreman's question, provider error. In each case the final reply carries the meaning. The vision no longer requires every turn to end with a signal.

## Decision

Infrastructure reports unsignaled stops instead of enforcing signals. When work Foreman started ends without a signal, Foreman receives the child's final reply and decides what it means. Signals remain the preferred path.

## Consequences

- Every stop that matters reaches Foreman, at the cost of one Foreman turn per unsignaled stop.
- Nothing enforces signaling. A child that habitually skips signals costs Foreman inference instead of costing local corrective turns.
- Known gap: a signal followed by an unsignaled queued run before idle reaches Foreman as `stopped` only; the earlier signal stays in `events.jsonl`. The plugin delivers only the latest event.
- A harness adapter only needs to append one event at idle, not veto turn end. Origin detection (human or Foreman) is still per harness.
