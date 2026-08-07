# 0002: Build the foreman-lite vision on pi, not opencode or Claude Code

## Status

Accepted

## Context

`docs/research/base-system-comparison.md` and `docs/research/opencode-vision-validation.md`
found the vision more native to opencode than to Claude Code, but still
required building Task State, the Foreman, and the Director dashboard
from scratch regardless of base — opencode's native primitives (Session,
Agent, plugin/SDK) reduce some plumbing but don't remove the core build.

`docs/research/pi-vision-validation.md` ran the same check against pi.
Headline difference: pi ships almost nothing by design (no sub-agents, no
plan mode, no built-in agent/mode object — see pi's own README
"Philosophy") and expects the whole thing to be a TypeScript extension.
Compaction (`session_before_compact`, three trigger reasons including a
proactive one, freeform `details`) is a stronger native fit than
opencode's overflow-only compaction. Reuse (role-as-mode) has no native
Tab-switch analogue and must be emulated via per-turn system-prompt
injection. Fork has no parent-watches-children session API; pi's
`ctx.newSession`/`ctx.fork` replace the current runtime's session rather
than spawning a supervised child.

A follow-up building-blocks pass found pi's own bundled
`examples/extensions/` cover most of the vision's operations well enough
to fork from directly: `subagent/` (Fork, Role-as-agent-definition),
`handoff.ts` (Checkpoint-and-fork, missing only the ADR shape and
foreman-driven trigger), `structured-output.ts` (terminating tool call
for a typed `/done` verdict), `custom-compaction.ts`/`trigger-compact.ts`
(the two compaction hooks the ADR-shaped checkpoint needs). This
materially lowers the pi implementation cost estimate below what the
opencode-vs-Claude-Code comparison assumed for "build from scratch."

Deciding factor: this project's CLAUDE.md itself is written for and lives
inside pi (`/Users/jethrolarson/develop/foreman-lite/CLAUDE.md` loads as
pi's project context file). Building the foreman-lite runtime as a pi
extension means the tool developing it and the tool running it are the
same base, one fewer moving part, one set of docs to track for breaking
changes.

## Decision

Implement the foreman-lite vision as a pi extension (or small set of
extensions), not as an opencode plugin or Claude Code subagent
configuration. Fork from pi's bundled examples (`subagent/`, `handoff.ts`,
`structured-output.ts`, `custom-compaction.ts`) as concrete starting
points per `docs/research/pi-vision-validation.md`'s building-blocks
section, rather than writing the event/session wiring from zero.

## Consequences

- No native Role/Tab-switch or supervised subagent API to lean on — Reuse
  and Fork are fully custom TypeScript against `before_agent_start`,
  `ctx.newSession`, and `ctx.fork`, more code than opencode's config-level
  equivalents would have needed.
- Task State remains file-based and extension-owned regardless of base
  (unchanged from prior research) — this decision doesn't resolve that
  question, `docs/specs/pi-port-plan.md` does.
- Third-party pi subagent/orchestration packages exist on npm but are
  largely unvetted (missing repos, spam-like metadata); treated as
  pattern references only, not dependencies, per
  `docs/research/pi-vision-validation.md`.
- If pi's "no sub-agents by design" philosophy turns out to fight the
  Fork operation harder than this ADR assumes — e.g. `ctx.newSession`'s
  session-replacement semantics prove too disruptive for a foreman
  running several concurrent task threads — this ADR is the record to
  revisit and supersede, likely back toward opencode's supervised
  child-session model.
