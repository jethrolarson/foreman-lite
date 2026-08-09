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
 * Also provides `halt_worker`. An event/state watcher (Verifier spawn on
 * `done`) is still a follow-up — see docs/handoff.md.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
	// Which role this pane plays. Worker entries are written by create_task;
	// verifier entries are written by the task-events plugin when it spawns
	// a Verifier, so the plugin can route each pane's signals correctly.
	role: "worker" | "verifier";
	// The original task request, so a spawned Verifier can review against it.
	prompt: string;
	// Provider/model to spawn the Verifier with (Foreman's own, since the
	// task-events plugin process doesn't inherit pi's env). Forwarded from
	// PI_PROVIDER/PI_MODEL so Verifiers don't fall back to stale defaults.
	provider: string | undefined;
	model: string | undefined;
	// Foreman's own pane, read from HERDR_PANE_ID at create_task time. The
	// task-events plugin pushes notifications here. Undefined outside herdr.
	foremanPaneId: string | undefined;
	sessionPath: string | undefined;
	// Cross-links set once the other role spawns for this task:
	// worker entry -> its verifier pane; verifier entry -> its worker pane.
	verifierPaneId?: string;
	workerPaneId?: string;
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

function readTaskRecord(repoRoot: string, id: string): TaskRecord | undefined {
	return readJsonOptional<TaskRecord>(join(taskMetaDir(repoRoot, id), "meta.json"));
}

function workerExtensionPath(): string {
	// extensions/worker.ts, sibling of this file, regardless of cwd.
	return join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
}

// Read & parse a JSON file we own. Missing (ENOENT) = absent; anything else
// (corrupt, permission) surfaces rather than masquerading as empty.
function readJsonOptional<T>(path: string): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return JSON.parse(raw) as T;
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

// `worktree create`'s pane is occasionally not at a shell prompt yet
// (`agent_pane_busy`) — a real transient race. Retry beats a blind sleep.
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

// Forward Foreman's provider/model so Workers don't fall back to defaults
// that may diverge or point at a stale key (caused mid-task auth exits).
function workerAgentArgs(name: string, paneId: string, prompt: string): string[] {
	const piFlags: string[] = ["-e", workerExtensionPath()];
	if (process.env.PI_PROVIDER) piFlags.push("--provider", process.env.PI_PROVIDER);
	if (process.env.PI_MODEL) piFlags.push("--model", process.env.PI_MODEL);
	piFlags.push(prompt);
	return ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...piFlags];
}

async function startWorkerAgent(name: string, paneId: string, prompt: string): Promise<{ sessionPath: string | undefined }> {
	const result = await runHerdrRetryingPaneBusy(workerAgentArgs(name, paneId, prompt));
	const agent = (result as { agent: { agent_session?: { value?: string } } }).agent;
	return { sessionPath: agent?.agent_session?.value };
}

// `esc` interrupts the current turn; the pane/worktree stay for resuming.
// Target is the agent name, which create_task sets to the task id.
function haltWorkerAgent(id: string): void {
	runHerdr(["agent", "send-keys", id, "esc"]);
}

// Foreman's flag-to-human: a native OS notification so attention is caught
// even when the human isn't watching the terminal. Foreman is the only role
// that talks to the human directly (vision.md), so only it gets this.
function sendOsNotification(message: string): { ok: true } | { ok: false; reason: string } {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			execFileSync("osascript", ["-e", `display notification "${escaped}" with title "Foreman" sound name "Glass"`]);
			return { ok: true };
		}
		if (platform === "linux") {
			execFileSync("notify-send", ["Foreman", message]);
			return { ok: true };
		}
		return { ok: false, reason: `no notifier for platform ${platform}` };
	} catch (error) {
		return { ok: false, reason: String(error) };
	}
}

function writeTaskRecord(repoRoot: string, record: TaskRecord): void {
	const dir = taskMetaDir(repoRoot, record.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
}

// Cross-repo, keyed by pane id: the task-events plugin gets only a pane_id
// from pane.agent_status_changed, with no notion of repo.
function registryPath(): string {
	return join(homedir(), ".foreman", "registry.json");
}

function readRegistry(): Record<string, TaskRecord> {
	return readJsonOptional<Record<string, TaskRecord>>(registryPath()) ?? {};
}

function writeRegistryEntry(record: TaskRecord): void {
	const path = registryPath();
	mkdirSync(dirname(path), { recursive: true });
	const registry = readRegistry();
	registry[record.paneId] = record;
	writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
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

		const record: TaskRecord = {
			id,
			repoRoot,
			worktreePath,
			branch,
			paneId,
			role: "worker",
			prompt: params.prompt,
			provider: process.env.PI_PROVIDER,
			model: process.env.PI_MODEL,
			foremanPaneId: process.env.HERDR_PANE_ID,
			sessionPath,
			createdAt: Date.now(),
		};
		writeTaskRecord(repoRoot, record);
		writeRegistryEntry(record);

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

const haltWorkerTool = defineTool({
	name: "halt_worker",
	label: "Halt Worker",
	description:
		"Interrupt an in-progress Worker's current turn (sends Escape to its pane). The worktree and pane are left intact — this does not end the task, just stops what the Worker is doing right now.",
	promptSnippet: "Send Escape to a task's Worker to interrupt its current turn",
	parameters: Type.Object({
		id: Type.String({ description: "Task id, as returned by create_task" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const record = readTaskRecord(ctx.cwd, params.id);
		if (!record) {
			return {
				content: [{ type: "text", text: `No task found with id ${params.id} (looked in ${taskMetaDir(ctx.cwd, params.id)})` }],
				details: undefined,
				isError: true,
			};
		}

		try {
			haltWorkerAgent(record.id);
		} catch (error) {
			return {
				content: [{ type: "text", text: `Failed to halt Worker for task ${params.id}: ${String(error)}` }],
				details: undefined,
				isError: true,
			};
		}

		return {
			content: [{ type: "text", text: `Sent halt (Escape) to task ${params.id}'s Worker (pane ${record.paneId}).` }],
			details: record,
		};
	},
});

const flagTool = defineTool({
	name: "flag",
	label: "Flag to Human",
	description:
		"Send a native OS notification to the human when something demands their attention (a Worker/Verifier flag you couldn't resolve, or any decision only the human can make). Use sparingly — this interrupts them.",
	promptSnippet: "Send an OS notification to the human",
	parameters: Type.Object({
		context: Type.String({ description: "What demands the human's attention and what you need from them" }),
	}),

	async execute(_toolCallId, params) {
		const result = sendOsNotification(params.context);
		const delivered = result.ok;
		const reason = result.ok ? undefined : result.reason;
		return {
			content: [
				delivered
					? { type: "text", text: `Notified the human: ${params.context}` }
					: { type: "text", text: `OS notification not delivered (${reason}). Flag context: ${params.context}` },
			],
			details: { context: params.context, delivered, reason },
			isError: delivered ? undefined : true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(createTaskTool);
	pi.registerTool(haltWorkerTool);
	pi.registerTool(flagTool);
}
