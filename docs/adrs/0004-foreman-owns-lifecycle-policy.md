# 0004. Foreman owns lifecycle policy, not the plugin

Status: accepted

## Context

An earlier implementation gave the task-events plugin unconditional workflow rules: every Worker `done` spawned or re-prompted a Verifier, every Verifier `deny` re-prompted the Worker to remediate, and `done` required a PR URL.

This broke on a review-only task (Noolang PR #184): a Worker produced a valid review and explicitly made no changes; the Verifier denied the unchanged PR repeatedly, and the plugin kept re-prompting the Worker to remediate. The Worker correctly refused — remediation would have contradicted the review-only scope — and the task thrashed with repeated lifecycle messages until the human asked why two agents were spinning.

The failure was over-automation: lifecycle decisions were encoded as unconditional mechanics (every completion implies verification, every denial implies remediation, every signal keeps the loop alive) in a layer that has no scope or intent context.

## Decision

Infrastructure provides mechanics only: durable task records, signals, direct attach, and event delivery. It must not auto-route.

- The task-events plugin observes pane transitions, deduplicates, and delivers signals to Foreman. It does not spawn Verifiers, re-prompt Workers, or infer that a task should continue.
- Worker `done(context)` accepts any ready result; no PR is required.
- Foreman decides the next step on every signal: close/report, start or reuse a Verifier, message the existing Worker, escalate, or take no action.
- A denial never authorizes remediation by itself — Foreman preserves original task scope and decides whether remediation is in scope.
- Verification, branches, PRs, and remediation are contextual choices Foreman makes, not protocol requirements.

## Consequences

Foreman's working memory carries lifecycle judgment that used to be encoded as fixed mechanics — it must actually decide on every signal rather than the plugin deciding for it. This is intentional: see `docs/vision.md`.
