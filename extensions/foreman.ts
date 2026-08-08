/**
 * Foreman extension: gives a pi session the capability to create Task
 * Threads (Worker agents running in their own git worktree + herdr pane).
 *
 * Load this only for the session you talk to as Foreman — e.g. via an
 * alias like:
 *
 *   alias piforeman='pi -e /path/to/foreman-lite/extensions/foreman.ts'
 *
 * Run from the target project's repo root. Worker panes are spawned by
 * this extension's own code with extensions/worker.ts (not foreman.ts)
 * passed via -e, so they never gain this capability just because you
 * happen to use the alias to start Foreman — see docs/vision.md and
 * CLAUDE.md for the reasoning.
 *
 * Built on herdr (https://herdr.dev) for pane/worktree management and
 * state tracking rather than raw tmux — see docs/handoff.md for what was
 * verified and why. Requires `herdr integration install pi` to have been
 * run once on this machine (installs the pi<->herdr state-reporting
 * extension globally; this file doesn't do that for you).
 *
 * First-pass scope: `create_task` only. `halt_worker` and an
 * event/state watcher are follow-ups — see docs/handoff.md.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface TaskRecord {
	id: string;
	repoRoot: string;
	worktreePath: string;
	branch: string;
	paneId: string;
	sessionPath: string | undefined;
	createdAt: number;
}

// --- pure helpers -----------------------------------------------------

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function taskId(name: string, suffix: string): string {
	const slug = slugify(name);
	return slug ? `${slug}-${suffix}` : suffix;
}

function branchFor(id: string): string {
	return `task/${id}`;
}

function taskMetaDir(repoRoot: string, id: string): string {
	return join(repoRoot, ".foreman", "tasks", id);
}

function workerExtensionPath(): string {
	// extensions/worker.ts, sibling of this file, regardless of cwd.
	return join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
}

// --- herdr, at the edge -------------------------------------------------

class HerdrError extends Error {
	code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

function runHerdr(args: string[]): Record<string, unknown> {
	let stdout: string;
	try {
		stdout = execFileSync("herdr", args, { encoding: "utf8" });
	} catch (error) {
		// herdr prints its JSON error body to stderr on nonzero exit (not stdout).
		const maybeStderr = (error as { stderr?: Buffer | string })?.stderr?.toString();
		const parsedError = maybeStderr ? tryParseHerdrError(maybeStderr) : undefined;
		if (parsedError) {
			throw new HerdrError(`herdr ${args.join(" ")} failed: ${parsedError.message}`, parsedError.code);
		}
		throw new HerdrError(`herdr ${args.join(" ")} failed: ${String(error)}`);
	}
	const parsed = JSON.parse(stdout);
	if (!parsed?.result) {
		throw new HerdrError(`herdr ${args.join(" ")} returned no result: ${stdout}`);
	}
	return parsed.result;
}

function tryParseHerdrError(stdout: string): { message: string; code: string } | undefined {
	try {
		const parsed = JSON.parse(stdout);
		return parsed?.error ? { message: parsed.error.message, code: parsed.error.code } : undefined;
	} catch {
		return undefined;
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A pane returned by `worktree create` is occasionally not yet at an
 * available shell prompt (`agent_pane_busy`) — verified as a real,
 * transient race, not hypothetical: reproduced with zero delay,
 * resolved with a 1s sleep. Retrying beats a blind sleep since it's
 * bounded by the actual condition rather than a guessed duration.
 */
async function runHerdrRetryingPaneBusy(args: string[], attempts = 5, delayMs = 500): Promise<Record<string, unknown>> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return runHerdr(args);
		} catch (error) {
			const isPaneBusy = error instanceof HerdrError && error.code === "agent_pane_busy";
			if (!isPaneBusy || attempt === attempts) {
				throw error;
			}
			await sleep(delayMs);
		}
	}
	// unreachable, satisfies the type checker
	throw new HerdrError("unreachable");
}

function createWorktree(repoRoot: string, branch: string, label: string): { paneId: string; worktreePath: string } {
	const result = runHerdr([
		"worktree",
		"create",
		"--cwd",
		repoRoot,
		"--branch",
		branch,
		"--label",
		label,
		"--no-focus",
	]);
	const rootPane = (result as { root_pane: { pane_id: string; cwd: string } }).root_pane;
	return { paneId: rootPane.pane_id, worktreePath: rootPane.cwd };
}

async function startWorkerAgent(name: string, paneId: string, prompt: string): Promise<{ sessionPath: string | undefined }> {
	const result = await runHerdrRetryingPaneBusy([
		"agent",
		"start",
		name,
		"--kind",
		"pi",
		"--pane",
		paneId,
		"--",
		"-e",
		workerExtensionPath(),
		prompt,
	]);
	const agent = (result as { agent: { agent_session?: { value?: string } } }).agent;
	return { sessionPath: agent?.agent_session?.value };
}

function writeTaskRecord(repoRoot: string, record: TaskRecord): void {
	const dir = taskMetaDir(repoRoot, record.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
}

// --- the tool -------------------------------------------------------------

const createTaskTool = defineTool({
	name: "create_task",
	label: "Create Task",
	description:
		"Start a new Task Thread: a git worktree plus a Worker agent running in it, in its own herdr pane. Use this to delegate work rather than doing it yourself.",
	promptSnippet: "Spawn a Worker in a fresh worktree/pane for a new task",
	parameters: Type.Object({
		name: Type.String({ description: "Short human-readable task name, used to derive the task id" }),
		prompt: Type.String({ description: "The task description/instructions to hand to the Worker" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const repoRoot = ctx.cwd;
		const id = taskId(params.name, Date.now().toString(36));
		const branch = branchFor(id);

		let paneId: string;
		let worktreePath: string;
		try {
			({ paneId, worktreePath } = createWorktree(repoRoot, branch, id));
		} catch (error) {
			return {
				content: [{ type: "text", text: `Failed to create worktree: ${String(error)}` }],
				details: undefined,
				isError: true,
			};
		}

		let sessionPath: string | undefined;
		try {
			({ sessionPath } = await startWorkerAgent(id, paneId, params.prompt));
		} catch (error) {
			return {
				content: [
					{ type: "text", text: `Worktree created (${worktreePath}) but failed to start Worker: ${String(error)}` },
				],
				details: undefined,
				isError: true,
			};
		}

		const record: TaskRecord = { id, repoRoot, worktreePath, branch, paneId, sessionPath, createdAt: Date.now() };
		writeTaskRecord(repoRoot, record);

		return {
			content: [
				{
					type: "text",
					text: `Created task ${id}. Worker running in pane ${paneId}, worktree ${worktreePath}. Attach with: herdr agent attach ${id}`,
				},
			],
			details: record,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(createTaskTool);
}
