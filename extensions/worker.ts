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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerInbox } from "./inbox.js";
import { readRole } from "./roles.js";
import { runOrigin } from "./signalReminder.js";
import { taskEventsPath, taskIdFromEnvironment } from "./taskState.js";

type WorkerAction = "planned" | "done" | "flag";

const SIGNAL_TOOL_NAME = "worker_signal";
const MAX_NAGS_PER_RUN = 3;

// Injected as always-on system prompt (roles/worker.md) so the role governs
// turn 1 — not a skill, to avoid the progressive-disclosure read gate.
const WORKER_ROLE_PROMPT = readRole("worker");

/**
 * Did this run's messages include a call to the lifecycle-signal tool?
 * Deliberately blunt: no attempt to distinguish "real work happened"
 * from "trivial reply, signaling would be silly" — that's exactly the
 * kind of judgment call to leave to the model/prompt, not encode as a
 * heuristic here. If it turns out real usage needs an exception, add it
 * then, with a reason, not preemptively.
 */
export const calledWorkerSignal = (messages: AgentMessage[]): boolean => {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (c) => c.type === "toolCall" && c.name === SIGNAL_TOOL_NAME,
      ),
  );
};

export const workerEndedWithModelFailure = (
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
  action: WorkerAction,
  context: string,
): void {
  const path = taskEventsPath(taskId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ role: "worker", action, context, timestamp: Date.now() })}\n`,
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
    name: "worker_signal",
    label: "Worker Signal",
    description:
      "Emit a lifecycle signal: `planned` (pause for Foreman input), `done` (the requested result is ready; describe its artifact or outcome in context), or `flag` (blocked, needs input). Every substantive turn must end with one. A branch, commit, or PR is optional and depends on the task.",
    promptSnippet: "Emit a Worker lifecycle signal (planned/done/flag)",
    promptGuidelines: [
      "For done, identify the result in context: it may be prose, a path, report, spec, commit, PR, or another artifact. Prefer flag-and-be-safe over done-and-wrong.",
    ],
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("planned"),
        context: Type.String({
          description: "The plan and what input or redirection is needed",
        }),
      }),
      Type.Object({
        action: Type.Literal("done"),
        context: Type.String({
          description:
            "What result is ready, where it can be found, and how it was checked",
        }),
      }),
      Type.Object({
        action: Type.Literal("flag"),
        context: Type.String({ description: "What is blocking progress" }),
      }),
    ]),

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
  pi.registerTool(buildWorkerSignalTool(pi, taskId));
  registerInbox(pi, process.env.HERDR_PANE_ID);

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nYour foreman-lite task id is \`${taskId}\`.\n\n${WORKER_ROLE_PROMPT}`,
  }));

  // Turn-end enforcement: pi has no direct "stop hook" that can veto
  // ending the run, so this uses the standard pi pattern instead (same
  // one the bundled plan-mode extension uses) — inject a corrective
  // message with triggerTurn: true on agent_end, which starts another
  // run before the session is ever actually idle without a signal.
  // Bounded by MAX_NAGS_PER_RUN so a genuinely stuck model doesn't loop
  // forever; it settles (with a visible warning) instead of forcing.
  // NOTE: do NOT reset nagCount on agent_start — the nag's own followUp
  // triggers an agent_start, which would reset the count and make the bound
  // unreachable (verified: caused an infinite nag loop in dogfooding).
  // Reset only when a signal is actually called (new work cycle).
  let nagCount = 0;

  // Only a "startup" session has the launch prompt still ahead of it. /reload
  // and compaction re-run this file mid-session (reason "reload"); resume/fork
  // reopen prior history — in all of those the prompt run is already behind us,
  // so its enforcement must not re-arm and nag a later human question.
  let launchPromptRunPending = false;
  pi.on("session_start", (event) => {
    launchPromptRunPending = event.reason === "startup";
  });

  pi.on("agent_end", (event) => {
    const isLaunchPromptRun = launchPromptRunPending;
    launchPromptRunPending = false;

    if (
      calledWorkerSignal(event.messages) ||
      workerEndedWithModelFailure(event.messages)
    ) {
      // Provider/model errors and an explicit halt give the agent no chance to
      // signal. A corrective turn would retry a failed or intentionally aborted
      // operation instead of respecting the halt.
      nagCount = 0;
      return;
    }

    // A human typed into the pane and the agent answered. Nothing to enforce:
    // the role prompt already says to signal a real transition, and a reminder
    // here would only reach the attached human as noise.
    if (runOrigin(event.messages, isLaunchPromptRun) === "human") return;

    if (nagCount >= MAX_NAGS_PER_RUN) {
      pi.sendMessage(
        {
          customType: "worker-signal-warning",
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
        customType: "worker-signal-reminder",
        content: `You stopped without calling ${SIGNAL_TOOL_NAME}. Every turn must end with planned, done, or flag — call it now.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
}
