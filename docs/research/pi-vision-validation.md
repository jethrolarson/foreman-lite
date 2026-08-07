# Vision validation against pi (@earendil-works/pi-coding-agent)

2026-08-04ish. Source inspection of the installed pi package (`docs/extensions.md`, `docs/compaction.md`, `docs/sdk.md`, README) at the version on this machine. Same exercise as `opencode-vision-validation.md`, other base. Not a recommendation between bases — just "is the vision buildable here, and what does it look like."

## Headline

pi is architecturally the opposite bet from opencode: opencode ships session/agent/subagent primitives natively and asks you to bend them; pi ships almost nothing (`read`/`write`/`edit`/`bash`, one session type) and asks you to build the rest as an extension. Pi explicitly has **no sub-agents, no plan mode, no built-in to-dos** by design (see README "Philosophy") — the entire vision (Director/Foreman/Task/Role/working-memory-ops) has to be built as a pi extension. Nothing here is a config choice the way opencode's `Agent`/Tab-switch is; it's all TypeScript against the event/session API.

The upside: pi's session-tree + event model maps unusually well onto the vision's *own* vocabulary (thread, working memory, checkpoint) because pi already treats these as first-class, separable concepts rather than fusing them like opencode's `Session`. The downside: there's no subagent runtime to lean on — forking a task means driving `createAgentSession`/`ctx.newSession` yourself, including your own multi-session bookkeeping.

## Vision concepts → pi primitives

| vision.md concept | pi primitive | Fit |
|---|---|---|
| Thread | A session (JSONL, tree-structured, `SessionManager`) | Native |
| Working Memory | Active branch of a session (`buildContextEntries()`) | Native; disposable via compaction/`/tree` navigation |
| Task State (durable, ≠ WM) | Nothing built in. Extension-owned store (files, or a dedicated task-state session) | Build |
| Role | Nothing built in — no `Agent`/mode concept. System prompt is one global string per session | Build (see below) |
| Reuse (change role, keep WM) | Mutate system prompt for a turn via `before_agent_start` return `{ systemPrompt }`, same session | Buildable, not native |
| Fork (fresh WM from task state) | `createAgentSession()` (SDK) or `ctx.newSession()` (extension command) with a seeded `setup()` | Buildable via SDK, no native subagent runtime |
| Recycle (checkpoint, drop WM) | `ctx.compact()` / `session_before_compact` custom summary, or `ctx.navigateTree()` with `summarize: true` | Native trigger, custom format needed |
| Lifecycle signals (/done /pass /checkpoint) | `pi.registerCommand()` — literal `/done`, `/pass`, `/checkpoint` slash commands | Native mechanism, semantics ours |
| Foreman | An extension: event handlers + command handlers + own session/task bookkeeping | Build |
| Director | The user's interactive pi session, talking to the foreman via commands/tools | Build |
| Director-level dashboard | `ctx.ui.setWidget()` / `setStatus()` (footer/widget text), no task-list view | Build (text-only unless custom TUI component) |

## Checkpointing / compaction

This is the strongest native fit, and stronger than opencode's overflow-only compaction. `session_before_compact` fires on **three** reasons (`manual`, `threshold`, `overflow`) — `threshold` is a *proactive*, pre-overflow trigger pi already has that opencode's `compactIfNeeded` doesn't (opencode is overflow-only, see `base-system-comparison.md`). The handler gets `preparation.messagesToSummarize`, can return a fully custom `{ summary, firstKeptEntryId, tokensBefore, details }`, and `details` is your own JSON shape — the ADR-shaped, negative-knowledge-preserving checkpoint (`Decision / Context / Alternatives / Rejected / Consequences / Unresolved`) drops straight into `details` with zero fighting the default format, same as opencode's plugin hook.

Two extra levers pi has that opencode's compaction doesn't map onto directly:
- `session_before_tree` fires on `/tree` branch navigation and can also emit a custom summary — a second, independent checkpoint trigger point (branch abandonment) distinct from context-overflow.
- `ctx.compact()` can be called by an extension at any point (e.g. right after a `/done` command fires), not only on overflow/threshold. This is the direct implementation of "task agent may `/checkpoint`, foreman decides whether to wipe working memory" from vision.md — a `/done` or `/checkpoint` command handler can call `ctx.compact({ customInstructions })` itself, no need to wait for the token-driven trigger.

## Foreman as an extension, not a prompt

Same shape as the opencode finding but with more legwork, since pi has no `session.summarize`/`session.children` SDK equivalent for cross-session orchestration built for this purpose — you drive it directly:

