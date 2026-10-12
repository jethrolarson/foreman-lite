// Unsignaled stops go to Foreman, not a nag loop. See docs/adrs/0006.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RunOrigin = "task" | "human";

export type UnsignaledStop = {
  origin: RunOrigin;
  stopReason: AssistantMessage["stopReason"];
  context: string;
};

// Task stops match the signal context cap; human asides are usually noise to Foreman.
const CONTEXT_LIMIT: Record<RunOrigin, number> = { task: 700, human: 200 };
// Human messages are short unless pasted.
const HUMAN_MESSAGE_LIMIT = 120;

const isRunInitiator = (message: AgentMessage): boolean =>
  message.role === "user" || message.role === "custom";

// Inbox directives arrive as role "custom".
const isSystemInjected = (initiator: AgentMessage): boolean =>
  initiator.role === "custom";

const typedRunOrigin = (isLaunchPromptRun: boolean): RunOrigin =>
  isLaunchPromptRun ? "task" : "human";

// Undefined for runs pi continues without a new message (retries, compaction).
// pi passes only this run's messages, so the caller tracks the launch-prompt run.
export const initiatorOrigin = (
  messages: AgentMessage[],
  isLaunchPromptRun: boolean,
): RunOrigin | undefined => {
  const initiator = messages.find(isRunInitiator);
  if (!initiator) return undefined;
  return isSystemInjected(initiator)
    ? "task"
    : typedRunOrigin(isLaunchPromptRun);
};

const isAssistant = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant";

const isUser = (message: AgentMessage): message is UserMessage =>
  message.role === "user";

const userText = ({ content }: UserMessage): string =>
  typeof content === "string"
    ? content.trim()
    : content
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("\n")
        .trim();

export const humanMessage = (messages: AgentMessage[]): string | undefined => {
  const typed = messages.find(isUser);
  return typed && userText(typed);
};

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
export const excerpt = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const marker = "\n…\n";
  const half = Math.floor((limit - marker.length) / 2);
  return `${text.slice(0, half)}${marker}${text.slice(-half)}`;
};

const stopText = (last: AssistantMessage): string =>
  last.stopReason === "error"
    ? `Provider error: ${last.errorMessage ?? "unknown"}`
    : replyText(last) || "(no text reply)";

const humanContext = (asked: string | undefined, reply: string): string =>
  `Human: ${excerpt(asked ?? "(unknown)", HUMAN_MESSAGE_LIMIT)}\nReply: ${excerpt(reply, CONTEXT_LIMIT.human)}`;

export type RunStart =
  { origin: "task" } | { origin: "human"; asked: string | undefined };

export const unsignaledStop = (
  messages: AgentMessage[],
  signalToolName: string,
  start: RunStart,
): UnsignaledStop | undefined => {
  if (calledSignal(messages, signalToolName)) return undefined;
  const last = messages.filter(isAssistant).at(-1);
  if (!last) return undefined;
  const text = stopText(last);
  return {
    origin: start.origin,
    stopReason: last.stopReason,
    context:
      start.origin === "human"
        ? humanContext(start.asked, text)
        : excerpt(text, CONTEXT_LIMIT.task),
  };
};

const runStart = (
  messages: AgentMessage[],
  isLaunchPromptRun: boolean,
): RunStart | undefined => {
  const origin = initiatorOrigin(messages, isLaunchPromptRun);
  if (!origin) return undefined;
  return origin === "human"
    ? { origin, asked: humanMessage(messages) }
    : { origin };
};

// Reports on agent_settled: agent_end precedes pi's auto-retries and queued runs.
// `report` must be sync to land before herdr's async idle report.
export const registerStopReporting = (
  pi: ExtensionAPI,
  signalToolName: string,
  report: (stop: UnsignaledStop) => void,
): void => {
  // Only "startup" precedes the launch prompt; reload/resume/fork follow it.
  let launchPromptRunPending = false;
  let cycleStart: RunStart | undefined;
  let pendingStop: UnsignaledStop | undefined;

  pi.on("session_start", (event) => {
    launchPromptRunPending = event.reason === "startup";
  });

  pi.on("agent_end", (event) => {
    cycleStart = runStart(event.messages, launchPromptRunPending) ??
      cycleStart ?? { origin: "task" };
    launchPromptRunPending = false;
    pendingStop = unsignaledStop(event.messages, signalToolName, cycleStart);
  });

  pi.on("agent_settled", () => {
    if (pendingStop) report(pendingStop);
    pendingStop = undefined;
    cycleStart = undefined;
  });
};
