// Unsignaled stops go to Foreman, not a nag loop. See docs/adrs/0006.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RunOrigin = "task" | "human";

// Matches the signal context cap.
export const STOP_CONTEXT_LIMIT = 700;

const isRunInitiator = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

// Inbox directives arrive as role "custom".
const isSystemInjected = (initiator: AgentMessage): boolean =>
  initiator.role === "custom";

const typedRunOrigin = (isLaunchPromptRun: boolean): RunOrigin =>
  isLaunchPromptRun ? "task" : "human";

// pi passes only this run's messages, so the caller tracks the launch-prompt run.
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

// Summaries lead, questions trail.
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

// Aborts skipped: whoever aborted already knows.
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

// Reports on agent_settled: agent_end precedes pi's auto-retries and queued runs.
// `report` must be sync to land before herdr's async idle report.
export const registerStopReporting = (
  pi: ExtensionAPI,
  signalToolName: string,
  report: (context: string) => void,
): void => {
  // Only "startup" precedes the launch prompt; reload/resume/fork follow it.
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
