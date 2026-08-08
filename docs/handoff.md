# Handoff / checkpoint

Written just before a context compaction, 2026-08-08. Read this first if
you're picking this up fresh — it's the actual "if working memory
disappeared, what would you need to know" checkpoint, the operation
`docs/vision.md`'s open questions kept referring to and we never got
around to designing on purpose (see "Should we bring back `/recycle`" in
vision.md's open questions — this doc is the answer in practice, not
theory: task-triggered, written by hand, not a generic summarizer).

## Where things actually stand

**`docs/vision.md`** is the current source of truth, user-authored, not
agent-authored. Don't second-guess its architecture without checking with
the user first — it went through a real elicitation process
(`docs/archive/vision-rederived-notes.md` has that history if you need
the reasoning behind a specific claim in it, but vision.md itself is what
to build against).

**Everything else under `docs/`** except `vision.md` and this file was
deliberately gutted by the user mid-session — old ChatGPT-derived
planning docs, research, ADRs, specs. Four survive in `docs/archive/` for
reference only (inception.md, pi-vision-validation.md, vision-chatgpt.md,
vision-rederived-notes.md) — don't build against them, they predate the
current vision.md and the herdr discovery below.

**`skills/foreman/SKILL.md`** is stale — references `.claude/foreman-lite/`
paths, `task.json`/`handoff.md`, Reuse/Fork/Recycle vocabulary from the
Claude-Code-era design. Needs a rewrite against vision.md's actual
Foreman/Worker/Verifier + `/planned` `/done` `/flag` `/approve` `/deny`
vocabulary and the herdr-based mechanism below. Explicitly deferred
twice already — still not done.

## The actual architecture decision (this session)

Foreman-lite runs as a pi extension. The key structural move: **capability
is scoped by which extension a given `pi` invocation loads, not by any
built-in notion of role.** A plain `pi` process has no more ability to
create a task than any other. Two separate extension files exist for
exactly this reason:

