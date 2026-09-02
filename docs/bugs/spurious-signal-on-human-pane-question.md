# Nag forces a spurious signal when a human questions an attached role

Status: fix implemented on branch `fix-spurious-signal-on-human-question`, not yet live-validated.
Shelf life: delete once a Worker has been questioned via `herdr agent attach`
in a real session and confirmed not to emit a `worker_signal` or ping Foreman.

## Symptom

A human attaches to a Worker or Verifier pane, asks a plain question, the role
answers in chat — and the turn-end nag then forces a `worker_signal` /
`verifier_signal`. That signal writes `events.jsonl`, the task-events plugin
sees the pane transition, queues `foreman-task-signal` into Foreman's inbox, and
Foreman comments on what was just a side conversation.

Captured live in
`~/.pi/agent/sessions/--Users-jethrolarson-.foreman-worktrees-design-explicit-trait-s-mtjo922w--/2026-09-02T05-44-50-130Z_01a060a6-0cd2-7409-a485-4b0ffdec1624.jsonl`:
two human questions ("how are hkts supported by that?", "and types with more
than one type param?"), each followed by a `worker-signal-reminder` and then a
`worker_signal` whose `done` context is just a paraphrase of the chat answer.

## Cause

`worker.ts` / `verifier.ts` inject a corrective `*-signal-reminder`
(`triggerTurn: true`) on every `agent_end` that lacks a signal, with no attempt
to distinguish task work from a human aside — deliberately, per the comment in
`calledWorkerSignal`: "add an exception then, with a reason, not preemptively."
This is that exception.

`agent_end.messages` carries only the current run's messages
(pi-agent-core `runAgentLoop` returns `newMessages`), so a later human question
run is `[user("…"), assistant("…")]` — shape-identical to the session's first
run `[user(<prompt file>), assistant…]`. Content alone cannot tell them apart.

## Fix

`extensions/signalReminder.ts` — `runOrigin(messages, firstRunOfSession)`:

- initiator is `custom` (a `foreman-*-directive` from the inbox, or a prior
  forcing reminder re-running) → `task`;
- initiator is a bare `user` message and it is the session's first run → `task`
  (the prompt);
- initiator is a bare `user` message on any later run → `human`;
- no initiator (signal-only or empty run) → `task` (fail safe).

`firstRunOfSession` is a latch each extension holds (`sawFirstRun`), set on the
first `agent_end`. Every legitimate "role owes a signal" run other than the
initial prompt arrives as a `custom` message, so the latch only has to catch
that one case.

On `human` origin the extensions send a non-forcing advisory
(`triggerTurn: false`) instead of the forcing nag — the model is no longer
driven toward a signal, so no role-prompt directive is needed. In the captured
session every spurious signal followed a `*-signal-reminder`; none was
volunteered. If unprompted post-question signaling ever shows up, add a role
directive then, with that provenance.

## Known limits

- A human who gives the attached role real new work ("also fix the config") is
  classified `human`, so no signal is forced. Acceptable: the human is present
  and can ask for one, or Foreman can `message_worker`. Post-`MAX_NAGS` the
  extension already tolerates a signal-less terminal state.
- A model-error auto-retry after the first run still consumes the latch; a
  later genuine task run initiated by a bare `user` message (uncommon) would be
  classified `human`. Low stakes — a human watching a retry can prompt a signal.
