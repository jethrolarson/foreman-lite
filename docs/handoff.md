# Handoff / checkpoint

Rewritten from scratch just before a context compaction, 2026-08-08,
late session. The previous version of this file (still in git history at
commit `39dbafb` if you want it) covered the tmux→herdr `create_task`
rewrite; everything in that version is now either done or superseded.
Read this one, not that one.

## Where things actually stand

**`docs/vision.md`** is still the source of truth, user-authored. Nothing
in this session contradicted it — the herdr discovery changed _how_ it
gets built, not _what_ it says.

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
- Writes `~/.foreman/tasks/<id>/meta.json` and
  `~/.foreman/registry.json` (global, cross-repo, keyed by pane id) — no
  task metadata is written into the user's repo. The registry maps panes
  back to tasks; `create_task` also stamps `foremanPaneId` into both,
  read from its own `process.env.HERDR_PANE_ID` at creation time.
- Real, live-reproduced bug fixed: `agent start` immediately after
  `worktree create` intermittently fails `agent_pane_busy` (pane not at
  an available shell prompt yet). Fixed with a bounded retry
  (`runHerdrRetryingPaneBusy`, 5×/500ms) keyed to that specific error
  code — herdr writes its JSON error to **stderr**, not stdout, which
  broke the first version of this fix silently (retry never fired,
  looked like it worked because the error handling still returned
  cleanly). Both bugs found by actually running it repeatedly, not by
  reasoning about it.
- `flag` tool: Foreman's flag-to-human — sends a native OS
  notification (`osascript display notification` on macOS,
  `notify-send` on Linux; graceful no-op elsewhere). Foreman is the only
  role that talks to the human directly, so only it gets this. **Verified
  live** (LLM called the tool, `osascript` exited 0, notification posted).
  Foreman decides when to invoke it — e.g. a Worker/Verifier `flag` it
  can't resolve itself, or any decision only the human can make.
- `halt_worker` tool: `herdr agent send-keys <id> esc`. Target is the
  agent name, which `create_task` sets equal to the task id, so no
  pane-id lookup is needed — reads `meta.json` only to give a clean
  "no such task" error rather than letting herdr's own `agent_not_found`
  leak through. **Verified live, cleanly, and the semantics are the good
  ones:** `esc` interrupts the Worker's current turn (the running tool
  call aborts with "Command aborted" / "This operation was aborted")
  but the pi process stays alive and is resumable — confirmed by sending
  a follow-up `herdr agent prompt` afterward and watching it resume
  "Working...". The `worker.ts` turn-end nag hook fires correctly on the
  aborted turn, and the Worker then calls `worker_signal`. So halt means
  "interrupt this turn, pane/worktree kept, Worker can be prompted
  again" — exactly what vision.md wants, not a kill.

  (Side note on how this was confirmed, worth keeping because the first
  test attempt was confounded: a Worker spawned via `create_task`
  disappeared on its own _without_ any `esc`, both in the original
  session and reproduced now — root cause was that `create_task` passed
  `-e worker.ts <prompt>` with **no `--provider`/`--model`**, so the
  Worker used defaults, and the default `zai`/`glm-5.2` key was 401'ing
  mid-session (`pi auth check --provider zai` says "ready" but fresh
  `pi` subprocesses hit `authentication_error` and the interactive
  process exits). The clean esc test used an explicit
  `--provider zai --model glm-5.2` Worker, which stayed stable through
  esc and a follow-up prompt. **Fixed:** `create_task` now forwards
  `PI_PROVIDER`/`PI_MODEL` from Foreman's env into the `agent start --`
  argv, and stashes them in the registry so the task-events plugin can
  spawn Verifiers with the same provider/model (the plugin process
  doesn't inherit pi's env). Verified: a `create_task`-spawned Worker
  ran a 30s task to completion and accepted a follow-up prompt, no
  auth-exit.)

### `extensions/worker.ts` — Worker's capability

- `worker_signal` tool: `planned` / `done` / `flag`. `planned` is a
  deliberate pause for Foreman input (not a routine progress ping); `done`
  is a discriminated schema variant requiring `prUrl`, after commit, push,
  and PR creation. Signals append to
  `~/.foreman/tasks/<id>/events.jsonl` (outside the repo) and emit
  `pi.events.emit("herdr:blocked", ...)` for `flag`.
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
    _final_ message's text content, and the final message here was a
    tool call with no text).
  - **Not verified live**: the `MAX_NAGS_PER_RUN` cutoff-and-settle
    branch itself (hard to force a model to stonewall on purpose).
    Implemented, untested.
  - Provider/model failures (`stopReason: "error"`) bypass corrective
    turns. CONTEXT: a live 429 insufficient-balance error was observed
    triggering repeated paid retries because the hook mistook failure for
    noncompliance; mocked Worker/Verifier hooks now verify zero retries for
    errors while ordinary omissions still get one.

### `extensions/verifier.ts` — Verifier's capability

- `verifier_signal` tool: `approve` / `deny` / `flag`. Appends to the
  shared `~/.foreman/tasks/<id>/events.jsonl` with `role: "verifier"`,
  emits `herdr:blocked` for `flag`, and terminates the turn. The detailed
  durable review is a visibly marked GitHub PR comment; signal context is
  only a routing summary.
