// Why the turn-end nag is origin-aware: an attached human asking a question is
// a signal-less turn too, and a forced signal there reaches Foreman as real
// task state through the task-events plugin.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type RunOrigin = "task" | "human";

const isRunInitiator = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

// Run-starting messages foreman-lite injects (inbox directives, the turn-end
// reminder) carry role "custom"; a "user" initiator was typed.
const isSystemInjected = (initiator: AgentMessage): boolean =>
  initiator.role === "custom";

const typedRunOrigin = (isSessionsFirstRun: boolean): RunOrigin =>
  isSessionsFirstRun ? "task" : "human";

// `messages` is one run's messages, not session history (pi returns
// `newMessages` from the loop), so the caller tracks which run is the first.
export const runOrigin = (
  messages: AgentMessage[],
  isSessionsFirstRun: boolean,
): RunOrigin => {
  const initiator = messages.find(isRunInitiator);
  if (!initiator) return "task";
  return isSystemInjected(initiator)
    ? "task"
    : typedRunOrigin(isSessionsFirstRun);
};
