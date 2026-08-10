/**
 * Verifier extension: the lifecycle-signal tool for a Task Thread's Verifier.
 *
 * Loaded only for Verifier panes. Foreman starts one in the Task Thread's
 * directory and identifies the artifact or claim to verify. Like worker.ts,
 * every turn must end with a signal so a Verifier cannot go silently idle.
 *
 * Shares `~/.foreman/tasks/<id>/events.jsonl` with the Worker; events are
 * stamped `role: "verifier"` so the task-events plugin can route them back
 * to Foreman; Foreman decides whether any next action is appropriate.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerInbox } from "./inbox.js";
import { readRole } from "./roles.js";
import { taskEventsPath, taskIdFromEnvironment } from "./taskState.js";

type VerifierAction = "approve" | "deny" | "flag";

const SIGNAL_TOOL_NAME = "verifier_signal";
const MAX_NAGS_PER_RUN = 3;

// Injected as always-on system prompt (roles/verifier.md) so the role governs
// turn 1 — not a skill, to avoid the progressive-disclosure read gate.
const VERIFIER_ROLE_PROMPT = readRole("verifier");

export const calledVerifierSignal = (messages: AgentMessage[]): boolean => {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (c) => c.type === "toolCall" && c.name === SIGNAL_TOOL_NAME,
      ),
  );
};

export const verifierEndedWithModelFailure = (
  messages: AgentMessage[],
): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant" && "stopReason" in message)
      return message.stopReason === "error" || message.stopReason === "aborted";
  }
  return false;
};

function appendTaskEvent(
  taskId: string,
  action: VerifierAction,
  context: string,
): void {
  const path = taskEventsPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ role: "verifier", action, context, timestamp: Date.now() })}\n`,
  );
}

function describeAction(action: VerifierAction, context: string): string {
  switch (action) {
    case "approve":
      return `Approved: ${context}`;
    case "deny":
      return `Denied, reported to Foreman: ${context}`;
    case "flag":
      return `Concern raised to Foreman: ${context}`;
  }
}

export const buildVerifierSignalTool = (pi: ExtensionAPI, taskId: string) => {
  return defineTool({
    name: SIGNAL_TOOL_NAME,
    label: "Verifier Signal",
    description:
      "Emit a verification verdict: `approve` (the identified claim or artifact checks out), `deny` (specific problems found), or `flag` (verification is blocked or raises a broader concern). Put enough context in the signal for Foreman to judge the next step.",
    promptSnippet: "Emit a Verifier verdict (approve/deny/flag)",
    promptGuidelines: [
      "Only approve what you actually checked. Record detailed findings on the artifact's natural durable surface when one exists; otherwise include them in context.",
    ],
    parameters: Type.Object({
      action: StringEnum(["approve", "deny", "flag"] as const),
      context: Type.String({
        description:
          "What was checked, the verdict, and where any detailed findings live",
      }),
    }),

    async execute(_toolCallId, params) {
      appendTaskEvent(taskId, params.action, params.context);

      pi.events.emit("herdr:blocked", {
        active: params.action === "flag",
        label: params.context,
      });

      return {
        content: [
          { type: "text", text: describeAction(params.action, params.context) },
        ],
        details: { action: params.action, context: params.context },
        terminate: true,
      };
    },
  });
};

export default function (pi: ExtensionAPI) {
  const taskId = taskIdFromEnvironment();
  pi.registerTool(buildVerifierSignalTool(pi, taskId));
  registerInbox(pi, process.env.HERDR_PANE_ID);

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nYour foreman-lite task id is \`${taskId}\`.\n\n${VERIFIER_ROLE_PROMPT}`,
  }));

  // Same turn-end enforcement as worker.ts: a Verifier that goes idle
  // without a verdict is a stuck review, so nag (bounded) rather than
  // settle silently. Don't reset nagCount on agent_start — the nag's own
  // followUp triggers one, which would defeat the bound.
  let nagCount = 0;

  pi.on("agent_end", (event) => {
    if (
      calledVerifierSignal(event.messages) ||
      verifierEndedWithModelFailure(event.messages)
    ) {
      // Provider/model errors and explicit halts aren't behavioral omissions;
      // corrective turns only repeat a failed or intentionally aborted request.
      nagCount = 0;
      return;
    }

    if (nagCount >= MAX_NAGS_PER_RUN) {
      pi.sendMessage(
        {
          customType: "verifier-signal-warning",
          content: `Stopped without calling ${SIGNAL_TOOL_NAME} after ${MAX_NAGS_PER_RUN} reminders. Not forcing further — this needs a human look.`,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }

    nagCount += 1;
    pi.sendMessage(
      {
        customType: "verifier-signal-reminder",
        content: `You stopped without calling ${SIGNAL_TOOL_NAME}. Every turn must end with approve, deny, or flag — call it now.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
}
