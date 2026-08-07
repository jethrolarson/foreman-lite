# opencode compaction as a checkpointing extension point

2026-08-04. Source inspection of `~/develop/opencode` (dev branch), file `packages/opencode/src/session/compaction.ts` plus its deps. Findings only — no decision reached, nothing to implement yet. Feeds vision.md's checkpointing section and ADR 0001 if/when the base question is decided.

## What was assumed vs what's there

ADR 0001 assumed opencode's compaction was a fixed behavior: overflow-triggered, fixed template, so the vision's ADR-shaped task-triggered checkpoint would require forking opencode. Source shows compaction is an **extension point** with two programmatic levers the ADR didn't account for.

## Findings

### Trigger: overflow *and* manual

- Auto: `compactIfNeeded` fires on context overflow (`estimate(...) > context - max(output, buffer)`; buffer default 20k tokens). Last ~2 turns preserved verbatim (`tail_turns`, 2k–8k tokens) rather than summarized.
- Manual: the `session.summarize` HTTP endpoint / SDK method creates a compaction part and runs the compaction loop. **A plugin can call this at any time** — task-triggered checkpointing is therefore already achievable from outside, at lifecycle boundaries like `/done` or a role switch, without touching opencode core.

### Shape: replaceable via plugin hook

`experimental.session.compacting` fires before the summarizer LLM runs. The hook receives `{ sessionID }` and can set:

- `output.context[]` — extra lines appended to the summary prompt
- `output.prompt` — **replaces the default summary prompt entirely**

So the ADR-shaped template (Decision / Context / Alternatives considered / Rejected + why / Consequences / Current state / Unresolved) can be the compaction prompt via plugin, preserving negative knowledge the default template has no field for.

### Anchored, not one-shot

Subsequent compactions carry `previousSummary` forward and *update* it rather than re-summarizing from scratch. Settled-but-stale facts (including rejected alternatives) survive incidentally unless explicitly pruned. Survival is not designed for, but the loss is less total than ADR 0001 assumed.

### Events and related hooks

- `session.compacted` fires on completion — a plugin can persist the emitted summary to task-state files, decoupling the checkpoint from the session it was born in.
- Related hooks: `experimental.chat.messages.transform`, `experimental.compaction.autocontinue`.
- Config (`config.compaction`): `auto`, `prune`, `keep.tokens`, `buffer`.

## What stays true

- Default template still lacks a rejected-alternatives field; the vision's negative-knowledge requirement still needs the plugin override.
- Auto compaction is still overflow-triggered, not lifecycle-aware. The vision's *default* path (task-triggered first, overflow as fallback) still has to be built — but via the hook + `session.summarize`, not a fork.

## Verified at

`packages/opencode/src/session/compaction.ts` (`processCompaction`, `create`), `packages/core/src/session/compaction.ts` (`SUMMARY_TEMPLATE`, `buildPrompt`), `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (`summarize` handler), `packages/opencode/src/agent/agent.ts` (compaction agent definition).

## Shelf life

Re-verify the `experimental.session.compacting` hook and `session.summarize` signatures if the base decision is revisited; both are flagged experimental in places and may change.