- Same turn-end nag hook as worker.ts (`MAX_NAGS_PER_RUN = 3`): a
  Verifier that goes idle without a verdict is a stuck review.
- **Verified live, all three verdicts**: `approve` (full chain — Worker
  done → plugin spawned Verifier → Verifier reviewed → approved →
  Foreman notified); `deny` (corrupted the Worker's file before the
  Verifier read it → Verifier caught the mismatch, denied → plugin
  re-prompted the Worker, which resumed `working`); `flag` (asked the
  Verifier to falsely deny already-approved correct work → it refused
  and flagged instead, validating both the `flag` routing _and_ the
  prompt guideline against rubber-stamping).

### `plugins/task-events/` — the automatic-notification piece

This is a **herdr plugin**, a different kind of artifact than the pi
extensions above — a directory with `herdr-plugin.toml` + `notify.mjs`,
registered via `herdr plugin link <dir>` (local dev) rather than loaded
by pi at all.

**Why this exists**: Foreman polling (a tool it calls on demand) cannot
deliver automatic awareness — nothing wakes an idle LLM session between
your messages to make it check. This was the actual decision point this
session; see "Key decisions" below.

**How it works** (now role-aware, routing both Worker and Verifier
signals): herdr fires `pane.agent_status_changed` for _every_ pane on
the machine. `notify.mjs`:

1. Reads `HERDR_PLUGIN_EVENT_JSON.data.{pane_id,agent_status}`.
2. No-ops for `working`/`unknown` and for panes not in
   `~/.foreman/registry.json`.
3. Looks up the task and reads the last line of
   `~/.foreman/tasks/<id>/events.jsonl`.
4. Routes by the pane's registry `role`:
   - **Worker** signals notify Foreman. Only `done` (which includes the PR
     URL) starts review: spawn a Verifier as a split in the Worker's
     workspace, or re-prompt the existing one to re-review the PR.
   - **Verifier** verdicts notify Foreman. `deny` also prompts the Worker
     with the PR URL and tells it to read the marked Verifier comment,
     fix, push, respond on the PR, and re-signal `done`.
     Foreman independently decides whether any signal context warrants an
     OS-notification `flag`; verdict names do not determine attention.

Verifier spawn writes a second registry entry (`role: "verifier"`,
linked back to the worker pane via `workerPaneId`; the worker entry gets
`verifierPaneId`) so the Verifier's own status changes route correctly
and later reviews re-prompt instead of re-spawning. The Verifier prompt
is a single line with quotes stripped — herdr shell-encodes `agent
start -- <argv>` for the target pane and rejects multi-line/quoted
prompts as unsafe (real failure, found in plugin logs).

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
causes exactly this). State kept in `$HERDR_PLUGIN_STATE_DIR/seen.json`,
keyed by task id + role + event timestamp.

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

Foreman itself is launched as
`pi -e /path/to/foreman-lite/extensions/foreman.ts --skill /path/to/foreman-lite/skills/foreman`
from the target project's repo root. As above, that `pi` process must itself
run inside a herdr pane (so it inherits `HERDR_PANE_ID`) — outside herdr
`create_task` still works, but `foremanPaneId` is `undefined` and the plugin
silently skips pushing for that task (checked explicitly in `notify.mjs`,
not a crash).

**Role definitions are not skills.** Each role's directives live as markdown
in `roles/{foreman,worker,verifier}.md` and are injected as an always-on
system prompt by the matching extension via `before_agent_start` (read by
`extensions/roles.ts`). Skills are progressive-disclosure (body loads
on-demand via `read`, which models don't always do) — wrong for a role that
must govern turn 1. `skills/foreman/SKILL.md` remains as Foreman's on-demand
_reference_ (task model, on-disk state, herdr commands, compaction recovery);
the directives are injected, not duplicated there. Verified live with the
refactor: Worker done → Verifier spawned (role injected, spawn prompt
reduced to task context only) → approve.

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
  at most a short label; routing summaries live in the external task event
  log and durable review details live on the PR; (4) task identity that
  outlives one pane's process lifetime — herdr's
  name→agent mapping clears on exit, `registry.json`/`meta.json` don't.
- **Push over pull for Foreman awareness, decisively, not just
  preferentially.** The deciding argument: an idle LLM session cannot
  spontaneously decide to check something between your messages — pull
  literally cannot deliver "Foreman conversation shows state transitions
  automatically" no matter how good the polling tool is. This is why the
  herdr plugin exists instead of the previously-planned Foreman-side
  poller (that plan is now dead, not deferred).
- Two named, reproduced, _not_ fully root-caused "file write, then
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

1. Dogfood the PR workflow: Worker creates a marked PR, Verifier posts a
   marked review comment, deny routes the Worker to that URL, and repeat
   review stays on the same PR.
2. Refresh this file again as anything above changes.

## Functional completeness

With merge authority retained by the human, the build is functionally
complete per vision.md: all three roles' commands exist and are
live-verified, the task-events plugin auto-routes every signal, and
`skills/foreman/SKILL.md` now carries Foreman's role definition + the
on-disk state layout (so compaction only loses conversation, not task
awareness — Foreman re-reads `registry.json`/`events.jsonl` to recover).
Role separation ("MUST not implement") and "run tests before done" are
prompt-level, not technologically binding, per the human's call.
