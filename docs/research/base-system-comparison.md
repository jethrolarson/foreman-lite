# Base system comparison: opencode vs mini-kode vs custom

2026-08-02. Findings from live source inspection (shallow clones), not documentation pages — opencode's own docs site renders as an SPA shell and gave near-zero usable detail via fetch.

## Why this came up

Current setup layers foreman-lite's vision (Director/Foreman/Task orchestration, see `docs/vision.md`) on top of Claude Code's own conventions (subagents, `/clear`, hooks). Question raised: would a different base — one we own end to end — get closer to the vision with less fighting the host's conventions.

## Sizes and stacks

- **opencode** (`github.com/sst/opencode`): ~607k LOC TypeScript monorepo (`packages/`: core, cli, tui, desktop, server, plugin, sdk, web, enterprise, slack, ...). Core is Effect.ts throughout (typed errors, Layer/Context DI, fiber concurrency). SQLite + drizzle persistence, OpenTelemetry tracing, 20+ AI-SDK providers vendored, client/server split (server driven by TUI/desktop/web/vscode clients).
- **mini-kode** (`github.com/minmaxflow/mini-kode`): ~20k LOC, single TS package. Explicitly educational ("understand and hack modern AI coding assistant systems"). Plain agent loop (LLM → tool select → execute → stream), OpenAI-SDK-compatible client only, Ink TUI, MCP client support, two-layer permissions, simple session persistence. No compaction, no client/server split, no LSP.

Full clone of opencode now at `~/develop/opencode` (shallow, `--depth 1`) for direct poking.

## Vision-model mapping against opencode's actual primitives

Checked against source, not the marketing docs:

**Native fit**
- `Agent` (`packages/core/src/agent.ts`) ⇒ vision.md's *Role*. Named id + Info (system prompt + capabilities), selectable, has a default (`"build"`).
- `Command` (`packages/core/src/command.ts`) ⇒ lifecycle signals. Named, invocable template ⇒ `/done` `/checkpoint` `/pass` `/fail` are just commands.
- `Session` (`packages/core/src/session.ts`, SQL-backed: messages, projector, runner, execution, revert, snapshot) ⇒ *Thread* + *Working Memory*, fused into one entity.
- Plugin `client` (SDK wrapping the server's HTTP session API) ⇒ a plugin can create/list/drive sessions programmatically — the actual foreman-implementation vector. No fork of opencode core needed for orchestration logic.

**Stretch — buildable as a plugin, not present natively**
- `SessionTodo` (`packages/core/src/session/todo.ts`) is a flat content/status/priority list — no decisions/rejected-alternatives/ADR shape.
- Task State as an entity *separate* from Session doesn't exist in opencode — a session's history *is* its state. vision.md's *Fork* (new working memory seeded from durable task state, trajectory dropped) has no native op.
- Nothing owns lifecycle decisions (reuse/fork/recycle/escalate) — that logic is 100% ours to write regardless of base.

**Absent, build regardless of base**
- Director-level dashboard UI (task list + lifecycle status) — no such view in opencode's TUI/desktop.
- Rejected-alternatives field in checkpoint documents.
- Task-triggered (vs. overflow-triggered) checkpoint firing — see `docs/adrs/0001-...md`.

## Compaction findings (fed into ADR 0001)

`packages/core/src/session/compaction.ts`: `compactIfNeeded` fires only on context overflow (`estimate(...) > context - max(output, buffer)`, buffer default 20k tokens, keeps last 8k tokens verbatim) — not proactive/aggressive, a last-resort safety net. Forces a structured template (Objective / Important Details / Work State: Completed·Active·Blocked / Next Move / Relevant Files), not free-text summarization. Closer to a handoff doc than "generic compaction" as first assumed. Missing: rejected-alternatives field, and it's overflow-triggered rather than task-lifecycle-triggered. Full reasoning and the resulting decision: `docs/adrs/0001-explicit-handoff-over-generic-compaction.md`.

## LSP-as-tool

opencode exposes LSP operations (hover, goToDefinition, findReferences, documentSymbol, workspaceSymbol, goToImplementation, call hierarchy) as an agent-callable tool (`packages/opencode/src/tool/lsp.ts`), not passive UI-only hover. On-demand only — automatic post-edit diagnostics are **not implemented yet** in current opencode (`TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists` in `file-mutation.ts:204` and `tool/edit.ts:88`).

The implementation itself (`packages/opencode/src/lsp/lsp.ts`, 507 lines) is wired into opencode's Effect layer/config/instance-state/event-bridge machinery — not a portable standalone module. Porting the *pattern* (spawn a language server, expose hover/definition/references as a tool call) against a generic LSP client library (e.g. `vscode-jsonrpc`/`vscode-languageserver-protocol`) is cheaper than adopting opencode wholesale or porting the Effect-wired version.

Relevant because: noolang (first target project) has its own WIP LSP for VSCode, separate from its MCP server; dominant project language is TypeScript, where `typescript-language-server` is mature and immediately usable — the same generic tool would serve both, no need to wait on noolang's LSP maturing.

## Working conclusion

Leaning mini-kode as the build base: smaller surface, no competing compaction mechanism to route around, and CLAUDE.md's own functional-style mandate arguably aligns better with Effect's composition model than mini-kode's plain imperative TS — but the size/opinion tradeoff (20k LOC blank slate vs. 607k LOC with a working session/compaction/LSP-tool substrate to bend) means the decision isn't closed. Not yet formalized as an ADR — no commitment made past this research pass.

## Incremental exploration plan (not yet started)

Each step tests one hypothesis before spending effort on the next, on vanilla opencode (no fork) using its plugin/client/command/agent surface:

1. Task-triggered ADR-shaped checkpoints beat overflow-compaction for continuity — one `/checkpoint` command + file-based task-state store (`docs/tasks/<id>.md`), no orchestration yet.
2. Role-as-mode (Engineer→Validator) is a real win over persistent subagents — 2-3 `Agent` configs + `/done`/`/pass`/`/fail` commands appending to the task-state file, single session, no plugin.
3. Fork (new working memory from task state) beats reuse for independent validation — minimal plugin using the client SDK to open a new session seeded from the task-state doc, compared against reuse on a real task pair.
4. A foreman can make lifecycle decisions from task metadata alone, without loading working memory — plugin watching command events across sessions, surfacing task/role/token-count/state as data (no UI).
5. Director needs a dedicated dashboard, not CLI output — only after 1-4 hold up.