- **Commands** (`pi.registerCommand`) are the natural home for lifecycle signals: `/done`, `/pass`, `/fail`, `/checkpoint` as literal slash commands, each running deterministic TS, not LLM-interpreted prose. This is a stronger fit than opencode's plugin-hook-only vantage: the command *is* the lifecycle transition, not an inferred verdict.
- **Structured verdicts**: pi has no built-in structured-output tool-result contract equivalent to opencode's `format: json_schema` on `session.prompt`. A task agent's `/done` would need to either (a) be a tool call whose typed `parameters` (typebox) carry `{status, decisions, unresolved, artifacts}`, forcing structure at the call site, or (b) rely on the command handler parsing the preceding assistant message. (a) is the safer bet and mirrors the "reported done" risk noted in `agent-teams.md` — make the LLM fill a schema to claim done, don't trust free text.
- **Cross-task/session visibility**: `ctx.sessionManager` only sees the *current* session. A foreman that needs to see task metadata across multiple task-threads has to persist that metadata itself (task-state files, as already planned) rather than querying a live session registry — pi doesn't expose a `session.list`-with-status API at the extension layer beyond `SessionManager.list(cwd)` (file discovery, not live state).

## Reuse vs fork — buildable, not native, in either direction

- **Reuse** (Engineer → Validator, same working memory): no Tab-switch primitive like opencode's primary agents. Emulated via `before_agent_start` returning a different `systemPrompt` for the next turn, driven off task-state (e.g. "current role: Validator" recorded in task-state file, read by the extension, injected). Same working memory, because it's still the same session — this part is actually simpler than opencode's Tab-switch mechanics since there's no agent-mode object to swap, just a string.
- **Fork** (fresh WM from task state): `ctx.newSession({ setup, withSession })` from a command, or `createAgentSession()` from a standalone SDK script if the foreman runs as its own process rather than in-session. `setup()` seeds the new session's first message(s) from task-state content instead of the old session's transcript — this is exactly vision.md's fork operation. Caveat from `extensions.md`: the `withSession` callback runs in a *fresh* extension instance; captured old `ctx`/`pi` objects are stale and will throw if reused. A foreman spawning forked task sessions must treat each fork as a real session-replacement event, not a lightweight subroutine call — more ceremony than opencode's `Task`-tool subagent spawn (which stays a child of the current session/plugin process).

## Director-level dashboard

Weaker than opencode here too, but differently: pi's `ctx.ui.setWidget()`/`setStatus()` can render a text block above the editor or in the footer — enough for the vision's task-list mock (`● Auth refactor  Engineer  143k  waiting validation`) as plain text, refreshed on lifecycle command events. A richer interactive dashboard would need `ctx.ui.custom()` (full TUI component, `ctx.mode === "tui"` only — no-ops in RPC/print mode). Functionally equivalent ceiling to opencode's `tui.*` hooks (toast/status only, no native list view) — both need the same amount of custom UI work.

## Open questions / gaps left to build (same shape as opencode's list, different cost)

