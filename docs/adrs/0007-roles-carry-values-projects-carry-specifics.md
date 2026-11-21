# 0007. Role prompts carry values; target projects carry specifics

Status: accepted

## Context

Role prompts are shared by every project Foreman works in. Prescribing process in them ("run appropriate tests") misfits projects it wasn't written for: Verifiers reran suites that CI already covered. pi loads `AGENTS.md`/`CLAUDE.md` from a child's working directory and its parents, so Workers and Verifiers already receive the target project's own instructions, including in detached worktrees, where the checked-in file is present.

## Decision

`roles/*.md` state values, boundaries, and hazards with reasons, not procedure. Project facts and policy (what CI covers, which checks are expensive, where review comments go) belong in the target project's context files.

## Consequences

- A role line that prescribes a step needs a reason that covers the step, so the agent can judge when it doesn't apply.
- Behavior in a project without suitable context files depends on agent judgment from the role's reasons.
- Launching children with `--no-context-files` would remove the project-specific half; don't.
