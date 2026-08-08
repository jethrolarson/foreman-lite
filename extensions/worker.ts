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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type WorkerAction = "planned" | "done" | "flag";

function taskEventsPath(worktreeRoot: string): string {
	return join(worktreeRoot, ".task", "events.jsonl");
}

function appendTaskEvent(worktreeRoot: string, action: WorkerAction, context: string): void {
	const path = taskEventsPath(worktreeRoot);
	mkdirSync(join(worktreeRoot, ".task"), { recursive: true });
	appendFileSync(path, `${JSON.stringify({ action, context, timestamp: Date.now() })}\n`);
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
				description: "What to review (plan/PR/diff description), or what's blocking progress",
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
	pi.registerTool(buildWorkerSignalTool(pi));
}
