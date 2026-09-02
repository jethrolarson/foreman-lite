/**
 * Shared turn-end signal-reminder logic for the Worker and Verifier extensions.
 *
 * Both roles must end a substantive task turn with their lifecycle signal, and
 * both enforce it by injecting a corrective message on `agent_end` (pi has no
 * veto-the-stop hook). But "substantive task turn" excludes a human who has
 * attached to the pane with `herdr agent attach` and asked a direct question:
 * forcing a signal there makes the role emit a spurious done/planned/approve
 * that the task-events plugin then routes to Foreman as real task state, which
 * Foreman comments on. `runOrigin` tells the two cases apart so the reminder
 * can force a turn for task work but only advise for a human aside.
 *
 * `agent_end.messages` holds only the current run's messages, not the session
 * history (pi-agent-core `runAgentLoop` returns `newMessages`), so origin is
 * read from the message that started this run plus one caller-held latch for
 * the session's first run.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type RunOrigin = "task" | "human";

// The message that opened this run: the task prompt, a Foreman inbox directive,
// this extension's own forcing reminder, or interactive human input. Assistant
// and tool-result messages are the run's body, not its start.
const startsARun = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

/**
 * Classify what initiated the run whose transcript is `messages`.
 *
 * - `task`: the session's first run (the task prompt), or a run opened by a
 *   `custom` message — a Foreman `foreman-*-directive` from the inbox, or a
 *   forcing reminder this extension already sent. The role owes a signal, so
 *   the caller forces a turn.
 * - `human`: any later run opened by a bare `user` message — someone attached
 *   to the pane and typed. The caller only advises.
 *
 * `firstRunOfSession` disambiguates the one case the messages cannot: the
 * initial task prompt is a `user` message just like later human input.
 */
export const runOrigin = (
  messages: AgentMessage[],
  firstRunOfSession: boolean,
): RunOrigin => {
  const initiator = messages.find(startsARun);
  if (!initiator) return "task";
  if (initiator.role === "custom") return "task";
  return firstRunOfSession ? "task" : "human";
};
