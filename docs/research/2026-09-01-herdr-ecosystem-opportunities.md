# Herdr ecosystem opportunities for Foreman-lite

**Status:** recommendation
**Date:** 2026-09-01
**Shelf life:** revisit after Foreman users routinely run five or more concurrent Task Threads, or after the first recurring human-decision handoff. Archive if neither occurs by 2027-03-01.

## Question

Which current Herdr- and Pi-adjacent projects can improve Foreman-lite without replacing its intentional boundaries: visible persistent Worker and Verifier panes, durable draft-safe transport, and Foreman judgment over fixed workflow routing?

## Current constraints

Foreman-lite is deliberately not a generic autonomous workflow engine:

- A Task Thread is a persistent Herdr tab with a Worker and, only when requested, a persistent Verifier.
- Infrastructure owns placement, task identity, durable messages, and delivery receipts. Foreman decides what every signal means and what happens next.
- `done`, `approve`, and `deny` are facts reported to Foreman; none mandates review, remediation, merge, or cleanup.
- Workers receive directives through a per-pane structured inbox after `sendMessage()` acceptance. Automated terminal typing is excluded because it corrupts an unfinished human draft.

The local task record stores identity, placement, workspace/tab/pane IDs, and optional verifier ID. `events.jsonl` records Worker `planned`/`done`/`flag` and Verifier `approve`/`deny`/`flag` facts. It does not yet expose an operator-oriented, cross-task state projection or a durable human-decision protocol.

## Findings

### 1. Add an optional, read-only task-board projection — **best next investment when concurrency grows**