- `extensions/foreman.ts` — loaded only for the session you talk to
  (`pi -e /path/to/foreman-lite/extensions/foreman.ts`, run from the
  target project's repo root — e.g. noolang). Registers `create_task`,
  (and `halt_worker` — not yet written, see Next steps).
- `extensions/worker.ts` — loaded only for Worker panes, passed via `-e`
  by `create_task` itself when it spawns the pane. Registers
  `worker_signal` (the `/planned` `/done` `/flag` tool). Workers never
  load `foreman.ts`, so they structurally cannot create tasks or halt
  siblings — not a prompted convention, an actual capability gap.

## herdr — the load-bearing discovery this session

`https://github.com/herdrdev/herdr` (Rust, Apache-2.0, 25k+ stars, real
project) is a terminal/agent-state multiplexer purpose-built for exactly
this problem. It replaces what would otherwise have been our own
hand-rolled tmux orchestration plus a fs-watcher-and-OS-notification
mechanism for the push/blocked-detection design from `docs/vision.md`.

**Installed and confirmed working on this machine:**

- `brew install herdr` — installed, v0.8.0.
- `herdr integration install pi` — installs
  `~/.pi/agent/extensions/herdr-agent-state.ts` globally (auto-loads for
  *every* pi session on this machine, Foreman and Worker alike — this is
  a machine-level prerequisite, not something foreman-lite's own
  extensions handle. **A fresh machine needs this run once.**
- That integration hooks pi's own `agent_start`/`agent_settled` events for
  working/idle, and listens for a custom `pi.events` event named
  `"herdr:blocked"` (`{ active: boolean, label?: string }`) for blocked
  state — **this is the entire integration surface `worker.ts`'s `flag`
  action needs, verified working end-to-end this session**: calling the
  `flag` action flips herdr's `agent_status` to `"blocked"` immediately,
  no socket code required on our side.

**Commands confirmed working, verified live this session (not just read
from docs):**

```
herdr worktree create --cwd <repoRoot> --branch <name> --label <name> --no-focus
  → JSON with pane_id, worktree checkout_path, branch. Worktree lands
    under ~/.herdr/worktrees/<repo>/<label>/, NOT a sibling directory —
    different from what extensions/foreman.ts currently does (git
    worktree add as a sibling dir). Rewrite needs to either adopt
    herdr's location or pass --path explicitly if we want sibling dirs.

herdr agent start <name> --kind pi --pane <pane_id> -- <argv...>
  → spawns plain `pi` in that pane (no -e unless you pass one in argv),
    returns agent_session.value = the real pi session JSONL path.
    Args after -- are passed as a real argv array, not a shell string —
    confirmed no escaping needed, so extensions/foreman.ts's current
    shellQuote/workerShellCommand/promptFile machinery is unnecessary
    once rewritten against herdr; the prompt can be passed as a plain
    argv string directly to `pi`.

herdr agent prompt <name> <text> --wait   → inject a message, wait for reply
herdr agent get <name> / agent list       → JSON status incl. session path
herdr agent send-keys <name> esc          → candidate mechanism for halt_worker
herdr agent wait <name> --until blocked --timeout <ms>  → block until state
herdr agent attach <name>                 → the "pull" mechanism (property #5)
herdr notification show                   → exists, not yet explored
```

Full transcript of the verification (worktree create → agent start →
prompt → read output → flag tool → blocked state, all confirmed) is in
this session's conversation history if you need to re-verify anything —
not reproduced in full here, but nothing above is speculative, all of it
was actually run.

## Files that exist right now

- `extensions/foreman.ts` — **STALE, not yet rewritten against herdr.**
  Currently still contains the original raw-tmux implementation
  (`execFileSync("tmux", ...)`, `git worktree add` as a sibling dir,
  `.foreman/tasks/<id>/meta.json` + `prompt.md`). This was tested and
  confirmed working *before* the herdr discovery. Rewriting it to use
  `herdr worktree create` + `herdr agent start --kind pi -- ...` (passing
  `extensions/worker.ts`'s path via an `-e` arg baked into that argv) is
  the immediate next step. Keep the task-id/branch-naming pure helpers
  (`slugify`, `taskId`, `branchFor`) — those don't change. Drop
  `workerShellCommand`/`shellQuote`/`ensureTmuxSession`/`tmuxSessionExists`
  — herdr replaces all of it. Decide whether `.foreman/tasks/<id>/meta.json`
  is still needed (herdr's own `agent get <name>` may cover most of it,
  but herdr's name→agent mapping clears when the process exits, so some
  durable record of task→worktree-path is probably still worth keeping
  for resuming after a Worker pane dies).
- `extensions/worker.ts` — written and building cleanly this session
  (fixed a module-level-mutable-`pi` code smell before checkpointing;
  current version closes over `pi` properly). **Not yet tested
  end-to-end as a real `-e` argument passed through `herdr agent start`**
  — the manual herdr verification above used an ad hoc test tool
  (`/tmp/herdr-blocked-test.ts`, not this file) to confirm the
  `herdr:blocked` mechanism. `worker.ts` itself hasn't been run yet.
  Writes domain-level lifecycle events to `<worktree>/.task/events.jsonl`
  — this is real Task State per vision.md's definition (file state in the
  worktree, shared/readable by worker and verifier), not just an herdr
  passthrough.
- `docs/vision.md` — current, user-authored, source of truth.
- `docs/handoff.md` — this file.

## Next steps, in order

1. Rewrite `extensions/foreman.ts`'s `create_task` against herdr (see
   above). Test end-to-end against a scratch repo the same way the tmux
   version was tested earlier this session — don't skip that, both the
   tmux version and the herdr primitives were independently verified,
   but the *combination* (create_task actually invoking herdr, with
   worker.ts as the spawned `-e`) has not been.
2. Add `halt_worker` to `foreman.ts` (`herdr agent send-keys <name> esc`
   is the leading candidate, unverified).
3. Test `worker.ts`'s `flag`/`done`/`planned` for real, spawned through
   `create_task`, not the ad hoc test tool.
4. Verifier doesn't exist yet at all — no extension, no spawn-on-`/done`
   wiring, no `/approve`/`/deny` tool. This is the next major piece after
   Worker is solid.
5. Rewrite `skills/foreman/SKILL.md` (see above — stale, deferred twice).
6. Foreman needs a way to actually see task state/events across task
   threads to satisfy vision.md's "Foreman conversation shows the state
   transitions for all sub-agents" — not designed yet. `herdr agent
   list`/`agent get` plus reading each task's `.task/events.jsonl` are
   the likely ingredients, no mechanism wired yet (polling? a tool
   Foreman calls on demand? — open, matches the still-parked
   Checkpoint-adjacent questions from `docs/archive/vision-rederived-notes.md`).

## Things not to re-litigate without new information

These were genuinely decided this session, with real reasoning behind
them (ask the user before overturning, don't just re-derive from
scratch):

- Foreman never reviews or implements — bandwidth protection, not a
  quality argument.
- Review defaults to independent (herdr calls this "agent start" fresh,
  vision.md's Worker/Verifier split) rather than same-context self-review.
- No hand-crafted "expert system" decision logic for things like
  loop-termination — give Foreman visibility + handles (`agent wait`,
  `agent send-keys`), let judgment handle it, mechanize only what proves
  reliably mechanical after real usage.
- Task Thread capability is scoped structurally (which extension loads),
  not by prompt convention.
- `/flag`'s content should be worded for the human, even though it's
  mechanically intercepted by Foreman/herdr first.
