// herdr event hook: fires on every pane.agent_status_changed, for every
// pane herdr knows about, not just ours. Routes Task Thread lifecycle
// signals to the right place based on the pane's role:
//
//   Worker  planned/done -> notify Foreman + ensure a Verifier exists
//                           (spawn on first review, else re-prompt it)
//   Worker  flag         -> notify Foreman only
//   Verifier approve     -> notify Foreman (task complete pending merge)
//   Verifier deny        -> notify Foreman + prompt Worker to fix
//   Verifier flag        -> notify Foreman
//
// See docs/vision.md (roles) and docs/handoff.md (why push, not poll).
// Deliberately a no-op (exit 0) for anything not ours: herdr runs this
// for every agent on the machine, not just foreman-lite's.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REACTABLE_STATUSES = new Set(["idle", "blocked", "done"]);
const VERIFIER_ACTIONS = new Set(["planned", "done"]);

function readJsonEnv(name) {
	const raw = process.env[name];
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function registryPath() {
	return join(homedir(), ".foreman", "registry.json");
}

function readRegistry() {
	try {
		return JSON.parse(readFileSync(registryPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeRegistry(registry) {
	const path = registryPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

function upsertEntry(record) {
	const registry = readRegistry();
	registry[record.paneId] = record;
	writeRegistry(registry);
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

// Dedupe against re-pushing the same underlying signal if agent_status
// flickers more than once for one logical change (e.g. the worker.ts nag
// loop causing idle/working flips before it actually signals). Keyed by
// task + role + event timestamp, so a genuinely new signal still fires.
function dedupeKey(task, event) {
	const ts = event?.timestamp ?? "none";
	return `${task.id}:${event?.role ?? "unknown"}:${ts}`;
}

function alreadyPushed(key) {
	const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
	if (!stateDir) return false;
	try {
		const seen = JSON.parse(readFileSync(join(stateDir, "seen.json"), "utf8"));
		return seen[key] === true;
	} catch {
		return false;
	}
}

function markPushed(key) {
	const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
	if (!stateDir) return;
	let seen = {};
	try {
		seen = JSON.parse(readFileSync(join(stateDir, "seen.json"), "utf8"));
	} catch {
		// no prior state, start fresh
	}
	seen[key] = true;
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "seen.json"), JSON.stringify(seen));
}

const HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// herdr agent start right after workspace create intermittently hits
// agent_pane_busy (pane not at a shell prompt yet) - same real race as
// foreman.ts's create_task. Bounded retry on that specific code.
async function runHerdr(args, { retryPaneBusy = false } = {}) {
	for (let attempt = 1; attempt <= 5; attempt++) {
		const result = spawnSync(HERDR_BIN, args, { encoding: "utf8" });
		if (result.status === 0) {
			try {
				return JSON.parse(result.stdout).result;
			} catch {
				throw new Error(`herdr ${args.join(" ")} returned non-JSON: ${result.stdout}`);
			}
		}
		const err = parseHerdrError(result.stderr);
		const paneBusy = err?.code === "agent_pane_busy";
		if (retryPaneBusy && paneBusy && attempt < 5) {
			await sleep(500);
			continue;
		}
		throw new Error(`herdr ${args.join(" ")} failed: ${err?.message ?? result.stderr?.trim()}`);
	}
}

function parseHerdrError(stderr) {
	if (!stderr) return undefined;
	try {
		const parsed = JSON.parse(stderr);
		return parsed?.error ? { code: parsed.error.code, message: parsed.error.message } : undefined;
	} catch {
		return undefined;
	}
}

function promptPane(paneId, text) {
	try {
		runHerdr(["agent", "prompt", paneId, text]);
	} catch (error) {
		console.error(`promptPane ${paneId} failed: ${error.message}`);
	}
}

function verifierExtensionPath() {
	// extensions/verifier.ts, relative to this plugin file's location.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "extensions", "verifier.ts");
}

function buildVerifierPrompt(task, event) {
	// Role framing is injected by verifier.ts's system-prompt hook; this is
	// just the per-task review context. Single line, quotes stripped: herdr
	// shell-encodes `agent start -- <argv>` and rejects multi-line/quoted.
	const request = task.prompt.replace(/\s+/g, " ").replace(/["'`]/g, "");
	const context = event.context.replace(/\s+/g, " ").replace(/["'`]/g, "");
	return `Task ${task.id}. Original request: ${request}. Worker signal: ${event.action} - ${context}. Review the work against the request and verifier_signal.`;
}

// Spawn a Verifier pane in the Worker's own worktree (so it sees the real
// changes), seed it, and register it so its own signals route back. Returns
// the verifier pane id, or undefined on failure.
async function spawnVerifier(task, event) {
	const verifierId = `${task.id}-verifier`;
	let paneId;
	try {
		const result = await runHerdr([
			"workspace",
			"create",
			"--cwd",
			task.worktreePath,
			"--label",
			verifierId,
			"--no-focus",
		]);
		paneId = result.root_pane.pane_id;
	} catch (error) {
		console.error(`spawnVerifier workspace create failed: ${error.message}`);
		promptPane(task.foremanPaneId, `Task ${task.id}: failed to spawn Verifier (${error.message}). Review manually.`);
		return undefined;
	}

	const piFlags = ["-e", verifierExtensionPath()];
	if (task.provider) piFlags.push("--provider", task.provider);
	if (task.model) piFlags.push("--model", task.model);
	piFlags.push(buildVerifierPrompt(task, event));

	try {
		await runHerdr(
			["agent", "start", verifierId, "--kind", "pi", "--pane", paneId, "--", ...piFlags],
			{ retryPaneBusy: true },
		);
	} catch (error) {
		console.error(`spawnVerifier agent start failed: ${error.message}`);
		promptPane(task.foremanPaneId, `Task ${task.id}: Verifier pane created (${paneId}) but agent failed to start (${error.message}).`);
		return undefined;
	}

	const verifierEntry = {
		...task,
		paneId,
		role: "verifier",
		workerPaneId: task.paneId,
		sessionPath: undefined,
		createdAt: Date.now(),
	};
	delete verifierEntry.verifierPaneId;
	upsertEntry(verifierEntry);

	// Link back from the worker entry so later reviews re-prompt, not re-spawn.
	const registry = readRegistry();
	if (registry[task.paneId]) {
		registry[task.paneId].verifierPaneId = paneId;
		writeRegistry(registry);
	}

	return paneId;
}

function describeWorkerSignal(event) {
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

function describeVerifierSignal(event) {
	if (!event) return "went idle with no recorded verdict";
	switch (event.action) {
		case "approve":
			return `approved: ${event.context}`;
		case "deny":
			return `denied, sent back to Worker: ${event.context}`;
		case "flag":
			return `concern raised: ${event.context}`;
		default:
			return `unrecognized verdict: ${JSON.stringify(event)}`;
	}
}

// --- main ----------------------------------------------------------------

const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const data = event?.data;
const status = data?.agent_status;
const paneId = data?.pane_id;

if (!status || !paneId || !REACTABLE_STATUSES.has(status)) {
	process.exit(0);
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
const key = dedupeKey(task, lastEvent);
if (alreadyPushed(key)) {
	process.exit(0);
}
markPushed(key);

if (!task.foremanPaneId) {
	// Task was created outside herdr. We can still spawn a Verifier below,
	// but can't notify — so for non-spawn cases there's nothing to do.
	if (task.role !== "worker" || !lastEvent || !VERIFIER_ACTIONS.has(lastEvent.action)) {
		process.exit(0);
	}
}

if (task.role === "worker") {
	const describe = `Task ${task.id} (${status}): ${describeWorkerSignal(lastEvent)}`;
	if (task.foremanPaneId) promptPane(task.foremanPaneId, describe);

	if (lastEvent && VERIFIER_ACTIONS.has(lastEvent.action)) {
		if (task.verifierPaneId) {
			promptPane(task.verifierPaneId, `Worker ${lastEvent.action}: ${lastEvent.context}. Review again and verifier_signal.`);
		} else {
			await spawnVerifier(task, lastEvent);
		}
	}
	process.exit(0);
}

if (task.role === "verifier") {
	const describe = `Task ${task.id} verifier (${status}): ${describeVerifierSignal(lastEvent)}`;
	if (task.foremanPaneId) promptPane(task.foremanPaneId, describe);

	if (lastEvent?.action === "deny" && task.workerPaneId) {
		promptPane(task.workerPaneId, `Verifier denied: ${lastEvent.context}. Address this and worker_signal done when ready.`);
	}
	process.exit(0);
}

process.exit(0);
