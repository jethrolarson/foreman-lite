/**
 * Verifier extension: the lifecycle-signal tool for a Task Thread's Verifier.
 *
 * Loaded only for Verifier panes — the task-events plugin spawns these in
 * the Worker's own worktree (not a new one) so the Verifier sees the real
 * changes. Like worker.ts, every turn must end with a signal so a Verifier
 * can't go silently idle mid-review.
 *
 * Shares `.task/events.jsonl` with the Worker (Task State is shared between
 * worker and verifier per docs/vision.md); events are stamped `role:
 * "verifier"` so the task-events plugin can route them back to Foreman /
 * the Worker rather than re-triggering a Verifier spawn.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type VerifierAction = "approve" | "deny" | "flag";

const SIGNAL_TOOL_NAME = "verifier_signal";
const MAX_NAGS_PER_RUN = 3;

function calledVerifierSignal(messages: AgentMessage[]): boolean {
	return messages.some(
		(m) =>
			m.role === "assistant" &&
			m.content.some((c) => c.type === "toolCall" && c.name === SIGNAL_TOOL_NAME),
	);
}

function taskEventsPath(worktreeRoot: string): string {
	return join(worktreeRoot, ".task", "events.jsonl");
}

function appendTaskEvent(worktreeRoot: string, action: VerifierAction, context: string): void {
	const path = taskEventsPath(worktreeRoot);
	mkdirSync(join(worktreeRoot, ".task"), { recursive: true });
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
			"Emit a verdict: `approve` (work accepted), `deny` (send back to Worker with what to fix), or `flag` (raise a concern to Foreman — e.g. Worker seems malfunctioning or a large risk). Every turn must end with one of these once review is underway.",
		promptSnippet: "Emit a Verifier verdict (approve/deny/flag)",
		promptGuidelines: [
			"Only approve work you have actually checked (tests run, spec re-read, diff inspected) — a rubber-stamp approve is worse than a deny.",
		],
		parameters: Type.Object({
			action: StringEnum(["approve", "deny", "flag"] as const),
			context: Type.String({
				description: "For deny: what to fix. For flag: the concern. For approve: a short note (may be empty).",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const worktreeRoot = ctx.cwd;
			appendTaskEvent(worktreeRoot, params.action, params.context);

			pi.events.emit("herdr:blocked", { active: params.action === "flag", label: params.context });

			return {
				content: [{ type: "text", text: describeAction(params.action, params.context) }],
				details: { action: params.action, context: params.context },
				terminate: true,
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(buildVerifierSignalTool(pi));

	// Same turn-end enforcement as worker.ts: a Verifier that goes idle
	// without a verdict is a stuck review, so nag (bounded) rather than
	// settle silently.
	let nagCount = 0;

	pi.on("agent_start", () => {
		nagCount = 0;
	});

	pi.on("agent_end", (event) => {
		if (calledVerifierSignal(event.messages)) {
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
