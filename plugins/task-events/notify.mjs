// herdr event hook: fires on every pane.agent_status_changed, for every
// pane herdr knows about, not just ours. Filters down to panes we're
// tracking (extensions/foreman.ts's registry) and pushes the task's last
// domain-level signal into the owning Foreman pane. See docs/handoff.md
// for why this exists instead of Foreman polling.
//
// Deliberately a no-op (exit 0, no error) for anything not ours: herdr
// runs this for every agent on the machine, not just foreman-lite's.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REACTABLE_STATUSES = new Set(["idle", "blocked", "done"]);

function readJsonEnv(name) {
	const raw = process.env[name];
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function readRegistry() {
	try {
		const raw = readFileSync(join(homedir(), ".foreman", "registry.json"), "utf8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function lastTaskEvent(worktreePath) {
	try {
		const raw = readFileSync(join(worktreePath, ".task", "events.jsonl"), "utf8");
		const lines = raw.trim().split("\n").filter(Boolean);
		const last = lines.at(-1);
		return last ? JSON.parse(last) : undefined;
	} catch {
		return undefined;
	}
}

// Cheap dedupe against re-pushing the same underlying signal if
// agent_status flickers more than once for one logical change (e.g. the
// worker.ts nag loop causing idle/working flips before it actually
// signals) - a named, concrete risk from earlier design discussion, not
// speculative. Keyed by task id, not pane id, since a task's pane id is
// stable but this is cheap insurance either way.
function alreadyPushed(taskId, eventTimestamp) {
	const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
	if (!stateDir) return false;
	try {
		const seen = JSON.parse(readFileSync(join(stateDir, "seen.json"), "utf8"));
		return seen[taskId] === eventTimestamp;
	} catch {
		return false;
	}
}

function markPushed(taskId, eventTimestamp) {
	const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
	if (!stateDir) return;
	let seen = {};
	try {
		seen = JSON.parse(readFileSync(join(stateDir, "seen.json"), "utf8"));
	} catch {
		// no prior state, start fresh
	}
	seen[taskId] = eventTimestamp;
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "seen.json"), JSON.stringify(seen));
}

function pushToForeman(foremanPaneId, text) {
	const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
	const result = spawnSync(herdrBin, ["agent", "prompt", foremanPaneId, text], { encoding: "utf8" });
	if (result.status !== 0) {
		console.error(`herdr agent prompt failed: ${result.stderr?.trim() ?? result.error?.message}`);
	}
}

function describeSignal(event) {
	if (!event) return "went idle with no recorded signal (worker.ts enforcement should prevent this)";
	switch (event.action) {
		case "planned":
			return `plan ready for review: ${event.context}`;
		case "done":
			return `work ready for review: ${event.context}`;
		case "flag":
			return `blocked, needs input: ${event.context}`;
		default:
			return `unrecognized signal: ${JSON.stringify(event)}`;
	}
}

const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const data = event?.data;
const status = data?.agent_status;
const paneId = data?.pane_id;

if (!status || !paneId || !REACTABLE_STATUSES.has(status)) {
	process.exit(0);
}

// Observed live, repeatedly (3 of 6 test runs): the registry write from
// create_task's own process is confirmed on disk by the time create_task
// returns, yet this event hook's very next read of the same file
// sometimes still misses the entry that was just written moments
// earlier - root cause not confirmed, but the transience is real and
// reproduced, so bounded retry (same treatment as agent_pane_busy in
// foreman.ts) beats either ignoring it or chasing the exact cause further.
async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findTaskWithRetry(paneId, attempts = 5, delayMs = 200) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const task = readRegistry()[paneId];
		if (task) return task;
		if (attempt < attempts) await sleep(delayMs);
	}
	return undefined;
}

const task = await findTaskWithRetry(paneId);
if (!task) {
	// Not one of our tracked panes - some other agent on the machine.
	process.exit(0);
}

const lastEvent = lastTaskEvent(task.worktreePath);
const eventTimestamp = lastEvent?.timestamp ?? status; // fall back to status string if no domain event yet

if (alreadyPushed(task.id, eventTimestamp)) {
	process.exit(0);
}

if (!task.foremanPaneId) {
	// Task was created outside herdr (no HERDR_PANE_ID at create_task time).
	// Nothing to push to.
	process.exit(0);
}

const message = `Task ${task.id} (${status}): ${describeSignal(lastEvent)}`;
pushToForeman(task.foremanPaneId, message);
markPushed(task.id, eventTimestamp);
