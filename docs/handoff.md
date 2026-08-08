# Handoff / checkpoint

Rewritten from scratch just before a context compaction, 2026-08-08,
late session. The previous version of this file (still in git history at
commit `39dbafb` if you want it) covered the tmux→herdr `create_task`
rewrite; everything in that version is now either done or superseded.
Read this one, not that one.

## Where things actually stand

**`docs/vision.md`** is still the source of truth, user-authored. Nothing
in this session contradicted it — the herdr discovery changed *how* it
gets built, not *what* it says.

**`skills/foreman/SKILL.md`** is still stale (Claude-Code-era vocabulary,
`.claude/foreman-lite/` paths). Deferred three times now across two
sessions. Still not blocking anything — nothing reads it yet.

**herdr is now load-bearing infrastructure, not a maybe.** `docs.md`
detail below; short version: it replaced tmux entirely, and it turned out
to also solve the automatic-notification problem that motivated a chunk
of the original vision, via a mechanism (event-driven plugin) that's
better than what was originally planned (Foreman polling).

## What's built, and genuinely verified (not just written)

### `extensions/foreman.ts` — Foreman's capability
- `create_task` tool: `herdr worktree create` + `herdr agent start --kind
  pi -- -e <worker.ts path> <prompt>`. No tmux, no shell strings anywhere
  (herdr's `--` argv is a real array).
- Writes `.foreman/tasks/<id>/meta.json` (repo-local) **and**
  `~/.foreman/registry.json` (global, cross-repo, keyed by pane id) — the
  registry is what the herdr plugin (below) uses to map a pane back to a
  task; `create_task` also stamps `foremanPaneId` into both, read from
  its own `process.env.HERDR_PANE_ID` at creation time (correct
  automatically when Foreman itself runs inside herdr — no config).
- Real, live-reproduced bug fixed: `agent start` immediately after
  `worktree create` intermittently fails `agent_pane_busy` (pane not at
  an available shell prompt yet). Fixed with a bounded retry
  (`runHerdrRetryingPaneBusy`, 5×/500ms) keyed to that specific error
  code — herdr writes its JSON error to **stderr**, not stdout, which
  broke the first version of this fix silently (retry never fired,
  looked like it worked because the error handling still returned
  cleanly). Both bugs found by actually running it repeatedly, not by
  reasoning about it.
- `halt_worker` **not built yet**. Candidate: `herdr agent send-keys
  <name> esc`. Untried.

### `extensions/worker.ts` — Worker's capability
- `worker_signal` tool: `planned` / `done` / `flag`. Writes to
  `<worktree>/.task/events.jsonl` (real Task State per vision.md — plain
  file in the worktree) and emits `pi.events.emit("herdr:blocked", ...)`
  for `flag` (herdr's own installed pi integration, see below, turns that
  into `agent_status: "blocked"` with zero socket code on our part).
- **Turn-end enforcement hook**: pi has no direct Stop-hook equivalent
  that can veto ending a run. Standard pi pattern instead (same one the
  bundled `plan-mode` example uses): hook `agent_end`, check whether the
  run's messages included a `worker_signal` tool call, and if not, inject
  a corrective message with `pi.sendMessage(..., { triggerTurn: true,
  deliverAs: "followUp" })`, forcing another run before the session is
  ever idle without a signal. Bounded by `MAX_NAGS_PER_RUN = 3`, then it
  settles instead of forcing forever.
  - **Verified live**: gave a Worker a trivial prompt, it replied in
    plain text with no tool call, got nagged once, called
    `worker_signal`. Confirmed by reading the session JSONL directly —
    `pi -p`'s stdout looked empty and was misleading (it only prints the
    *final* message's text content, and the final message here was a
    tool call with no text).
  - **Not verified live**: the `MAX_NAGS_PER_RUN` cutoff-and-settle
    branch itself (hard to force a model to stonewall on purpose).
    Implemented, untested.

### `plugins/task-events/` — the automatic-notification piece
This is a **herdr plugin**, a different kind of artifact than the pi
extensions above — a directory with `herdr-plugin.toml` + `notify.mjs`,
registered via `herdr plugin link <dir>` (local dev) rather than loaded
by pi at all.

**Why this exists**: Foreman polling (a tool it calls on demand) cannot
deliver automatic awareness — nothing wakes an idle LLM session between
your messages to make it check. This was the actual decision point this
session; see "Key decisions" below.

