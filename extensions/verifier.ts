/**
 * Verifier extension: the lifecycle-signal tool for a Task Thread's Verifier.
 *
 * Loaded only for Verifier panes. Foreman starts one in the Task Thread's
 * directory and identifies the artifact or claim to verify. Like worker.ts,
 * a Foreman-started run that ends without a verdict is reported to Foreman
 * as a `stopped` event, so a Verifier cannot go silently idle.
 *
 * Shares `~/.foreman/tasks/<id>/events.jsonl` with the Worker; events are
 * stamped `role: "verifier"` so the task-events plugin can route them back
 * to Foreman; Foreman decides whether any next action is appropriate.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerInbox } from "./inbox.js";
import { readRole } from "./roles.js";
import { registerStopReporting } from "./turnEnd.js";
import { taskEventsPath, taskIdFromEnvironment } from "./taskState.js";

type VerifierAction = "approve" | "deny" | "flag";

const SIGNAL_TOOL_NAME = "verifier_signal";

// Injected as always-on system prompt (roles/verifier.md) so the role governs
// turn 1 — not a skill, to avoid the progressive-disclosure read gate.
const VERIFIER_ROLE_PROMPT = readRole("verifier");

function appendTaskEvent(
  taskId: string,
  action: VerifierAction | "stopped",
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
          "What was checked, the verdict, and where any detailed findings live (max 700 characters). Write findings themselves to the artifact's natural surface, not here; the call fails over the limit.",
        maxLength: 700,
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

  registerStopReporting(pi, SIGNAL_TOOL_NAME, (context) =>
    appendTaskEvent(taskId, "stopped", context),
  );
}
