---
name: foreman
description: Foreman operational reference for foreman-lite — Task Thread placement, structured signals, durable state, recovery, and Herdr drill-in. Load when task metadata or operational detail is needed.
---

# Foreman operational reference

Role directives are injected by `extensions/foreman.ts`; this skill holds recoverable operational detail rather than duplicating policy.

## Task model

A Task Thread is a semantic unit represented by one Herdr tab, one persistent Worker session, optional persistent Verifier session, and durable state under `~/.foreman`. Its directory placement is separate:

- `shared`: the task tab uses Foreman's current directory.
- `git-worktree`: foreman-lite creates a detached worktree under `~/.foreman/worktrees/<id>`; Worker decides whether to create a branch, commit, or PR.

| Role | Extension | Tools |
| --- | --- | --- |
| Foreman | `extensions/foreman.ts` | `create_task`, `message_worker`, `start_verifier`, `halt_worker`, `flag` |
| Worker | `extensions/worker.ts` | `worker_signal` |
| Verifier | `extensions/verifier.ts` | `verifier_signal` |

MUST: choose placement from the task's actual isolation needs. REASON: coupling every task to a worktree creates needless Git state and excludes non-Git research; sharing concurrent source edits creates interference.

## Signals and directives

- Worker `planned(context)`: deliberately pauses for Foreman input.
- Worker `done(context)`: identifies a ready result and checks; context may reference prose, reports, specs, paths, commits, PRs, or other artifacts.
- Worker `flag(context)`: reports a blocker or uncertainty.
- Verifier `approve|deny|flag(context)`: reports independent evidence about the artifact Foreman named.

Signals do not authorize a next transition. Foreman chooses whether to use `message_worker`, `start_verifier`, `flag`, or no tool.

Automated messages use per-pane structured inboxes under `~/.foreman/inboxes/`. The role extensions deliver them with Pi's `sendMessage()` API, so they do not type into the human's editor. Immutable files in `messages/` provide durable dedupe; `delivered/` receipts are written only after acceptance.

HAZARD: do not use `herdr agent prompt` for automated routing. REASON: it types into the live editor and was observed concatenating a machine signal with an unfinished human draft. Use `message_worker` or `start_verifier`; those write the structured inbox.

## Durable state and compaction recovery

- `~/.foreman/registry.json`: pane-id map used by the Herdr plugin. Entries identify task, role, workspace, tab, Worker/Verifier panes, placement, and Foreman pane.
- `~/.foreman/tasks/<id>/meta.json`: canonical Task Thread record.
- `~/.foreman/tasks/<id>/events.jsonl`: append-only Worker and Verifier signals `{role, action, context, timestamp}`.
- `~/.foreman/inboxes/<encoded-pane-id>/`: immutable messages, delivered/failed receipts, and current session-owner state.

HAZARD: compaction can remove conversational task detail while disk state remains authoritative. REASON: guessing after compaction can route an old signal as current. Recover by reading `registry.json`, each task's `meta.json`, and the last relevant lines of `events.jsonl`.

## Herdr drill-in

```sh
herdr workspace get <workspace-id>
herdr agent list
herdr agent read <pane-id>
herdr agent attach <pane-id>
herdr agent send-keys <pane-id> esc
```

The human can attach directly to a Worker or Verifier. Foreman should point to the relevant tab, pane, or durable artifact rather than copying detailed work into its own context.

HAZARD: `halt_worker` interrupts only the current turn. REASON: the persistent session is intentionally retained for later input through `message_worker` or direct human attachment.
