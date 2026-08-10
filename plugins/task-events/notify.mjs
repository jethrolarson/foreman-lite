// herdr event hook: fires on every pane.agent_status_changed, for every
// pane herdr knows about, not just ours. Routes Task Thread lifecycle
// signals to the right place based on the pane's role:
//
//   Worker  planned      -> notify Foreman
//   Worker  done + PR    -> notify Foreman + spawn/re-prompt Verifier
//   Worker  flag         -> notify Foreman
//   Verifier approve     -> notify Foreman (task complete pending merge)
//   Verifier deny        -> notify Foreman + route Worker to PR feedback
//   Verifier flag        -> notify Foreman
//
// Foreman independently decides whether any signal warrants human attention.
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
// Verification starts only once `done` guarantees a PR exists. `planned`
// is a deliberate Foreman checkpoint; there is no durable review surface yet.
const VERIFIER_ACTIONS = new Set(["done"]);

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

// Read & parse a JSON file we own. Missing (ENOENT) = absent; anything else
// (corrupt, permission) throws rather than masquerading as empty — a corrupt
// registry must surface, not silently look like no tasks.
function readJsonOptional(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(raw);
}

function readRegistry() {
  return readJsonOptional(registryPath()) ?? {};
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

function setTaskPrUrl(taskId, prUrl) {
  const registry = readRegistry();
  for (const record of Object.values(registry)) {
    if (record.id === taskId) record.prUrl = prUrl;
  }
  writeRegistry(registry);

  const metaPath = join(homedir(), ".foreman", "tasks", taskId, "meta.json");
  const meta = readJsonOptional(metaPath);
  if (meta) {
    meta.prUrl = prUrl;
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
}

// Per-task state lives under ~/.foreman/tasks/<id>/ (not in the repo), so
// the plugin reads events.jsonl by task id, not worktree path.
function lastTaskEvent(taskId) {
  let raw;
  try {
    raw = readFileSync(
      join(homedir(), ".foreman", "tasks", taskId, "events.jsonl"),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const last = raw.trim().split("\n").filter(Boolean).at(-1);
  return last ? JSON.parse(last) : undefined;
}

// Dedupe against re-pushing the same underlying signal if agent_status
// flickers more than once for one logical change (e.g. the worker.ts nag
// loop causing idle/working flips before it actually signals). Keyed by
// task + role + event timestamp, so a genuinely new signal still fires.
function dedupeKey(task, event) {
  const ts = event?.timestamp ?? "none";
  return `${task.id}:${event?.role ?? "unknown"}:${ts}`;
}

// seen.json dedupe state. Unlike the registry, a corrupt/missing seen file
// defaulting to "not pushed" is safe: the worst case is a duplicate push,
// and pushes are idempotent for the human. So bare-catch defaults are fine
// here — not the masquerading-as-empty smell that registry reads carry.
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

// Launching immediately after pane creation can hit agent_pane_busy (the shell
// is not ready yet). Bounded retry only that observed transient failure.
async function runHerdr(
  args,
  { retryPaneBusy = false, expectJson = true } = {},
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = spawnSync(HERDR_BIN, args, { encoding: "utf8" });
    if (result.status === 0) {
      if (!expectJson) return undefined;
      try {
        return JSON.parse(result.stdout).result;
      } catch {
        throw new Error(
          `herdr ${args.join(" ")} returned non-JSON: ${result.stdout}`,
        );
      }
    }
    const err = parseHerdrError(result.stderr);
    const paneBusy = err?.code === "agent_pane_busy";
    if (retryPaneBusy && paneBusy && attempt < 5) {
      await sleep(500);
      continue;
    }
    const e = new Error(
      `herdr ${args.join(" ")} failed: ${err?.message ?? result.stderr?.trim()}`,
    );
    e.code = err?.code;
    throw e;
  }
}

function parseHerdrError(stderr) {
  if (!stderr) return undefined;
  try {
    const parsed = JSON.parse(stderr);
    return parsed?.error
      ? { code: parsed.error.code, message: parsed.error.message }
      : undefined;
  } catch {
    return undefined;
  }
}

async function promptPane(paneId, text) {
  try {
    await runHerdr(["agent", "prompt", paneId, text]);
  } catch (error) {
    console.error(`promptPane ${paneId} failed: ${error.message}`);
  }
}

// Tolerant current-status check for debouncing. Returns undefined on any error
// (e.g. agent momentarily not found) rather than throwing.
function agentStatus(paneId) {
  const result = spawnSync(HERDR_BIN, ["agent", "get", paneId], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout).result.agent.agent_status;
  } catch {
    return undefined;
  }
}

function verifierExtensionPath() {
  // extensions/verifier.ts, relative to this plugin file's location.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "extensions", "verifier.ts");
}

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

function buildVerifierPrompt(task, event) {
  // Role framing is injected by verifier.ts's system-prompt hook; this is
  // just the per-task review context. Passed via @file (see spawnVerifier) so
  // newlines/quotes in the worker's context don't trip herdr's shell encoder.
  const prUrl = event.prUrl ?? task.prUrl;
  return [
    `Task ${task.id}.`,
    `Pull request: ${prUrl ?? "locate it with `gh pr view --json url`"}`,
    `Original request: ${task.prompt}`,
    `Worker signal: ${event.action} — ${event.context}`,
    "",
    "Review the work against the request: inspect the PR diff, read the changes, run tests, and re-check the spec. Put the durable review in a marked GitHub PR comment; do not commit review notes or implement fixes yourself.",
    "Then call verifier_signal: approve (work is correct), deny (short summary; detailed feedback is on the PR), or flag (raise a concern to Foreman).",
  ].join("\n");
}

function writeVerifierPromptFile(task, event) {
  const dir = join(homedir(), ".foreman", "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${task.id}-verifier-${Date.now().toString(36)}.txt`);
  writeFileSync(path, buildVerifierPrompt(task, event));
  return path;
}

// Spawn a Verifier as a split of the Worker's pane (same workspace, so it
// nests under the Worker/Foreman in herdr's tree) in the Worker's own
// worktree (so it sees the real changes). Seed it, register it so its own
// signals route back. Returns the verifier pane id, or undefined on failure.
async function spawnVerifier(task, event) {
  let paneId;
  try {
    const result = await runHerdr([
      "pane",
      "split",
      task.paneId,
      "--direction",
      "down",
      "--cwd",
      task.worktreePath,
      "--no-focus",
    ]);
    paneId = result.pane.pane_id;
  } catch (error) {
    console.error(`spawnVerifier pane split failed: ${error.message}`);
    await promptPane(
      task.foremanPaneId,
      signalEnvelope(
        "foreman-signal",
        { source: "system", task: task.id, status: "error" },
        `Failed to spawn Verifier (${error.message}). Review manually.`,
      ),
    );
    return undefined;
  }

  const piFlags = [
    "-e",
    verifierExtensionPath(),
    "--name",
    `Verifier: ${task.name}`,
  ];
  if (task.provider) piFlags.push("--provider", task.provider);
  if (task.model) piFlags.push("--model", task.model);
  piFlags.push(`@${writeVerifierPromptFile(task, event)}`);

  try {
    const command = ["pi", ...piFlags].map(shellQuote).join(" ");
    await runHerdr(["pane", "run", paneId, command], {
      retryPaneBusy: true,
      expectJson: false,
    });
  } catch (error) {
    console.error(`spawnVerifier pane run failed: ${error.message}`);
    await promptPane(
      task.foremanPaneId,
      signalEnvelope(
        "foreman-signal",
        { source: "system", task: task.id, status: "error" },
        `Verifier pane created (${paneId}) but pi failed to launch (${error.message}).`,
      ),
    );
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

// Plugin-pushed messages arrive as user-role text, so a sub-agent signal is
// indistinguishable from the human speaking unless we mark it. The
// `::foreman-signal::` / `::directive::` header is the contract the Foreman
// and Worker roles key on (see roles/*.md): header line = machine fields,
// following lines = human-readable detail. Without it the Foreman replies to
// verifier reports as if the human's message got cut off.
function signalEnvelope(tag, fields, detail) {
  const head = [
    `::${tag}::`,
    ...Object.entries(fields).map(([k, v]) => `${k}=${v}`),
  ].join(" ");
  return detail ? `${head}\n${detail}` : head;
}

function workerDetail(event) {
  if (!event) return "went idle with no recorded signal";
  return event.context ?? "(no detail)";
}

function verifierDetail(event) {
  if (!event) return "went idle with no recorded verdict";
  return event.context ?? "(no detail)";
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

const lastEvent = lastTaskEvent(task.id);

if (task.role === "worker" && lastEvent?.action === "done" && lastEvent.prUrl) {
  task.prUrl = lastEvent.prUrl;
  setTaskPrUrl(task.id, lastEvent.prUrl);
}

// A Worker going idle with no signal is ambiguous: the nag hook may be
// re-triggering a turn, so the pane flickers idle between agent_end and the
// followUp. Debounce — if it's working again shortly after, it's a flicker,
// not a stuck worker; exit without marking so a later real push can fire.
// Real signals (lastEvent set) push immediately.
if (task.role === "worker" && !lastEvent && status === "idle") {
  await sleep(3000);
  const current = agentStatus(paneId);
  if (current && current !== "idle") process.exit(0);
}

const key = dedupeKey(task, lastEvent);
if (alreadyPushed(key)) {
  process.exit(0);
}
markPushed(key);

if (!task.foremanPaneId) {
  // Task was created outside herdr. We can still spawn a Verifier below,
  // but can't notify — so for non-spawn cases there's nothing to do.
  if (
    task.role !== "worker" ||
    !lastEvent ||
    !VERIFIER_ACTIONS.has(lastEvent.action)
  ) {
    process.exit(0);
  }
}

if (task.role === "worker") {
  const describe = signalEnvelope(
    "foreman-signal",
    {
      source: "worker",
      task: task.id,
      status,
      signal: lastEvent?.action ?? "none",
      ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    },
    workerDetail(lastEvent),
  );
  if (task.foremanPaneId) await promptPane(task.foremanPaneId, describe);

  if (lastEvent && VERIFIER_ACTIONS.has(lastEvent.action)) {
    if (task.verifierPaneId) {
      await promptPane(
        task.verifierPaneId,
        signalEnvelope(
          "directive",
          {
            source: "worker",
            task: task.id,
            signal: lastEvent.action,
            ...(task.prUrl ? { prUrl: task.prUrl } : {}),
          },
          `Worker pushed updates to ${task.prUrl ?? "the task PR"}: ${lastEvent.context}. Review the PR again, leave a marked GitHub comment, then verifier_signal.`,
        ),
      );
    } else {
      await spawnVerifier(task, lastEvent);
    }
  }
  process.exit(0);
}

if (task.role === "verifier") {
  const describe = signalEnvelope(
    "foreman-signal",
    {
      source: "verifier",
      task: task.id,
      status,
      verdict: lastEvent?.action ?? "none",
      ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    },
    verifierDetail(lastEvent),
  );
  if (task.foremanPaneId) await promptPane(task.foremanPaneId, describe);

  if (lastEvent?.action === "deny" && task.workerPaneId) {
    await promptPane(
      task.workerPaneId,
      signalEnvelope(
        "directive",
        {
          source: "verifier",
          task: task.id,
          verdict: "deny",
          ...(task.prUrl ? { prUrl: task.prUrl } : {}),
        },
        `Verifier left detailed feedback on ${task.prUrl ?? "the task PR (locate it with `gh pr view --json url`)"}. Read the marked Verifier comment, address it, push the fixes, leave a marked Worker response, then worker_signal done with the PR URL. Summary: ${lastEvent.context}`,
      ),
    );
  }
  process.exit(0);
}

process.exit(0);
