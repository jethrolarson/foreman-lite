---
name: foreman
description: Foreman operational reference for foreman-lite — task model, signal vocabulary, on-disk state for compaction recovery, and herdr commands. Load when you need operational detail. Role directives are in your system prompt (injected by extensions/foreman.ts).
---

# Foreman — operational reference

Your role directives (what you must/should do, escalation, halt semantics) are injected into your system prompt by `extensions/foreman.ts` — always-on, not here. This file is the reference you load on demand: the task model, signal vocabulary, on-disk state for recovering after compaction, and the herdr commands to drive panes.

## Task model

A Task Thread = one human request = a git worktree + a Worker agent + a Verifier agent (Verifier in the *same* worktree, so it sees real changes) + Task State on disk.

| Role | Extension | Tools |
|------|-----------|-------|
| Foreman (you) | `extensions/foreman.ts` | `create_task`, `halt_worker`, `flag` |
| Worker | `extensions/worker.ts` | `worker_signal` |
| Verifier | `extensions/verifier.ts` | `verifier_signal` |

Only Foreman creates tasks; Workers/Verifiers never get `create_task`/`halt_worker`/`flag`, and you never get the signal tools. Each role's directives are injected by its own extension via system-prompt (not loaded as skills) so they're active from turn 1.

## Signal vocabulary

Every Worker/Verifier turn must end with a signal (an enforcement hook nags them if not). Signals are the only way work moves between threads.

- Worker `worker_signal`: `planned` (plan ready for review), `done` (work ready for review), `flag` (blocked, needs input).
- Verifier `verifier_signal`: `approve` (accepted), `deny` (sent back to Worker with what to fix), `flag` (concern to you — Worker malfunctioning or large risk).

You don't poll. The `task-events` herdr plugin watches every pane and pushes transitions into your conversation ("Task X (done): ...", "Task X verifier (done): approved: ..."). That pushed message *is* the signal.

## On-disk state (and recovering after compaction)

- HAZARD: compaction rewrites your conversation but not the on-disk task state — if you lose track of threads, re-read disk rather than guessing.
- `~/.foreman/registry.json` — global, keyed by pane id. Each entry: `id`, `role` (`worker`|`verifier`), `repoRoot`, `worktreePath`, `branch`, `paneId`, `foremanPaneId`, `prompt`, `provider`, `model`, `verifierPaneId` (worker entries) / `workerPaneId` (verifier entries), `createdAt`. Start here: `cat ~/.foreman/registry.json`.
- `<repoRoot>/.foreman/tasks/<id>/meta.json` — repo-local copy of the worker record.
- `<worktree>/.task/events.jsonl` — one JSON line per signal `{role, action, context, timestamp}`; the last line is the thread's current state: `tail -1 <worktreePath>/.task/events.jsonl`.

Recovery: `cat ~/.foreman/registry.json` → for each task `tail -1` its `events.jsonl` → every thread's id, panes, and current signal.

## herdr commands

```
herdr agent list                         # all agents on the machine
herdr agent read <name|paneId>           # recent pane output
herdr agent attach <name|paneId>         # drop in interactively (Ctrl-D to leave)
herdr agent prompt <name|paneId> <text>  # message an agent
herdr agent send-keys <name|paneId> esc  # interrupt a turn
herdr worktree remove --workspace <wid> --force  # tear down (wid = workspace id, e.g. w28)
```

- HAZARD: `herdr agent prompt` rejects multi-line or quoted text ("cannot
  be encoded safely for the target shell"). Keep prompts single-line, strip
  quotes. CONTEXT: found in herdr plugin logs during Verifier-spawn testing.
  (`create_task`/Verifier spawns pass the prompt via `@file` to dodge this —
  if you prompt a pane yourself, you don't get that.)
- CONTEXT: `worktree remove --workspace` takes a **workspace id** (`w28`),
  not the task name. Derive it from a pane id (`w28:p1` → `w28`) or find it
  via `herdr workspace list`. Every task you create is in `~/.foreman/registry.json`
  keyed by pane id, so look up the pane id there first — don't guess.

The human can `herdr agent attach` any thread directly — the intended drill-down path; you don't have to relay everything.
