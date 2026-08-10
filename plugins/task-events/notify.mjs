// Herdr event hook: routes Worker and Verifier lifecycle signals to the
// Foreman's structured inbox. It reports facts only; Foreman decides whether
// to continue, verify, remediate, escalate, or do nothing.

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const REACTABLE_STATUSES = new Set(["idle", "blocked", "done"]);

const readJsonEnv = (name) => {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const registryPath = () => join(homedir(), ".foreman", "registry.json");

const readJsonOptional = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

const readRegistry = () => readJsonOptional(registryPath()) ?? {};

const lastTaskEvent = (taskId, role) => {
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
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .reverse()
    .map((line) => JSON.parse(line))
    .find((event) => event.role === role);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentStatus = (paneId) => {
  const result = spawnSync(
    process.env.HERDR_BIN_PATH ?? "herdr",
    ["agent", "get", paneId],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout).result.agent.agent_status;
  } catch {
    return undefined;
  }
};

const findTaskWithRetry = async (paneId, attempts = 5, delayMs = 200) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const task = readRegistry()[paneId];
    if (task) return task;
    if (attempt < attempts) await sleep(delayMs);
  }
  return undefined;
};

const dedupeKey = (task, event) =>
  `${task.id}:${event?.role ?? task.role}:${event?.timestamp ?? "none"}`;

const messageId = (key) =>
  createHash("sha256").update(key).digest("hex").slice(0, 32);

const inboxRoot = (paneId) =>
  join(homedir(), ".foreman", "inboxes", encodeURIComponent(paneId));

const queueMessage = (paneId, message) => {
  const path = join(inboxRoot(paneId), "messages", `${message.id}.json`);
  if (existsSync(path)) return;

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(message, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
};

const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const data = event?.data;
const status = data?.agent_status;
const paneId = data?.pane_id;

if (!status || !paneId || !REACTABLE_STATUSES.has(status)) process.exit(0);

const task = await findTaskWithRetry(paneId);
if (!task) process.exit(0);

const taskEvent = lastTaskEvent(task.id, task.role);

// Going idle without a signal may be the extension's bounded reminder turn.
// Wait briefly and suppress the transient idle/working flicker.
if (task.role === "worker" && !taskEvent && status === "idle") {
  await sleep(3_000);
  const current = agentStatus(paneId);
  if (current && current !== "idle") process.exit(0);
}

if (!task.foremanPaneId) process.exit(0);

const source = task.role === "verifier" ? "verifier" : "worker";
const action = taskEvent?.action ?? "none";
const context =
  taskEvent?.context ?? `Agent became ${status} without a signal.`;
const details = {
  source,
  taskId: task.id,
  paneId,
  paneStatus: status,
  action,
  context,
  eventTimestamp: taskEvent?.timestamp,
};
const label = source === "verifier" ? "Verifier verdict" : "Worker signal";
const message = {
  id: messageId(dedupeKey(task, taskEvent)),
  customType: "foreman-task-signal",
  content: `${label} for task ${task.id}: ${action}\n${context}`,
  details,
  triggerTurn: true,
  deliverAs: "steer",
};

queueMessage(task.foremanPaneId, message);
