# Noolang review thrash

**Status:** confirmed; remediation not yet implemented
**Observed:** 2026-08-10 in the live Noolang session while reviewing PR #184
**Shelf life:** keep until the lifecycle model and review-only task behavior are redesigned.

## Evidence

A review-only request spawned a Worker and an automatic Verifier. The Worker produced a valid architectural review and explicitly made no changes. The Verifier denied the unchanged PR repeatedly, while the plugin re-prompted the Worker to remediate. The Worker correctly refused because remediation contradicted the original review-only scope. The task remained active and generated repeated lifecycle messages until the user asked why two agents had been spun up and why the workflow was thrashing.

## Design failures exposed

1. **No task mode.** Every `done` starts the normal implementation verification loop. A review task needs a review mode, or the requested reviewer must be the terminal reviewer rather than a Worker subject to another Verifier.
2. **No terminal state.** There is no explicit completed/closed state for a review task. Repeated idle/status events can retrigger work after the useful result already exists.
3. **Deny assumes remediation is valid.** The routing policy sends every denial back to the Worker without preserving the original scope or asking Foreman whether a new implementation task is authorized.
4. **Event routing is replay-prone.** Status changes are correlated to the latest event, so repeated transitions can produce repeated prompts and reviews. Dedupe reduces flicker but is not a lifecycle state machine.
5. **Signal transport is not isolated enough.** A malformed user message was concatenated with a `::foreman-signal::` marker, showing that marker-based text injection needs strict line/record parsing and collision handling.
6. **Foreman lacked a stop policy.** It acknowledged repeated signals instead of recognizing that the task was terminal and halting/closing the loop.
7. **There is no continuation capability.** When remediation was needed for PR #184, Foreman used `create_task`, which necessarily created a fresh worktree/branch and PR #186. Continuing an existing task must target its existing Worker/worktree/branch; a new task is not a safe substitute.

## Consequence

The fundamental failure was over-automation, not simply a missing `review` mode. We encoded lifecycle decisions as unconditional mechanics: every Worker completion spawned verification, every denial implied remediation, and every later signal kept the loop alive. Those rules displaced the Foreman's judgment precisely where the design says it should coordinate contextually.

Automation should provide capabilities and reliable observations; the Foreman should decide whether to verify, retry, reassign, close, or escalate. A task mode may still be useful metadata, but it must inform the Foreman's decision rather than become another rigid workflow gate.

This reverses an implementation assumption in the current design: the plugin should not own policy-heavy transitions. It should report signals and offer routing primitives. The Foreman should choose whether and how to invoke them.

## Design direction

1. Keep mechanical infrastructure: durable task records, signals, direct attach, and event delivery.
2. Stop unconditional plugin actions such as spawn-on-`done` and re-prompt-on-`deny`.
3. Push a compact event to Foreman and let it decide the next action, including no action / close.
4. Add an explicit continuation capability that prompts the existing Worker in its existing pane/worktree/branch; do not use task creation for remediation.
5. Preserve original task scope when presenting a denial; remediation requires an explicit Foreman decision.
6. Add terminal/acknowledged state only to prevent duplicate delivery, not to encode the workflow policy.
