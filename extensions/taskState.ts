// Foreman-lite per-task state lives under ~/.foreman/ so it never dirties the
// user's repo or worktree. Keyed by task id: the Foreman knows the id
// directly; Worker/Verifier derive it from their worktree's basename, which
// the Foreman creates as `task-<id>` (see createWorktree in foreman.ts).

import { homedir } from "node:os";
import { join } from "node:path";

export function taskStateDir(taskId: string): string {
  return join(homedir(), ".foreman", "tasks", taskId);
}

export function taskMetaPath(taskId: string): string {
  return join(taskStateDir(taskId), "meta.json");
}

export function taskEventsPath(taskId: string): string {
  return join(taskStateDir(taskId), "events.jsonl");
}

// Worktrees are created as `task-<id>`; recover the id by stripping exactly
// one leading `task-` prefix (safe even if the id itself contains "task-").
export function taskIdFromCwd(cwd: string): string {
  const base = cwd.split("/").pop();
  if (!base) throw new Error(`cannot derive task id from cwd: ${cwd}`);
  return base.replace(/^task-/, "");
}
