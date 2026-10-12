/**
 * Worker extension: the lifecycle-signal tool for a Task Thread's Worker.
 *
 * Loaded only for Worker panes (Foreman's create_task passes this file's
 * path via -e when it spawns the pane) — Workers never load foreman.ts,
 * so they never get create_task/halt_worker themselves.
 *
 * `flag` reports blocked state to herdr (if the herdr pi integration is
 * installed) via the same `herdr:blocked` event its own extension listens
 * for — see `herdr integration install pi`. `planned`/`done` clear it.
 * Domain-level routing detail is appended under `~/.foreman/tasks/<id>/`,
 * outside the task directory, so shared-directory and isolated tasks use the
 * same durable protocol without dirtying source trees.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerInbox } from "./inbox.js";
import { readRole } from "./roles.js";
import { registerStopReporting, type UnsignaledStop } from "./turnEnd.js";
import { taskEventsPath, taskIdFromEnvironment } from "./taskState.js";

type WorkerAction = "planned" | "done" | "flag";

const SIGNAL_TOOL_NAME = "worker_signal";

// Injected as always-on system prompt (roles/worker.md) so the role governs
// turn 1 — not a skill, to avoid the progressive-disclosure read gate.
const WORKER_ROLE_PROMPT = readRole("worker");

type TaskEvent =
  | { action: WorkerAction; context: string }
  | ({ action: "stopped" } & UnsignaledStop);

function appendTaskEvent(taskId: string, event: TaskEvent): void {
  const path = taskEventsPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ role: "worker", ...event, timestamp: Date.now() })}\n`,
  );
}

function describeAction(action: WorkerAction, context: string): string {
  switch (action) {
    case "planned":
      return `Plan checkpoint requested: ${context}`;
    case "done":
      return `Work ready for review: ${context}`;
    case "flag":
      return `Blocked, needs input: ${context}`;
  }
}

export const buildWorkerSignalTool = (pi: ExtensionAPI, taskId: string) => {
  return defineTool({
    name: SIGNAL_TOOL_NAME,
    label: "Worker Signal",
    description:
      "Emit a lifecycle signal: `planned` (pause for Foreman input), `done` (the requested result is ready; describe its artifact or outcome in context), or `flag` (blocked, needs input). Prefer ending work Foreman started with one; a plain reply to a human typing in the pane needs none. A branch, commit, or PR is optional and depends on the task.",
    promptSnippet: "Emit a Worker lifecycle signal (planned/done/flag)",
    promptGuidelines: [
      "For done, keep context to a short summary and where the result lives (path, commit, PR); put detail on the result's natural durable surface instead. REASON: Foreman's working memory is for cross-thread judgment, not implementation detail (roles/foreman.md) — absorbing a full report here defeats that. Prefer flag-and-be-safe over done-and-wrong.",
    ],
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("planned"),
        context: Type.String({
          description: "The plan and what input or redirection is needed",
          maxLength: 700,
        }),
      }),
      Type.Object({
        action: Type.Literal("done"),
        context: Type.String({
          description:
            "Short summary of the result, how it was checked, and where it can be found. Kept under 700 characters as a backstop — write longer detail to a file and reference its path here instead; calls over the limit are rejected.",
          maxLength: 700,
        }),
      }),
      Type.Object({
        action: Type.Literal("flag"),
        context: Type.String({
          description: "What is blocking progress",
          maxLength: 700,
        }),
      }),
    ]),

    async execute(_toolCallId, params) {
      appendTaskEvent(taskId, {
        action: params.action,
        context: params.context,
      });

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
  pi.registerTool(buildWorkerSignalTool(pi, taskId));
  registerInbox(pi, process.env.HERDR_PANE_ID);

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nYour foreman-lite task id is \`${taskId}\`.\n\n${WORKER_ROLE_PROMPT}`,
  }));

  registerStopReporting(pi, SIGNAL_TOOL_NAME, (stop) =>
    appendTaskEvent(taskId, { action: "stopped", ...stop }),
  );
}
