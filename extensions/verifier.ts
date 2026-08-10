/**
 * Verifier extension: the lifecycle-signal tool for a Task Thread's Verifier.
 *
 * Loaded only for Verifier panes — the task-events plugin spawns these in
 * the Worker's own worktree (not a new one) so the Verifier sees the real
 * changes. Like worker.ts, every turn must end with a signal so a Verifier
 * can't go silently idle mid-review.
 *
 * Shares `~/.foreman/tasks/<id>/events.jsonl` with the Worker; events are
 * stamped `role: "verifier"` so the task-events plugin can route them back
 * to Foreman / the Worker rather than re-triggering a Verifier spawn.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readRole } from "./roles.js";
import { taskIdFromCwd, taskEventsPath } from "./taskState.js";

type VerifierAction = "approve" | "deny" | "flag";

const SIGNAL_TOOL_NAME = "verifier_signal";
const MAX_NAGS_PER_RUN = 3;

// Injected as always-on system prompt (roles/verifier.md) so the role governs
// turn 1 — not a skill, to avoid the progressive-disclosure read gate.
const VERIFIER_ROLE_PROMPT = readRole("verifier");

function calledVerifierSignal(messages: AgentMessage[]): boolean {
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
  action: VerifierAction,
  context: string,
): void {
  const path = taskEventsPath(taskIdFromCwd(worktreeRoot));
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
      return `Denied, sent back to Worker: ${context}`;
    case "flag":
      return `Concern raised to Foreman: ${context}`;
  }
}

function buildVerifierSignalTool(pi: ExtensionAPI) {
  return defineTool({
    name: SIGNAL_TOOL_NAME,
    label: "Verifier Signal",
    description:
      "Emit a verdict after posting a marked GitHub PR review comment: `approve` (work accepted), `deny` (detailed feedback posted for Worker), or `flag` (raise a concern to Foreman). Keep context to a short summary; the durable review lives on the PR.",
    promptSnippet: "Emit a Verifier verdict (approve/deny/flag)",
    promptGuidelines: [
      "Only approve work you actually checked. Before signaling, post the detailed review on the PR with the foreman-lite Verifier marker.",
    ],
    parameters: Type.Object({
      action: StringEnum(["approve", "deny", "flag"] as const),
      context: Type.String({
        description:
          "Short verdict summary. Detailed review belongs in the marked GitHub PR comment.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const worktreeRoot = ctx.cwd;
      appendTaskEvent(worktreeRoot, params.action, params.context);

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
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(buildVerifierSignalTool(pi));
  const taskId = taskIdFromCwd(process.cwd());

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
      endedWithModelError(event.messages)
    ) {
      // Provider/model errors aren't behavioral omissions; corrective turns
      // only repeat a request that cannot currently succeed.
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
