# Plan: foreman-lite vision as a pi extension

Status: draft. Depends on ADR 0002 (build on pi). Supersedes nothing;
this is the first implementation plan for this project — everything
before this was research/comparison.

## Why this order

Each milestone tests one vision.md claim in isolation, cheapest/most
load-bearing first, matching the incremental-exploration approach already
proposed for opencode in `base-system-comparison.md` (never executed
there — this restarts it against pi). Stop and write an ADR if a
milestone's claim fails; don't build the next milestone on top of an
unproven one.

Do not build the Director dashboard (M5) before M1-M4 hold up. This was
flagged as a mistake to avoid in both prior research docs.

## M0 — Task state store (no LLM behavior yet)

**Build:** `docs/tasks/<id>.md` file convention + a small extension module
that reads/writes them (no session/UI wiring yet, just the data shape).
Fields per vision.md's Task State definition: requirements, status,
decisions, rejected alternatives, relevant files, test results,
unresolved questions, handoff info.

**Claim under test:** file-based task state (per ADR 0001/0002) is
sufficient — nothing forces a database or session-native store
(`todo.ts`'s tool-result-details pattern) this early.

**Done when:** can hand-write and hand-edit a task-state file and have it
be the only thing a fresh context needs to resume work, no session
history involved. This is a manual test, not automated — the test is
"can a human (or `pi -p`) pick up the task from the file alone."

## M1 — Lifecycle signals as commands

**Build:** `/done`, `/checkpoint` as `pi.registerCommand()` handlers,
following `examples/extensions/structured-output.ts`'s `terminate: true`
tool-call pattern for the LLM-facing side (a `done` tool with typed
`{status, decisions, unresolved, artifacts}` params) rather than a
prose-parsed slash command. The command layer is for the human/foreman
side; the tool layer is for the LLM claiming done.

**Claim under test:** a schema-enforced tool call is a more trustworthy
completion signal than a prose "I'm done" — the "reported done" risk
flagged in `docs/research/agent-teams.md`.

**Done when:** the `done` tool's output writes straight into the M0
task-state file's status/decisions fields, no manual transcription.

## M2 — Checkpoint (Recycle)

**Build:** fork `examples/extensions/handoff.ts`. Changes needed:
1. Replace its free-text summary prompt with the ADR-shaped template
   (Decision / Context / Alternatives considered / Rejected / Consequences
   / Unresolved questions) per vision.md's Checkpointing section.
2. Change the trigger from user-invoked `/handoff <goal>` to
   foreman-invoked (fires on `done` tool call from M1, or manually via
   `/checkpoint`), using `session_before_compact` / `ctx.compact()`
   (`examples/extensions/custom-compaction.ts`, `trigger-compact.ts`) as
   the hook point instead of always creating a brand new session.
3. Write the generated checkpoint into the M0 task-state file, not just
   into a new session's editor draft.

**Claim under test:** task-triggered, ADR-shaped checkpoints preserve
what a future agent needs (per ADR 0001) better than generic compaction.
Compare a checkpointed handoff against a plain `/compact` on the same
transcript — does the checkpoint answer "what would a future agent
desperately need to know" better?

**Done when:** a fresh working memory started from an M2 checkpoint can
continue the task without re-asking questions the checkpoint already
answered. Track re-asked questions as the failure signal.

## M3 — Role as mode (Reuse)

**Build:** 2-3 roles (Engineer, Validator, Researcher) as system-prompt
fragments, switched via `before_agent_start` returning a different
`systemPrompt` for the next turn, keyed off a `role` field in the M0
task-state file. Reference `examples/extensions/plan-mode/` for the
pattern of toggling tool availability alongside the prompt swap (e.g.
Validator gets read-only tools).

**Claim under test:** Engineer → Validator role switch, same working
memory, is a real win over spawning a fresh subagent for validation —
per vision.md's Reuse rationale ("accumulated reasoning is valuable").

**Done when:** run the same validation task twice — once as Reuse (this
milestone), once as Fork (M4) — and compare validation quality/catch
rate. This is the first data point on the vision's open question
("how will the foreman know when independent judgment is valuable?"),
not a resolution of it.

## M4 — Fork (independent working memory)

**Build:** fork `examples/extensions/subagent/`. Changes needed: seed the
child agent's prompt from the M0 task-state file (not a hand-typed task
string), and have the child's final `done` tool call (M1) write back into
the parent task's state file instead of just returning text to the
parent's conversation.

**Claim under test:** fresh working memory (no inherited trajectory)
produces more independent judgment for validation than Reuse (M3) — at
the cost of rehydration (the child has to re-read files/context the
parent already had in memory).

**Done when:** same comparison as M3, from the other side. Also record
rehydration cost (tokens/time for the child to reach the same
understanding the parent had) as a concrete number, not a vibe — this is
the tradeoff vision.md's Fork section names explicitly.

## M5 — Foreman lifecycle decisions

**Build:** the actual decision logic — given task metadata alone (role,
working-memory size from `ctx.getContextUsage()`, task-state status,
unresolved-question count), decide continue / switch role / fork /
checkpoint / close / escalate. Start as a deterministic rule (e.g. "fork
if unresolved-question count is 0 and role is Engineer with `/done`
called"), not an LLM call — per vision.md's "foreman owns lifecycle
decisions, not implementation reasoning" and the opencode research
finding that this can be plain code.

**Claim under test:** metadata-only decisions (no working-memory read)
are sufficient for correct lifecycle transitions. If the foreman
repeatedly gets Reuse-vs-Fork wrong from metadata alone, that's the
signal to escalate this to an LLM-judged decision instead — write the
ADR at that point, don't preempt it now.

**Done when:** a full Director → Foreman → Task → Engineer → `/done` →
Validator → `/pass` → Task complete loop runs through M0-M4's pieces
without a human manually invoking each step.

## M6 — Director dashboard

Explicitly gated on M0-M5 holding up. Start with
`ctx.ui.setWidget()`/`setStatus()` text (per
`examples/extensions/status-line.ts`) showing the vision's task-list
mock. Only build a `ctx.ui.custom()` interactive view if the text version
turns out to be the bottleneck, not preemptively.

## Explicitly out of scope for this plan

- Third-party pi subagent/orchestration npm packages
  (`pi-subagent-workflow`, `pi-crew`, etc.) — pattern reference only per
  `docs/research/pi-vision-validation.md`, not a dependency.
- LLM-judged fork-vs-reuse decisions — only after M5's rule-based
  approach demonstrably fails.
- Cross-machine or multi-user Director/Foreman — single local pi process
  throughout.

## Shelf life

Re-plan if M0-M2 (the cheap, foundational milestones) surface a wrong
assumption in ADR 0001 or 0002 — e.g. if file-based task state fights
pi's session/branch model harder than expected once M4's fork needs to
read it from a different session's extension instance. Each milestone
section above names its own falsification condition; treat those as the
early-warning system rather than waiting until M6 to notice something
was wrong at M1.
