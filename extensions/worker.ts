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
 * Domain-level routing detail (the `context` argument) is appended under
 * `~/.foreman/tasks/<id>/`, outside the worktree, so it survives pane/session
 * lifecycle without dirtying the user's source tree. Durable review detail
 * lives in marked GitHub PR comments.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readRole } from "./roles.js";
import { taskIdFromCwd, taskEventsPath } from "./taskState.js";

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
function calledWorkerSignal(messages: AgentMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (c) => c.type === "toolCall" && c.name === SIGNAL_TOOL_NAME,
      ),
  );
}

function endedWithModelError(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant" && "stopReason" in message)
      return message.stopReason === "error";
  }
  return false;
}

function appendTaskEvent(
  worktreeRoot: string,
  action: WorkerAction,
  context: string,
  prUrl?: string,
): void {
  const path = taskEventsPath(taskIdFromCwd(worktreeRoot));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ role: "worker", action, context, prUrl, timestamp: Date.now() })}\n`,
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

function buildWorkerSignalTool(pi: ExtensionAPI) {
  return defineTool({
    name: "worker_signal",
    label: "Worker Signal",
    description:
      "Emit a lifecycle signal: `planned` (pause for Foreman plan input), `done` (committed work pushed and a PR opened; prUrl required), or `flag` (blocked, needs input). Every turn must end with one once work has progressed or stalled — don't emit planned as a routine progress ping because it terminates the turn.",
    promptSnippet: "Emit a Worker lifecycle signal (planned/done/flag)",
    promptGuidelines: [
      "Before done, commit and push the work, open the PR, and supply its URL. Prefer flag-and-be-safe over done-and-wrong.",
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
        context: Type.String({ description: "What changed and was tested" }),
        prUrl: Type.String({
          description: "URL of the pull request opened for this work",
        }),
      }),
      Type.Object({
        action: Type.Literal("flag"),
        context: Type.String({ description: "What is blocking progress" }),
      }),
    ]),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const worktreeRoot = ctx.cwd;
      const prUrl = params.action === "done" ? params.prUrl : undefined;
      appendTaskEvent(worktreeRoot, params.action, params.context, prUrl);

      pi.events.emit("herdr:blocked", {
        active: params.action === "flag",
        label: params.context,
      });

      return {
        content: [
          { type: "text", text: describeAction(params.action, params.context) },
        ],
        details: { action: params.action, context: params.context, prUrl },
        terminate: true,
      };
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(buildWorkerSignalTool(pi));
  const taskId = taskIdFromCwd(process.cwd());

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

  pi.on("agent_end", (event) => {
    if (
      calledWorkerSignal(event.messages) ||
      endedWithModelError(event.messages)
    ) {
      // A provider/model error gave the agent no chance to signal. Retrying the
      // model as a behavioral correction only repeats the failed paid request.
      nagCount = 0;
      return;
    }

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
