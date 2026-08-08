/**
 * Foreman extension: gives a pi session the capability to create Task
 * Threads (Worker agents running in their own git worktree + tmux window).
 *
 * Load this only for the session you talk to as Foreman — e.g. via an
 * alias like:
 *
 *   alias piforeman='pi -e /path/to/foreman-lite/extensions/foreman.ts'
 *
 * Run from the target project's repo root. Worker/Verifier panes are
 * spawned by this extension's own code (plain `pi`, no -e), so they never
 * gain this capability just because you happen to use the alias to start
 * Foreman — see docs/vision.md and CLAUDE.md for the reasoning.
 *
 * First-pass scope: `create_task` only. No lifecycle-command tool, no
 * halt_worker, no event watcher yet — those are follow-ups.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface TaskRecord {
	id: string;
	repoRoot: string;
	worktreePath: string;
	branch: string;
	tmuxSession: string;
	tmuxWindow: string;
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

function worktreePathFor(repoRoot: string, id: string): string {
	return join(repoRoot, "..", `${basename(repoRoot)}-task-${id}`);
}

function branchFor(id: string): string {
	return `task/${id}`;
}

function tmuxSessionFor(repoRoot: string): string {
	return `foreman-${basename(repoRoot)}`;
}

function tmuxWindowFor(id: string): string {
	return `task-${id}`;
}

function taskMetaDir(repoRoot: string, id: string): string {
	return join(repoRoot, ".foreman", "tasks", id);
}

function workerShellCommand(worktreePath: string, promptFile: string): string {
	// cd + pi, no -e: Worker panes never load the Foreman extension.
	return `cd ${shellQuote(worktreePath)} && pi ${shellQuote(`@${promptFile}`)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// --- IO at the edges ----------------------------------------------------

function runGit(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function tmuxSessionExists(session: string): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", session], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function ensureTmuxSession(session: string, window: string, cwd: string, shellCommand: string): void {
	if (tmuxSessionExists(session)) {
		execFileSync("tmux", ["new-window", "-t", session, "-n", window, "-c", cwd, shellCommand], { stdio: "pipe" });
		return;
	}
	execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", window, "-c", cwd, shellCommand], {
		stdio: "pipe",
	});
}

function writeTaskRecord(repoRoot: string, record: TaskRecord): void {
	const dir = taskMetaDir(repoRoot, record.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function writePromptFile(repoRoot: string, id: string, prompt: string): string {
	const dir = taskMetaDir(repoRoot, id);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "prompt.md");
	writeFileSync(path, prompt);
	return path;
}

// --- the tool -------------------------------------------------------------

const createTaskTool = defineTool({
	name: "create_task",
	label: "Create Task",
	description:
		"Start a new Task Thread: a git worktree plus a Worker agent running in it, in its own tmux window. Use this to delegate work rather than doing it yourself.",
	promptSnippet: "Spawn a Worker in a fresh worktree/tmux window for a new task",
	parameters: Type.Object({
		name: Type.String({ description: "Short human-readable task name, used to derive the task id" }),
		prompt: Type.String({ description: "The task description/instructions to hand to the Worker" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const repoRoot = ctx.cwd;
		const id = taskId(params.name, Date.now().toString(36));
		const worktreePath = worktreePathFor(repoRoot, id);
		const branch = branchFor(id);
		const tmuxSession = tmuxSessionFor(repoRoot);
		const tmuxWindow = tmuxWindowFor(id);

		try {
			runGit(["worktree", "add", "-b", branch, worktreePath], repoRoot);
		} catch (error) {
			return {
				content: [{ type: "text", text: `Failed to create worktree: ${String(error)}` }],
				isError: true,
			};
		}

		const promptFile = writePromptFile(repoRoot, id, params.prompt);

		try {
			ensureTmuxSession(tmuxSession, tmuxWindow, worktreePath, workerShellCommand(worktreePath, promptFile));
		} catch (error) {
			return {
				content: [{ type: "text", text: `Worktree created but failed to spawn tmux window: ${String(error)}` }],
				isError: true,
			};
		}

		const record: TaskRecord = {
			id,
			repoRoot,
			worktreePath,
			branch,
			tmuxSession,
			tmuxWindow,
			createdAt: Date.now(),
		};
		writeTaskRecord(repoRoot, record);

		return {
			content: [
				{
					type: "text",
					text: `Created task ${id}. Worker running in tmux window ${tmuxSession}:${tmuxWindow}, worktree ${worktreePath}. Attach with: tmux attach -t ${tmuxSession}`,
				},
			],
			details: record,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(createTaskTool);
}
