import { createHash } from "node:crypto";

export const REACTABLE_STATUSES = new Set(["idle", "blocked", "done"]);

export const latestRoleEvent = (jsonLines, role) =>
  jsonLines
    .trim()
    .split("\n")
    .filter(Boolean)
    .reverse()
    .map((line) => JSON.parse(line))
    .find((event) => event.role === role);

export const notificationId = (task, taskEvent) => {
  const key = `${task.id}:${taskEvent?.role ?? task.role}:${taskEvent?.timestamp ?? "none"}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
};

export const buildNotification = ({
  task,
  paneId,
  paneStatus,
  taskEvent,
  now,
}) => {
  if (!task.foremanPaneId) return undefined;
  const source = task.role === "verifier" ? "verifier" : "worker";
  const action = taskEvent?.action ?? "none";
  const context =
    taskEvent?.context ?? `Agent became ${paneStatus} without a signal.`;
  const label = source === "verifier" ? "Verifier verdict" : "Worker signal";
  return {
    paneId: task.foremanPaneId,
    message: {
      id: notificationId(task, taskEvent),
      customType: "foreman-task-signal",
      content: `${label} for task ${task.id}: ${action}\n${context}`,
      details: {
        source,
        taskId: task.id,
        paneId,
        paneStatus,
        action,
        context,
        eventTimestamp: taskEvent?.timestamp,
      },
      createdAt: taskEvent?.timestamp ?? now(),
      triggerTurn: true,
      deliverAs: "steer",
    },
  };
};
