// Worker/Verifier enforce "end a task turn with a signal" by nagging on
// `agent_end`. `runOrigin` keeps the nag off turns where an attached human just
// asked a question: forcing a signal there emits a spurious lifecycle event
// that the task-events plugin routes to Foreman as real state.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type RunOrigin = "task" | "human";

const startsARun = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

// `custom` initiator ⇒ a Foreman inbox directive or a prior forcing reminder:
// task work either way. A bare `user` initiator is the task prompt only on the
// session's first run (`agent_end.messages` is this run alone, so a later human
// question is otherwise indistinguishable from the prompt).
export const runOrigin = (
  messages: AgentMessage[],
  firstRunOfSession: boolean,
): RunOrigin => {
  const initiator = messages.find(startsARun);
  if (!initiator) return "task";
  if (initiator.role === "custom") return "task";
  return firstRunOfSession ? "task" : "human";
};
