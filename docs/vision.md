## Vision

I want to talk to a head llm agent (foreman) who manages basic plate-spinning for multiple LLM tasks. This agent does not directly complete work I request but delegates to task agent workflows which it keeps track of and can answer to. It should raise any important decisions to me but unblock task threads where safe.

I want foreman to ensure that verification processes complete without doing the verification itself.

## Properties of the solution

1. I can manage everthing through the foreman if desired
2. I can drill down into task threads directly and issue commands to the sub-agents
3. Foreman conversation shows the state transitions for all sub-agents

## Glossary

- `[context]` string. whatever the situation demands. could be short sentence, filepath, pr url, commit id, etc.
- Task Thread - conceptual grouping of task agents and task state and working memory associated with a human's request
- Working Memory - LLM conversation content for a specific agent. This could be compacted if necessary.
- Task State - file state associated with a task thread, shared between Worker and Verifier under `~/.foreman/tasks/<id>/` so orchestration metadata does not dirty source trees.

## Agent roles

I see 3 agent roles to start

- Foreman - manages across task threads without getting into the details
- Worker - completes requested work usually coding tasks
- Verifier - double checks the task agent's output against request and contextual standards

### Foreman

MUST not complete tasks itself. It stays high-level orchestrator to keep tasks going so it's working memory doesn't get bloated. Compaction must not lose tract of task threads. Foremand doesn't review the work, just ensures that review happens.

**Commands**
Create Task - Starts a task thread with a Worker agent.
Halt Worker - Stops an in progress worker
Flag - Sent OS notification to Human when something demands their attention

### Worker

Completes requested task with reasonable autonomy where SAFE. Should start with evaluating the request and coming up with a plan.
Must end each turn with a command. Hook should ensure this is satisfied. Worker is expected to write and run tests, static analysis, etc before sending work for review. Safe and `/flag` more important than `/done` and wrong.

**Commands**

- /planned [context] - Worker deliberately pauses for Foreman input or redirection on a plan. It should otherwise continue through implementation and /done because signaling ends the turn.
- /done [context, prUrl] - Worker declares task ready for review after committing, pushing, and opening a pull request. This starts or re-prompts Verifier review on that PR.
- /flag [context] - worker declares that they're blocked and need help. This could be for a decision from the human or because the request is not completable or any other issue preventing progress on task. Foreman will see this and decide how to address (if obvious without getting into the details) or raise the flag to the human.

### Verifier

Verifies completed Worker work on its pull request. Detailed review is recorded in visibly marked GitHub comments rather than source files; Verifier persists for the full task thread.

**Commands**

- /approve - Approve work
- /deny [context] - Send work back to Worker for changes
- /flag - Raise concern to the foreman when it seems like the worker is malfunctioning or if there's some large risk identified that the worker agent is unlikely to be able to resolve.

# Decisions and open questions

- Approved work remains in its PR; Foreman does not merge. Foreman decides contextually whether any lifecycle signal warrants interrupting the human, while merge authority remains human.
- Open: should we bring back the /recycle command which would allow foreman to decide when to compact?
