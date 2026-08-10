# Put lifecycle policy back in Foreman

**Status:** proposed
**Date:** 2026-08-10
**Reason:** Noolang PR #184 review thrash showed that unconditional plugin transitions displaced Foreman's contextual judgment.

## Decision proposal

The task-events plugin becomes a delivery adapter, not a workflow engine. It may observe task events, deduplicate delivery, and notify Foreman. It must not automatically spawn Verifiers, re-prompt Workers after denial, or infer that a task should continue.

A review request is a particularly important case: the reviewer's report is the output the human asked to inspect. Foreman should surface that report and stop. It should not silently add a second verifier whose job is to verify the first review unless the human or Foreman has a reason to request that extra assurance. The human's inspection is the intended final verification of the review output.

Foreman owns the next-step decision:

- Worker `done`: close/report, start an independent Verifier, or request another action.
- Verifier `deny`: ask the Worker to remediate only if the original scope permits it; otherwise close the review and report the finding.
- Any signal: acknowledge, investigate, escalate, halt, reassign, or close.

The default guidance can recommend verification for implementation work, but recommendation is prompt-level policy, not an unconditional hook.

## Proposed capabilities

1. `create_task` creates and records a task, but does not imply a fixed workflow.
2. Add Foreman capabilities to explicitly `start_verifier` and `prompt_worker`. A close/terminal operation is deferred until its halt-vs-close semantics are specified.
3. Keep durable task metadata and append-only events outside source worktrees.
4. Add delivery identity/acknowledgement so each event reaches Foreman once; terminal state prevents further routing without deciding what terminal means.
5. Preserve task scope and original request in every routed event. A denial never authorizes implementation by itself.
6. Require automated messages to use an unambiguous structured envelope and only recognize a signal when the envelope occupies the first complete line; ordinary user text containing marker-like text must remain ordinary text.

## Migration order

1. Change the plugin to notify Foreman only; remove spawn-on-done and deny-to-worker routing.
2. Move verifier-spawn construction into reusable Foreman-side code and expose it as an explicit tool.
3. Specify and implement a task-level halt/close lifecycle separately; do not add a misleading terminal command before its semantics are tested.
4. Update role prompts and README/vision language to describe verification as Foreman-selected, with a recommended default rather than a guaranteed transition.
5. Re-run the Noolang review scenario and an implementation scenario to verify both: review-only work stops after one report, while normal implementation still gets independently reviewed when Foreman chooses it.

## Non-goals

Do not replace Foreman judgment with a new mode-driven state machine. Metadata such as `scope` or `kind` may inform a decision, but should not automatically decide it.