- Task State entity: identical decision to opencode's — file-based, extension-owned. No platform argument either way.
- Lifecycle-verdict protocol: pi's typed tool-parameters (typebox) are a slightly better forcing function than opencode's optional JSON-schema `session.prompt` flag, since a custom tool's schema is *always* enforced by the harness, not opt-in per call.
- Foreman is more work in pi than opencode specifically for **multi-session orchestration** — opencode's SDK client was built for exactly this (`session.create`, `session.children`, `session.summarize` as a coherent orchestration surface); pi's `ctx.newSession`/`ctx.fork` are session-*replacement* primitives (they replace the current runtime's active session) rather than a parent-spawns-and-watches-children model. A foreman that needs several task sessions alive concurrently (not just "switch to this session") likely needs a separate driver process using the SDK's `createAgentSession()` per task, coordinated by the foreman extension via files/IPC rather than in-process session objects.
- Director dashboard: build regardless of base, same as opencode's finding.
- "How will the foreman know when independent judgment is valuable" (fork vs reuse): still unresolved, still base-independent.

## Off-the-shelf building blocks

2026-08 pass, npm registry + the pi package's own `examples/extensions/`. None of this changes the headline (still all extension-layer, nothing native) but several bundled examples are close enough to vision.md operations to fork from directly instead of writing from scratch.

### Bundled examples (in the pi package itself — vetted, part of the repo, safe default starting point)

| vision.md concept | Example | What it actually does |
|---|---|---|
| Fork + Role | `examples/extensions/subagent/` | Spawns a task as an isolated child `pi` process; agents are markdown files (system prompt + model + tool allowlist) — this *is* vision.md's "role = system prompt + capabilities temporarily assigned," just realized as a subprocess instead of same-process mode switch. Ships single/parallel/chain tool modes and streaming/usage-tracking UI already built. Closest existing scaffold for Fork. |
| Reuse | `examples/extensions/plan-mode/` | Toggles tool availability (write tools on/off) and bash allowlist within *one* session/working memory, driven by a mode flag. Not role-as-system-prompt-swap, but the same shape: change behavior, keep working memory. Useful reference for the `before_agent_start` system-prompt-swap approach described above. |
| Recycle / Checkpoint | `examples/extensions/handoff.ts` | Already implements roughly vision.md's checkpoint-and-fork: summarizes current branch (compaction-aware) with an LLM call, lets the user edit the generated handoff prompt, then opens a *new* session seeded with it. Missing the ADR shape (decisions/rejected-alternatives) and the foreman-driven trigger — it's user-invoked (`/handoff <goal>`) — but the mechanics (serialize branch → summarize → seed new session) are the checkpoint pipeline. |
| Recycle / Checkpoint | `examples/extensions/custom-compaction.ts`, `trigger-compact.ts` | Reference implementations for `session_before_compact` and firing `ctx.compact()` programmatically — the two hooks the ADR-shaped checkpoint needs. |
| Task State persistence | `examples/extensions/todo.ts` | Stores durable-ish state in **tool result `details`** rather than external files, so branching automatically reconstructs correct state at any point in session history. Worth an ADR note: this project's assumption of file-based task state is not the only option pi supports — session-native state avoids a second source of truth but ties task state to one session's tree instead of being cross-session/cross-thread, which the vision requires (task state must survive working-memory destruction *and* be readable by a forked sibling). File-based likely still wins for that reason, but todo.ts's pattern is the right building block if task state is ever scoped to stay within one thread. |
| Lifecycle signal (`/done`) | `examples/extensions/structured-output.ts` | Demonstrates a tool call with `terminate: true` — the model ends its turn on the tool call itself, no extra LLM round-trip. This is the building block for a `done` tool (vs. a `/done` slash command) that also forces structured verdict fields (typebox), covering both the "lifecycle signal" and "structured verdict" gaps in one primitive. |
| Foreman internals | `examples/extensions/event-bus.ts` | `pi.events` inter-extension pub/sub. If the foreman is split across multiple extension modules (role-switcher, checkpoint-trigger, task-state store), this is the wiring between them without coupling to session/UI state directly. |
| Director dashboard | `examples/extensions/status-line.ts`, `custom-footer.ts`, `widget-placement.ts`, `model-status.ts` | Reference implementations for footer/widget text — enough to build the vision's plain-text task list (`ctx.ui.setWidget`) but no closer to a real dashboard than noted above. |
| Director dashboard (richer) | `examples/extensions/overlay-qa-tests.ts`, `questionnaire.ts`, `modal-editor.ts` | Show the `ctx.ui.custom()` full-TUI-component pattern, TUI-mode only — the path to an actual interactive task list, if wanted later. |

### Third-party npm packages (unvetted — review before installing, per README's own security warning)

npm `keywords:pi-package` search surfaces a live ecosystem of subagent/orchestration extensions, several claiming exactly the Foreman-shaped territory this project is building:

- `@zhushanwen/pi-subagent-workflow` — claims "stateful workflow management with persistence, state machine, and execution tracing" on top of spawned-process subagents.
- `@melihmucuk/pi-crew` — "non-blocking subagent orchestration."
- `@heyhuynhgiabuu/pi-task` — foreground/background subagents with tmux observability (has a real repo, unlike several others below).
- `@d3ara1n/pi-subagent` — "role-based subagent orchestration" with "configurable model roles" per child process.
- `avtc-pi-subagent` — subagent with context compaction and *nested* subagents.

Caveat before touching any of these: several have no `repository` field, mismatched weekly/monthly download counts, and names/descriptions that read as LLM-generated marketing copy — classic signs of low-effort or auto-published packages rather than maintained tools. README's own words apply directly: "Extensions run with your full system access... review source code before installing third-party packages." None of this changes the architecture conclusion above — even a well-built third-party subagent package still won't have the vision's specific Task State / ADR-checkpoint / lifecycle-signal distinctions built in, because those are this project's own design, not a generic "subagent" feature. Treat these as candidates for *pattern review* (how did they solve process lifecycle, streaming, cost tracking) rather than dependencies to adopt wholesale.

## Shelf life

Re-check if `pi.registerCommand`, `session_before_compact`, `ctx.newSession`/`ctx.fork`, or the tool-parameter (typebox) contract change — these are the four load-bearing APIs for this mapping. Extension/event surface is documented as stable public API (`docs/extensions.md`), lower churn risk than opencode's `experimental.session.compacting` hook. pi is open source (`github.com/earendil-works/pi-mono`, MIT), but this pass was doc-only against the installed package's `docs/*.md`, not a source clone like the opencode research pass — treat claims about internals (e.g. `SessionManager.list` scope, `withSession` staleness) as doc-sourced, not code-verified; a follow-up source pass would sharpen this the same way `opencode-compaction-checkpointing.md` did.
