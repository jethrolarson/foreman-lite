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
 * Domain-level detail (the `context` argument) is durable task state: it's
 * appended to a file inside the worktree, not just relayed through herdr,
 * so it survives independent of any pane/session lifecycle.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readRole } from "./roles.js";

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

function taskEventsPath(worktreeRoot: string): string {
  return join(worktreeRoot, ".task", "events.jsonl");
}

function appendTaskEvent(
  worktreeRoot: string,
  action: WorkerAction,
  context: string,
): void {
  const path = taskEventsPath(worktreeRoot);
  mkdirSync(join(worktreeRoot, ".task"), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ role: "worker", action, context, timestamp: Date.now() })}\n`,
  );
}

function describeAction(action: WorkerAction, context: string): string {
  switch (action) {
    case "planned":
      return `Plan ready for review: ${context}`;
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
      "Emit a lifecycle signal: `planned` (plan ready for review), `done` (work ready for review), or `flag` (blocked, needs human/foreman input). Every turn must end with one of these once work has actually progressed or stalled — don't emit one for ordinary conversation.",
    promptSnippet: "Emit a Worker lifecycle signal (planned/done/flag)",
    promptGuidelines: [
      "Prefer flag-and-be-safe over done-and-wrong: an incorrect /flag costs a question, an incorrect /done costs a wrong result reaching review.",
    ],
    parameters: Type.Object({
      action: StringEnum(["planned", "done", "flag"] as const),
      context: Type.String({
        description:
          "What to review (plan/PR/diff description), or what's blocking progress",
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
  pi.registerTool(buildWorkerSignalTool(pi));

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${WORKER_ROLE_PROMPT}`,
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
    if (calledWorkerSignal(event.messages)) {
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