[herdr-dagr](https://github.com/aemrebarut/herdr-dagr) displays a producer-owned `run.json` as a live DAG in a Herdr pane. It separates reported completion from verified completion, preserves retry history, and journals operator messages instead of becoming the workflow engine. Its design is compatible with Foreman because the viewer never owns routing.

Do **not** install its producer skill as the implementation. That would ask a model to maintain a second, potentially inaccurate account of Foreman state. Instead, if the need appears:

1. Define a small Foreman status projection derived only from task metadata and immutable task events.
2. Include explicit statuses such as `working`, `reported-done`, `needs-judgment`, `verification-requested`, `approved`, `denied`, and `blocked`; do not infer `verified` from Worker `done`.
3. Render that projection in a new optional read-only Herdr pane. A Dagr-compatible exporter is plausible, but validate its task/attempt schema in a disposable workspace first.
4. Keep action buttons/messages routed to Foreman through the existing structured inbox, with no automatic action on a board state.

This becomes valuable when the human cannot tell which thread needs attention by reading the tab strip. It is not justified for the current one-to-few task layout.

### 2. Borrow durable human-decision semantics, not pi-workflows itself — **conditional second investment**

[pi-workflows](https://github.com/osolmaz/pi-workflows) provides durable, typed human decisions: immutable request records, exhaustive choices, validated text input, exactly-one accepted answer, and a continuation fence that survives a crash or simultaneous replies. Its [decision contract](https://github.com/osolmaz/pi-workflows/blob/main/docs/HUMAN_DECISIONS.md) also correctly separates a logical audience from private delivery-channel credentials.

Foreman currently has `flag(context)`, which sends an OS notification, but no request ID, accepted answer record, choice contract, or correlation between a human response and a Task Thread. This is the clearest real capability gap when work must pause for a human to choose among outcomes.

Do **not** embed pi-workflows or adopt its SQLite workflow host. It executes graph nodes inside one Pi conversation; Foreman coordinates several persistent Herdr conversations. Importing it would blur the distinction and recreate the fixed lifecycle Foreman removed.

If recurring decision waits emerge, add a narrow `request_human_decision` Foreman capability instead:

- task ID, immutable request ID, title, allowed choices, optional bounded text input, and requester context;
- one durable resolution with source, timestamp, and response digest;
- an explicit Foreman decision to resume, redirect, verify, or leave the Worker stopped after resolution;
- safe notification through the existing inbox/OS-notification path, never synthesized terminal input.

A human decision is a fact available to Foreman, not authorization for an automatic Worker continuation. This preserves the project’s governing boundary.

### 3. Keep pi-workflows’ Monitor outside Foreman — **rejected for now**

The [Monitor workflow](https://github.com/osolmaz/pi-workflows/blob/main/docs/MONITOR.md) has strong safety properties: read-only observation before action, explicit authority checks, re-observation after mutation, bounded retries, and a distinction between monitor state and target work state. Those are useful design references for any future long-running-operation feature.

It should not be imported or reproduced now. Foreman intentionally receives role signals through push delivery rather than polling, and no current task contract authorizes Foreman to restart, repair, or otherwise advance a Worker autonomously. A scheduler would make Foreman a workflow controller and reverse the judgment redesign. Revisit only for an explicitly requested, opt-in external-operation watcher with recorded authority and a stop condition.

### 4. Do not replace Herdr Task Threads with Oh My Pi subagents — **rejected**

Oh My Pi’s [Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md) gives one Pi session a live roster, transcript viewer, steering, revival, and termination controls for its child subagents. Its parent/child registry and fact-based activity metrics are useful UX references.

It is not Foreman’s runtime model. OMP subagents belong to one parent Pi session and may be parked, revived, or killed through that parent. Foreman needs independently attachable, persistent Herdr panes whose context survives an orchestrator turn and whose Worker/Verifier reuse is intentional. The existing redesign already reached the same conclusion for `pi-subagents`: borrow public transport/lifecycle patterns, not its headless child-process implementation.

The safe borrow is only observational: a future status board should show actual pane state, last event, task identity, and missing metrics as unavailable rather than guessed. Do not use OMP’s `task` runtime as a second worker-launch path.

### 5. No generic Herdr workflow pack should become Foreman policy — **rejected**

The [Awesome Herdr catalog](https://github.com/yigitkonur/awesome-herdr) contains fleets, queues, PR loops, worktree launchers, and project managers. Most assume a fixed issue-to-branch-to-PR lifecycle, automatic review/retry, or a separate control plane. Those assumptions directly conflict with Foreman’s decision that branches, PRs, verification, remediation, and cleanup are contextual choices.

Herdr’s plugin model remains valuable: optional observers and launch surfaces may use its CLI/socket API while Foreman stays the owner of task state and meaning. Evaluate individual visualizers or integrations against that boundary; do not adopt a general supervisor.

## Decision

No runtime dependency or behavior change is warranted from this scan.

Prioritize a **read-only, fact-derived task board** only after concurrent-task visibility becomes a demonstrated problem. Its implementation must be a Foreman-owned projection, not model-maintained workflow state. If human approvals or choices repeatedly block Task Threads, design a **small durable decision envelope** based on pi-workflows’ exactly-once semantics. Keep Monitor, OMP child subagents, and generic PR/fleet controllers out of the core.

## Evidence

- [Foreman judgment redesign](../plans/foreman-judgment-redesign.md): current role, inbox, placement, and no-fixed-routing decisions.
- [Foreman handoff](../handoff.md): durable state shape and known boundaries.
- [herdr-dagr README](https://github.com/aemrebarut/herdr-dagr): producer-owned read-only DAG view and message journal.
- [pi-workflows README](https://github.com/osolmaz/pi-workflows): in-session graph execution, local state host, and workflow scope.
- [pi-workflows human decisions](https://github.com/osolmaz/pi-workflows/blob/main/docs/HUMAN_DECISIONS.md): typed decisions, channel separation, idempotency, and durable resolution.
- [pi-workflows Monitor](https://github.com/osolmaz/pi-workflows/blob/main/docs/MONITOR.md): authority-bound observation/action loop.
- [Oh My Pi Agent Hub](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md): session-scoped child-agent observation and control.
- [Awesome Herdr](https://github.com/yigitkonur/awesome-herdr): ecosystem categories and competing supervisor models.
