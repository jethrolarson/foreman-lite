# PR review workflow

**Status:** accepted, implemented on `pi-port`  
**Decision date:** 2026-08-09  
**Revisit when:** agents use distinct GitHub identities, review history moves to another durable system, or merge authority is delegated.

## Context

Verifier review details previously lived only in transient signals or could be written into task files inside the repository. The human wants a durable review record they can inspect without polluting source code. All agents currently use the human's GitHub account, so GitHub attribution alone cannot identify which agent authored a message.

## Decision

- A Worker pushes its task branch and opens a pull request before signaling `done`; `worker_signal(done)` requires the PR URL.
- Only `done` starts or re-prompts a Verifier. `planned` is a deliberate pause for Foreman input, not a routine progress ping, because it terminates the Worker's turn and no durable PR review surface is guaranteed yet.
- The Verifier posts detailed findings with `gh pr comment`; `verifier_signal` carries only a short routing summary.
- Agent-authored GitHub content starts with a visible role/task marker:
  - `> **[foreman-lite · Worker]** task: <task-id>`
  - `> **[foreman-lite · Verifier]** task: <task-id>`
- A deny directive tells the Worker the PR URL and to read the marked Verifier comment, then respond on the PR after fixing it.
- Foreman treats lifecycle verdict (`approve`/`deny`/`flag`) separately from attention priority and decides contextually whether to interrupt the human. Foreman does not merge.

## Why

PR comments keep review contents durable, visible beside the diff, and outside the source tree. Visible markers compensate for every agent action being attributed to the same GitHub account. Carrying the PR URL through task state keeps routing explicit rather than asking agents to rediscover where feedback lives.
