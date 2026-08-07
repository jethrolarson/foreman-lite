# Review: claudefa.st agent guide

2026-08-02. `claudefa.st/blog/guide/agents/*` is AI-generated, unofficial, and in at least one place documents itself contradicting Anthropic's own docs. Treat everything below as one AI's claims, not settled fact — cross-check before relying on any of it. Pages read: agent-fundamentals, agent-teams, agent-teams-controls, team-orchestration, task-distribution, persistent-subagents, nested-subagents, sub-agent-design, subagent-reported-done.

## Useful, and independently corroborated

- **"Identity frozen at spawn"** — matches our own confirmed finding that system prompts can't change mid-session.
- **File-partitioning as worktree rationale** — "two agents writing the same file creates merge conflicts" is a clean, checkable justification for default-worktree-per-task, independent of whether the guide's right about anything else.
- **Parallelism needs explicit prompting** — claims Claude defaults to sequential execution unless explicitly told to fan out. Unverified against official docs, but cheap to account for: state fan-out explicitly in Foreman's guidance rather than assuming capability implies it happens.

## Doubtful — flagged by the guide itself or contradicted

- **Nested subagents "5 levels deep"** — the guide's own text admits official docs say "subagents cannot spawn other subagents." Don't design around this.
- **Static builder/validator role-pairing** ("deploy together" rather than deciding per-task) — this is the pattern our reuse/fork/recycle judgment-call design deliberately avoids, not one to emulate. The guide gives no rationale for it.
- **"Delegate Mode" restricting the lead to coordination-only tools** — plausible-sounding but unverified against official docs.

## Agent Teams mechanics claimed (see `agent-teams.md` for what we actually verified)

Guide claims teammates communicate peer-to-peer via a "Mailbox," not exclusively through the lead. If accurate this is a materially different topology than Foreman-as-sole-decision-point — but moot for now since we're not committed to Agent Teams' full mechanics, only possibly its hook surface.
