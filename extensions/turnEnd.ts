// Turn-end reporting: when a run Foreman started ends without a lifecycle
// signal, the role's final reply is recorded as a `stopped` task event so
// Foreman, not a local nag loop, decides what the stop means. See
// docs/adrs/0006-foreman-interprets-unsignaled-stops.md.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RunOrigin = "task" | "human";

// Same budget as signal context, so a stop costs Foreman no more working
// memory than a signal does.
export const STOP_CONTEXT_LIMIT = 700;

const isRunInitiator = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

// Run-starting messages foreman-lite injects (inbox directives) carry role
// "custom"; a "user" initiator was typed.
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

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant";

export const calledSignal = (
  messages: AgentMessage[],
  signalToolName: string,
): boolean =>
  messages
    .filter(isAssistant)
    .some((m) =>
      m.content.some((c) => c.type === "toolCall" && c.name === signalToolName),
    );

const replyText = (message: AssistantMessage): string =>
  message.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();

// Keeps both ends: a reply's summary tends to lead and its question to trail.
export const excerpt = (text: string, limit = STOP_CONTEXT_LIMIT): string => {
  if (text.length <= limit) return text;
  const marker = "\n…\n";
  const half = Math.floor((limit - marker.length) / 2);
  return `${text.slice(0, half)}${marker}${text.slice(-half)}`;
};

const stopContext = (last: AssistantMessage): string =>
  last.stopReason === "error"
    ? `Provider error: ${last.errorMessage ?? "unknown"}`
    : excerpt(replyText(last)) || "(no text reply)";

/**
 * Context for a `stopped` event, or undefined when the stop needs no report:
 * the run signaled, a human started it, or it was aborted (Foreman's
 * halt_worker or a human's Esc; whoever aborted already knows).
 */
export const unsignaledStopContext = (
  messages: AgentMessage[],
  signalToolName: string,
  isLaunchPromptRun: boolean,
): string | undefined => {
  if (calledSignal(messages, signalToolName)) return undefined;
  if (runOrigin(messages, isLaunchPromptRun) === "human") return undefined;
  const last = messages.filter(isAssistant).at(-1);
  if (!last || last.stopReason === "aborted") return undefined;
  return stopContext(last);
};

/**
 * Reports each unsignaled stop once the session has settled. agent_end alone
 * is too early: pi may still auto-retry a provider error or run a queued
 * follow-up, and those runs end with their own agent_end.
 *
 * `report` must be synchronous. herdr's integration publishes idle from its
 * own agent_settled handler over a socket, so a synchronous write here lands
 * before the task-events plugin can react to that idle.
 */
export const registerStopReporting = (
  pi: ExtensionAPI,
  signalToolName: string,
  report: (context: string) => void,
): void => {
  // Only a "startup" session has the launch prompt still ahead of it. /reload
  // and compaction re-run the extension mid-session (reason "reload");
  // resume/fork reopen prior history. In all of those the prompt run is
  // already behind us, so a later human question is not a task stop.
  let launchPromptRunPending = false;
  let pendingStop: string | undefined;

  pi.on("session_start", (event) => {
    launchPromptRunPending = event.reason === "startup";
  });

  pi.on("agent_end", (event) => {
    pendingStop = unsignaledStopContext(
      event.messages,
      signalToolName,
      launchPromptRunPending,
    );
    launchPromptRunPending = false;
  });

  pi.on("agent_settled", () => {
    if (pendingStop !== undefined) report(pendingStop);
    pendingStop = undefined;
  });
};
