# Foreman restart cannot rebootstrap child agents

Status: fix implemented on branch `foreman-child-recovery`, not yet live-validated.
Shelf life: delete once `recover_task` is exercised against a real restarted
Foreman with a dead Worker and confirmed to resume the transcript.

## Implemented (slice A + B + E, plus D)

- `TaskRecord` now carries `workerSessionId` / `verifierSessionId`;
  `buildPiLaunchCommand` passes `--session-id` on first launch and on resume.
- `recover_task` Foreman tool: per child, leave-if-live / resume-in-place by
  session id / recreate the Worker tab; queues a re-orientation directive.
  Aborts if `herdr agent list` fails (cannot assess liveness).
- Startup notify when tasks exist on disk.
- Skill section "Child session recovery"; `roles/foreman.md` directive.

Still open: `list_tasks` tool (C); double-launch guard relies on the
`herdr agent list` liveness read rather than a per-pane check (F partial).

## Symptom

A restarted Foreman process has no memory of existing Task Threads and no lever
to bring dead Worker/Verifier sessions back. Disk state under `~/.foreman`
survives the restart; the child pi sessions under `~/.pi/agent/sessions/` also
survive. Nothing connects the two.

## Why it happens

1. **No stable session handle is stored.** `TaskRecord` persists `workerPaneId`
   and `verifierPaneId` but not the child's pi session id.
   `buildPiLaunchCommand` launches `pi -e <ext> --name <n> @<promptFile>` with no
   `--session-id`, so pi mints a fresh session UUID on every launch. After a
   child crash the only pointer to its transcript is a fuzzy match on cwd +
   session dir + display name + mtime.

2. **No recovery tool.** Foreman's tools are `create_task`, `message_worker`,
   `start_verifier`, `halt_worker`, `flag`. None enumerates tasks on disk or
   relaunches a dead child. A fresh Foreman is blind even though `registry.json`,
   `tasks/<id>/meta.json`, and `events.jsonl` are all readable.

3. **The skill covers the wrong failure.** `skills/foreman/SKILL.md`
   "compaction recovery" addresses Foreman losing *conversational memory* while
   child sessions stay live. It says nothing about relaunching dead child
   *processes*.

4. **Relaunch-from-prompt discards progress.** `startWorker` always writes the
   prompt file from `record.prompt` (the original task) and launches fresh. Used
   as-is for recovery it would restart the Worker from zero, throwing away the
   work that already sits in the session JSONL tree.

5. **Liveness is unobservable.** No heartbeat, PID, or `herdr agent list`
   cross-check is recorded. Foreman cannot distinguish a live Worker from a dead
   pane.

## Recovery strategy

### A. Persist the session id at launch

Add `workerSessionId` / `verifierSessionId` (and the resolved `sessionDir`) to
`TaskRecord`. Pass `--session-id <id>` in `buildPiLaunchCommand`; pi documents it
as "use exact project session ID, creating it if missing", so the same flag
serves first launch and resume. Derive the id deterministically from task id +
role, or generate a UUID and store it. Recovery becomes a deterministic lookup.

### B. Add a Foreman `recover_task` tool

Input: a task id, or "all".

- Read `meta.json` + `registry.json`.
- Probe pane liveness with `herdr agent list` / `herdr agent read <paneId>`.
- Pane alive, pi dead: `herdr pane run <paneId>` with the pi command carrying
  `--session-id <storedId>` to resume the full transcript. Then queue a
  `foreman-*-directive` inbox message: "Your session was restarted by Foreman
  recovery. Re-read your working surface and signal current status
  (planned/done/flag) before continuing."
- Pane gone: recreate the tab/pane, then resume the session into it.
- Rewrite pane registrations.

Hazard: if Foreman misjudges liveness and runs pi into a pane that already holds
a live pi, the task gets two agents. Check `herdr agent read <paneId>` for a live
agent prompt before launching, and confirm whether pi refuses a session id that
is already open (needs verification).

### C. Add a `list_tasks` tool (or fold into `recover_task`)

Enumerate `~/.foreman/tasks/*/meta.json`, show the last `events.jsonl` line and
pane liveness per task, so a fresh Foreman can self-orient.

### D. Self-orient on startup

In `pi.on("session_start")` when `reason === "startup"`, scan tasks; if any exist
emit a UI notice / inject context pointing at `list_tasks` and `recover_task`.
Parallel to the existing tab-rename startup hook.

### E. Skill section: "Child session recovery"

Distinct from compaction recovery. Document the relaunch procedure, `--session-id`
resume, the re-orientation nudge, and the hazard that a fresh `@promptFile`
launch destroys child progress.

### F. Child re-orientation on resume

A resumed child may be mid-turn. The `foreman-*-directive` from step B gives it a
clean re-entry point; Workers and Verifiers already treat directives as Foreman
instructions.

## Minimum viable slice

A + B + E. C, D, F are polish.
