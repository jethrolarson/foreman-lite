# 0001. Inject role via before_agent_start, not a skill

Status: accepted

## Context

Worker/Verifier/Foreman role text must govern the agent starting turn 1. Skills use progressive disclosure — loaded on demand, not guaranteed present before the first turn.

## Decision

Each role extension injects its role prompt as an always-on system prompt via pi's `before_agent_start` hook, not as a skill.

## Consequences

Role governs turn 1 with no read-gate. The role can't be toggled on/off mid-session the way a skill can, but each extension is fixed to one role for its whole session anyway.