**How it works**: herdr fires `pane.agent_status_changed` for *every*
pane on the machine (confirmed via `herdr api schema --json` and a real
reference plugin, `ogulcancelik/herdr-plugin-examples/agent-telegram-notify`,
which uses the identical event). `notify.mjs`:
1. Reads `HERDR_PLUGIN_EVENT_JSON.data.{pane_id,agent_status}`.
2. No-ops immediately for `working`/`unknown` (only reacts to
   `idle`/`blocked`/`done`), and no-ops for any pane not in
   `~/.foreman/registry.json` (i.e. every other agent on the machine, not
   ours).
3. Looks up the task, reads the last line of its
   `.task/events.jsonl`, and pushes `herdr agent prompt <foremanPaneId>
   "Task <id> (<status>): <signal>"` — landing directly in Foreman's
   conversation with no polling and no manual step.

**Verified end-to-end, repeatedly, with a real dummy-Foreman pane** (a
second pi agent standing in for Foreman, `HERDR_PANE_ID` overridden on
`create_task`'s own invocation to point at it — see "How to
re-verify this" below for the exact recipe if you need it again):
completion messages arrived automatically in the dummy Foreman's session,
confirmed both by reading its live pane and by grepping its session
JSONL for the exact pushed text.

**Real bug found and fixed**: 3 of 6 test runs had the registry lookup
inside `notify.mjs` miss an entry that was independently confirmed
already on disk at the time. Root cause **not fully confirmed** — best
guess is some timing gap between the write finishing and the very next
`readFileSync` in a freshly-spawned plugin process, but this wasn't
nailed down conclusively. Fixed with a bounded retry
(`findTaskWithRetry`, 5×/200ms), same treatment as the `agent_pane_busy`
fix. Reverified 3/3 clean after the fix. If this ever resurfaces, the
retry count/delay are the first knobs to check, and the root cause is
still worth understanding properly rather than just trusting the retry
forever.

**Dedupe**: `notify.mjs` also guards against pushing the same underlying
signal twice if `agent_status` flickers more than once for one logical
change (a named risk, not speculative — the worker.ts nag loop plausibly
causes exactly this). State kept in
`$HERDR_PLUGIN_STATE_DIR/seen.json`, keyed by task id.

## Prerequisites on any machine running this (not automated, do these once)

```
brew install herdr
herdr integration install pi     # installs ~/.pi/agent/extensions/herdr-agent-state.ts
                                  # globally - this is what makes pi's
                                  # working/idle/blocked show up in herdr
                                  # at all, for EVERY pi session on the
                                  # machine, not just foreman-lite's.
herdr plugin link /path/to/foreman-lite/plugins/task-events
```
Foreman itself is launched as `pi -e /path/to/foreman-lite/extensions/foreman.ts`
from the target project's repo root, and only works as described above if
that `pi` process is itself running inside a herdr pane (so it inherits
`HERDR_PANE_ID`) — if you just run it in a plain terminal outside herdr,
`create_task` still works, but `foremanPaneId` will be `undefined` and
the plugin will silently skip pushing anything for that task (checked
explicitly in `notify.mjs`, not a crash).

## How to re-verify any of this from scratch

This is the pattern used throughout this session, worth keeping:
1. `herdr status` → if server not running, `nohup herdr server > /tmp/herdr-server.log 2>&1 &`.
2. Make a scratch git repo (`mktemp -d`, `git init -b main`, one empty commit).
3. Make a "dummy Foreman" pane to observe pushes without touching your
   real session: `herdr workspace create --cwd /tmp --label dummy-foreman --no-focus`
   → grab `pane_id` → `herdr agent start dummyforeman --kind pi --pane <id> -- --model claude-haiku-4-5`.
4. `HERDR_PANE_ID=<dummy pane id> pi -e extensions/foreman.ts -p "Use create_task to create a task named 'X' with prompt 'Say hello in exactly three words, then stop.'"`
5. Wait ~8-10s, then either `herdr agent read dummyforeman` or grep its
   session JSONL under `~/.pi/agent/sessions/--private-tmp--/` for the
   pushed text.

**Don't run `herdr server stop` when done "cleaning up."** Did exactly
this near the end of the session and killed the server hosting my own
current pane (confirmed via `HERDR_ENV=1`/`HERDR_PANE_ID=w1:p1` env vars
— this dev session itself runs inside herdr). It auto-restarted (likely
`brew services`) and nothing was actually lost, but it was a real
mistake, not a hypothetical one. Leave the server running; it's shared
infrastructure, not test-scoped. Scratch repos and worktrees under
`~/.herdr/worktrees/<label>/` and registry/state files
(`~/.foreman/registry.json`, `$HERDR_PLUGIN_STATE_DIR/seen.json`) are
fine to delete between test runs.

## Key decisions this session

- **herdr is load-bearing, not optional infrastructure.** Confirmed
  concretely (not just plausible) that it replaces: pane/worktree
  creation (`herdr worktree create`), push (`agent prompt`), pull
  (`agent attach`), halt (`agent send-keys`), and — the new one this
  session — automatic reactive notification (`[[events]] on =
  "pane.agent_status_changed"` in a plugin). None of this is
  reimplemented; all of it is a thin adapter calling herdr's CLI/plugin
  surface.
- **What herdr genuinely can't give us**, confirmed by direct
  demonstration, not just argument: (1) the difference between "a turn
  ended" and "the Worker asserts this is actually complete" — herdr's
  own `done`/`idle` states don't know this, which is exactly why a
  Worker answering a trivial prompt in plain text needed the enforcement
  hook to catch it; (2) role separation as policy — herdr has zero
  concept of "Foreman must not implement," that's pure structural
  scoping on our side (which extension loads where); (3) domain content
  (the actual "what to review"/"why blocked" text) — herdr states carry
  at most a short label, the real content lives in `.task/events.jsonl`;
  (4) task identity that outlives one pane's process lifetime — herdr's
  name→agent mapping clears on exit, `registry.json`/`meta.json` don't.
- **Push over pull for Foreman awareness, decisively, not just
  preferentially.** The deciding argument: an idle LLM session cannot
  spontaneously decide to check something between your messages — pull
  literally cannot deliver "Foreman conversation shows state transitions
  automatically" no matter how good the polling tool is. This is why the
  herdr plugin exists instead of the previously-planned Foreman-side
  poller (that plan is now dead, not deferred).
- Two named, reproduced, *not* fully root-caused "file write, then
  immediate re-read elsewhere, sometimes misses it" races this session
  (herdr's own `agent_pane_busy`, and our own plugin's registry lookup).
  Both mitigated the same way (bounded retry on the specific observed
  failure mode) rather than either ignored or over-investigated. If a
  third one shows up somewhere else in this system, that's a pattern
  worth actually chasing to ground truth rather than retry-patching a
  third time.
- Herdr's `AgentStatus` enum is `idle | working | blocked | done |
  unknown`. Our own pi integration (`herdr-agent-state.ts`, herdr's file,
  not ours) only ever reports 3 of those 5 (`working`/`idle`/`blocked`).
  `done` and `unknown` are herdr's own bookkeeping layered on top — not
  something we can rely on distinguishing ourselves. `notify.mjs`
  deliberately reacts to all three of `idle`/`blocked`/`done` rather than
  trying to be clever about which one "really" means completion.

## Next steps, in order

1. `halt_worker` tool in `foreman.ts` (`herdr agent send-keys <name>
   esc`, unverified candidate).
2. Verifier — nothing exists yet: no extension, no spawn-on-`/done`
   wiring, no `/approve`/`/deny` tool. This is the next major piece.
   Likely shape, not yet validated: spawned via `herdr agent start` into
   a **new pane in the same worktree** (not a new worktree — Verifier
   needs to see the Worker's actual changes), triggered by the
   task-events plugin itself reacting to a `done` signal specifically
   (it already has all the pieces: task lookup, domain signal read — it
   currently only *notifies* Foreman, but spawning the Verifier
   automatically at that same point instead of/in addition to notifying
   is a small extension of what's already built, not a new mechanism).
3. Update this file / write a real one when Verifier lands — this one
   will be stale again by then.
4. `skills/foreman/SKILL.md` rewrite (still deferred, still not
   blocking).
5. Once Verifier exists, `notify.mjs`'s `describeSignal`/message format
   will need a Verifier-side counterpart (`/approve`/`/deny`/`/flag`
   worded for the human, per vision.md) — currently only knows Worker's
   vocabulary.
