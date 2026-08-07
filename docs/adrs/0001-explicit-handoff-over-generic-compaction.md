# 0001: Task-triggered handoff docs as primary; overflow-triggered compaction as fallback only

## Status

Accepted (revised)

## Context

Working memory gets expensive and needs to shrink or reset at some point.
vision.md stakes out a position: checkpointing should be semantic
serialization tied to the task (decision, context, alternatives rejected,
current state, open questions — ADR-shaped), triggered by task lifecycle
(`/done`, `/checkpoint`, role handoff), not by a generic "conversation got
long" timer.

Checked against opencode's actual implementation
(`packages/core/src/session/compaction.ts`) rather than assumption:

- **Trigger**: `compactIfNeeded` fires only when the request would overflow
  context (`estimate(...) > context - max(output, buffer)`, buffer default
  20k tokens). It's overflow-triggered, not proactive/aggressive — closer
  to a last-resort safety net than continuous summarization.
- **Shape**: the forced template (Objective / Important Details / Work
  State: Completed·Active·Blocked / Next Move / Relevant Files) is
  structured, not free-text — closer to a handoff doc than "generic
  summarization" as originally characterized here.
- **Gap**: no field for rejected alternatives / negative knowledge — the
  "we considered X and rejected it because Y" piece vision.md cares about
  to stop future work re-litigating settled arguments. Also triggered by
  token overflow, not by task lifecycle — a task can get compacted mid-role
  for resource reasons alone, independent of whether the work reached a
  meaningful boundary.

## Decision

Primary checkpoint mechanism is task-triggered, ADR-shaped handoff docs:
written at lifecycle boundaries (`/done`, `/checkpoint`, role switch),
answering *if this working memory vanished, what would a future agent
need to know?*, including rejected alternatives.

Overflow-triggered compaction (opencode-style: structured template,
fires only near context limit) is an acceptable fallback for the case
task-triggered checkpointing doesn't cover — working memory overflows
mid-task, before a lifecycle boundary is reached. Not the primary
mechanism; a safety net for when the primary one hasn't fired yet.

## Consequences

- Checkpoint format needs a rejected-alternatives field that opencode's
  template lacks; can otherwise borrow its template shape and
  overflow-math (buffer/keep-tokens) as the fallback path's design.
- Two trigger conditions to maintain (lifecycle-driven, overflow-driven)
  instead of one — added complexity, deliberate.
- opencode's compaction code is closer to reusable than "rip out and
  replace" — the earlier framing of this ADR overstated the gap.
- If wrong — task-triggered checkpoints alone turn out sufficient and the
  overflow fallback never earns its complexity, or the reverse, overflow
  compaction turns out to cover everything and the lifecycle path is
  redundant — this ADR is the record to revisit and supersede.
