# Vision validation against the opencode ecosystem

2026-08-04. Source inspection of `~/develop/opencode` (dev branch) + opencode.ai docs, not marketing claims. Supersedes the opencode portions of `base-system-comparison.md` where they conflict. This is the "is the vision buildable here" check; it does not recommend a base.

## Headline

The vision is **more native to opencode than to Claude Code**, and the gaps that forced compromises in the current Claude Code implementation have platform-level answers. Three things materially changed the picture:

1. **Compaction is a checkpointing *extension point*, not a fixed behavior.** The `experimental.session.compacting` plugin hook can inject context into or fully replace the compaction prompt, and `session.summarize` triggers compaction programmatically. The vision's ADR-shaped, negative-knowledge-preserving checkpoint is implementable as a plugin, no fork.
2. **Reuse is a native UI action.** Primary agents (mode: `primary`) are Tab-switched mid-session while retaining working memory — the exact "change role, keep working memory" operation that Claude Code has no native form of.
3. **The foreman can be deterministic code, not an LLM role.** Plugin + SDK exposes session creation, prompting, message reading, event subscription, and structured output. Orchestration logic can live in a program instead of a prompt, which is where the current foreman-lite implementation is weakest.

## Vision concepts → opencode primitives

| vision.md concept | opencode primitive | Fit |
|---|---|---|
| Thread | `Session` (SQL-backed, resumable, `session.list`/`create`/`children`) | Native |
| Working Memory | Session message history (parts, tool calls, reasoning) | Native; disposable via summarize/revert/abort |
| Role | `Agent` (primary/subagent; system prompt + permission + model) | Native |
| Reuse (change role, keep WM) | Tab-switch between primary agents in one session; or prompt a live subagent session again | Native (primary agents) / emulate (subagents) |
| Fork (fresh WM from task state) | Spawn subagent → new child session seeded by assignment prompt | Native |
| Recycle (checkpoint, drop WM) | `session.summarize` + discard; `/clear`-equivalent via revert | Native trigger, custom format |
| Task State (durable, ≠ WM) | Nothing. Custom files (or plugin-owned storage) | Build |
| Lifecycle signals (/done /pass /checkpoint) | No native semantic stops. Verdicts = subagent final message or `session.idle` event | Emulate |
| Foreman | Plugin + SDK client; deterministic orchestration | Build |
| Director | User's TUI session with a primary `foreman` agent | Build |
| Director-level dashboard | Not native; plugin has `tui.*` hooks only | Build |

## Checkpointing / compaction

The vision's checkpoint requirement decomposes cleanly against opencode's compaction as an extension point: replace the summary prompt via the `experimental.session.compacting` plugin hook (ADR-shaped, rejected-alternatives field), trigger it at lifecycle boundaries via `session.summarize`, and persist the emitted summary after `session.compacted`. Full source findings, no decision: `docs/research/opencode-compaction-checkpointing.md`.

## Foreman as a plugin, not a prompt

The current foreman-lite foreman is an LLM role (skill + verdict-reading). opencode's plugin surface makes it a program:

- `session.create` (with agent/model), `session.prompt` (`noReply: true` for context injection without a reply), `session.message`/`messages`, `session.children`, `session.summarize`, `session.revert`.
- `event.subscribe()` / plugin event hooks (`session.idle`, `session.compacted`, `tool.execute.before/after`) → deterministic trigger for lifecycle handling and verdict parsing.
- **Structured output**: `session.prompt` accepts a JSON schema (`format: json_schema`) and returns validated objects. A task agent can return `{status, decisions, unresolved, artifacts}` in one structured turn instead of the foreman parsing prose verdicts. This is the strongest fix for the "reported done" risk noted in `agent-teams.md`.

Subagent spawns remain the fork path: a fresh child session seeded from task-state files, permissions declaratively restricted (`permission.edit: deny` for a reviewer) — reviewer independence is a config field, not a convention.

## Reuse vs fork — now an explicit native choice

- Reuse: Tab between custom primary agents (`dev`, `review`, ...) in the same session. This is the closest thing to the vision's "role is a mode, not an agent" — the role is literally a switchable mode on one working memory.
- Fork: `Task`-tool subagent spawn, fresh child session; TUI `session_child_first`/`session_parent` navigates the director into task working memory.

Caveat: custom primary agents still have fixed system prompts; a "validator reviews while seeing dev's memory" is the Tab-switch, and "validator judges independently" is the fork — matching the vision's continuity-vs-independence choice. The editor-note question ("how will the foreman know when independent judgment is valuable?") remains open and is the same problem in both bases.

## Open questions / gaps left to build

- Task State entity (files vs plugin DB). File-based is consistent with the existing foreman-lite choice; nothing in opencode argues either way.
- Lifecycle-verdict protocol between task agent and foreman plugin (structured-output schema vs prose).
- Director dashboard. Plugin `tui.*` hooks are toast/prompt nudge, not a task-list view; a real dashboard means a web/custom UI.
- Deciding *when* to fork vs reuse — unresolved in the vision, unresolved here.

## Shelf life

Re-check when the `experimental.session.compacting` hook and `session.summarize` signatures change (both flagged experimental/legacy in places). The agent/permission/session API surface is stable. Referenced files: `packages/opencode/src/session/compaction.ts`, `packages/opencode/src/session/summary.ts`, `packages/core/src/session/compaction.ts`, `packages/core/src/config/compaction.ts`, `packages/opencode/src/agent/agent.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.
