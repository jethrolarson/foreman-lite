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

const typedRunOrigin = (isLaunchPromptRun: boolean): RunOrigin =>
  isLaunchPromptRun ? "task" : "human";

// `messages` is one run's messages, not session history (pi returns
// `newMessages` from the loop), so the caller tracks whether this run is the
// one that consumed the `@promptFile` launch argument.
export const runOrigin = (
  messages: AgentMessage[],
  isLaunchPromptRun: boolean,
): RunOrigin => {
  const initiator = messages.find(isRunInitiator);
  if (!initiator) return "task";
  return isSystemInjected(initiator)
    ? "task"
    : typedRunOrigin(isLaunchPromptRun);
};
