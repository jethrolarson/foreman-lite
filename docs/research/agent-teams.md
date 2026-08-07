# Agent Teams (experimental)

2026-08-02. Findings from live research, not the claudefa.st guide's own claims (see `claudefast-guide-review.md` for that, kept separate since it's AI-generated and unverified).

## Status

`TaskCreate`/`TaskList`/`TaskGet`/`TaskUpdate` and the team messaging/hook surface are gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Not on by default, not available to plain subagents/Task-tool spawns.

## Task-list durability

Task state persists at `~/.claude/tasks/{team-name}/`, survives session resumption. Scoped to one team/lead session — no cross-session or cross-team sharing. Also: not inside the project repo, so not git-tracked or visible to someone reading the codebase.

## TeammateIdle / TaskCompleted hooks

Real hook events, confirmed in official docs. Exit code 2 blocks the action and returns stderr as feedback to the agent — same contract as standard Claude Code hooks. **Team-wide scope**, not per-teammate: one hook config fires for any teammate going idle or completing, across the whole team. Exact JSON payload schema is not documented anywhere official — the hooks reference lists the event names but doesn't spell out the input fields (task id, teammate name, transcript path, etc.). Would need an empirical probe (enable flag, trigger event, log payload) before writing logic that depends on specific fields.

## Relevance to foreman-lite

Given task-state is intentionally plain git-tracked files (not native `TaskCreate`, for git-visibility reasons independent of Agent Teams' availability), the main potential use of Agent Teams here is the hook surface — a mechanical check before trusting a spawned worker's completion verdict, addressing the "reported done" risk (see `claudefast-guide-review.md`). Not yet built; blocked on the payload-schema gap above.
