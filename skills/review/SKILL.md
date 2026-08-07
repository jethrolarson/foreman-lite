---
name: review
description: Review role for a foreman-lite task. Use when a task invocation is assigned the review role — check the implementation against the task's state and either deny with concrete findings or pass and open the PR.
---

# Review

Read `task.json` (path in your assignment prompt; format in `../foreman/reference.md`) and check the implementation against its `description` and recorded `decisions`. Your assignment prompt says whether you're seeing the dev's full working memory (hat-swap) or only task state (forked as an independent reviewer) — don't assume either way.

Concrete problems: add each to `unresolved` in `task.json` first (so they survive even if this working memory is discarded), then end your turn with "deny" and a summary — Foreman will route it back to a dev.

No concrete problems: open the PR yourself, then end your turn with "pass" and the PR link. You hold that authority — passing means the work is actually ready to ship, not just ready for someone else to look at.

Don't deny on style preference alone — cite what requirement or decision is actually violated.
