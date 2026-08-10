# Foreman-lite

Talk to one orchestrator agent (Foreman); it delegates work to Worker agents and
makes sure a Verifier reviews each result — so you stay out of the plate-spinning
and review loops, and no single agent's context gets bloated holding it all.

Built on [herdr](https://herdr.dev) for panes/worktrees and
[pi](https://github.com/earendil-works/pi-coding-agent) for the agents. State
transitions are **pushed** to Foreman automatically — it doesn't poll, so you see
"task done / approved / blocked" arrive on their own.

## How it works

You talk to **Foreman**. It creates **Task Threads**: a git worktree + a **Worker**
agent doing the work + a **Verifier** agent reviewing the Worker's actual changes
(same worktree). Each role ends every turn with a signal:

- Worker: `planned` · `done` · `flag`
- Verifier: `approve` · `deny` · `flag`

A herdr plugin watches every pane and routes signals automatically. `done`
requires the Worker to push its branch and open a PR, then spawns/prompts the
Verifier. The Verifier leaves a visibly marked review comment on that PR; a
`deny` sends the Worker back to those comments. All signals also land in
Foreman's conversation, where Foreman decides contextually whether they need
your attention. Merge authority stays with you.

## Setup (once per machine)

```sh
brew install herdr
herdr integration install pi            # reports pi's working/idle/blocked to herdr
herdr plugin link /path/to/foreman-lite/plugins/task-events
```

## Run

`bin/foreman` resolves its own paths, so run it from your project's repo root,
inside a herdr pane (extra args pass through to pi):

```sh
foreman-lite/bin/foreman            # or add bin/ to PATH / alias it
```

Then just ask Foreman to do things — "add a feature X", "fix the bug in Y". It
spawns workers, tracks them, and tells you when work is verified and ready to
merge. Drill into any thread directly with `herdr agent attach <name>`.

## Project layout

```
extensions/   foreman.ts, worker.ts, verifier.ts — each role's tools + injected role
roles/        *.md role definitions (injected as system prompt, not skills)
skills/foreman/SKILL.md   Foreman's on-demand operational reference
plugins/task-events/      herdr plugin: routes signals, spawns the Verifier
docs/        vision.md (the what/why), handoff.md (current state + how to verify)
```

## Status

Functionally complete per `docs/vision.md`. Workers open PRs, Verifiers keep a
durable marked review record in PR comments, Foreman decides contextually which
signals warrant human attention, and merge authority stays with the human. See
`docs/handoff.md` for what's verified and the known rough edges.
