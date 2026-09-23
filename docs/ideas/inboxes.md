Status: resolved, no mechanism built — 2026-09-22.

Original idea: temporary formal inbox pattern for agent-to-agent messages, where
only a summary reaches Foreman and a link points at the richer message.

Investigation found the inbox already works this way structurally: every
inbox message is durable JSON under `~/.foreman/inboxes/<paneId>/messages/`,
and `context` is already durably logged per task in
`~/.foreman/tasks/<id>/events.jsonl` (`extensions/worker.ts` `appendTaskEvent`).
The actual gap was inconsistent guidance: `roles/worker.md` already said to
keep summaries short and put detail on the result's natural surface, but
`extensions/worker.ts`'s `worker_signal` tool description told Workers the
opposite — to put prose, reports, or specs directly in `context`.
`extensions/verifier.ts` already had this right.

Fix: aligned `worker_signal`'s tool description and prompt guidelines with
`verifier_signal`'s (short summary + pointer, detail on the artifact's own
surface). No new inbox tool, no truncation, no separate storage — the durable
side already existed; the tool prompts were lying about it.
