// Herdr process adapter. Decision logic lives in notify-core.mjs so importing it
// never exits a process or invokes Herdr.
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  REACTABLE_STATUSES,
  buildNotification,
  latestRoleEvent,
} from "./notify-core.mjs";

const readJsonEnv = (name) => {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const readJsonOptional = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

const stateRoot = join(homedir(), ".foreman");
const readRegistry = () =>
  readJsonOptional(join(stateRoot, "registry.json")) ?? {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findTaskWithRetry = async (paneId, attempts = 5, delayMs = 200) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const task = readRegistry()[paneId];
    if (task) return task;
    if (attempt < attempts) await sleep(delayMs);
  }
  return undefined;
};

const lastTaskEvent = (taskId, role) => {
  try {
    return latestRoleEvent(
      readFileSync(join(stateRoot, "tasks", taskId, "events.jsonl"), "utf8"),
      role,
    );
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

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

const queueMessage = (paneId, message) => {
  const path = join(
    stateRoot,
    "inboxes",
    encodeURIComponent(paneId),
    "messages",
    `${message.id}.json`,
  );
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
const status = event?.data?.agent_status;
const paneId = event?.data?.pane_id;
if (status && paneId && REACTABLE_STATUSES.has(status)) {
  const task = await findTaskWithRetry(paneId);
  if (task) {
    const taskEvent = lastTaskEvent(task.id, task.role);
    let transientIdle = false;
    if (task.role === "worker" && !taskEvent && status === "idle") {
      await sleep(3_000);
      const current = agentStatus(paneId);
      transientIdle = Boolean(current && current !== "idle");
    }
    if (!transientIdle) {
      const notification = buildNotification({
        task,
        paneId,
        paneStatus: status,
        taskEvent,
        now: Date.now,
      });
      if (notification) queueMessage(notification.paneId, notification.message);
    }
  }
}
