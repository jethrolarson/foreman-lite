// Foreman-lite state lives outside source trees under ~/.foreman. Task
// identity is explicit because multiple Task Threads may share one directory.

import { homedir } from "node:os";
import { join } from "node:path";

export const taskStateDir = (taskId: string): string =>
  join(homedir(), ".foreman", "tasks", taskId);

export const taskMetaPath = (taskId: string): string =>
  join(taskStateDir(taskId), "meta.json");

export const taskEventsPath = (taskId: string): string =>
  join(taskStateDir(taskId), "events.jsonl");

export const taskIdFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const taskId = environment.FOREMAN_TASK_ID?.trim();
  if (!taskId)
    throw new Error(
      "FOREMAN_TASK_ID is required; start this role through foreman-lite create_task",
    );
  return taskId;
};
