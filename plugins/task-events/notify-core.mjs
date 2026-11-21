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

const STARTED_BY = { task: "Foreman", human: "a human in the pane" };

// herdr reports "done" for a finished turn; to Foreman that is idle.
const paneState = (paneStatus) =>
  paneStatus === "blocked" ? "blocked" : "idle";

// `stopped` context is a final reply, not a verdict.
const meaning = (taskEvent) => {
  switch (taskEvent?.action) {
    case "planned":
      return "waiting for your input on its plan";
    case "done":
      return "reports its result ready";
    case "flag":
      return "reports it is blocked and needs input";
    case "approve":
    case "deny":
      return `verdict: ${taskEvent.action}`;
    case "stopped":
      return `ended its turn without a signal (started by ${STARTED_BY[taskEvent.origin] ?? "unknown"}, stop reason: ${taskEvent.stopReason}). Final reply`;
    default:
      return "has no recorded signal";
  }
};

// Notifications fire only once a child stops, so the state is the child's at send time.
const headline = (source, taskId, paneStatus, taskEvent) =>
  `${source === "verifier" ? "Verifier" : "Worker"} for task ${taskId} is ${paneState(paneStatus)}; ${meaning(taskEvent)}:`;

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
  return {
    paneId: task.foremanPaneId,
    message: {
      id: notificationId(task, taskEvent),
      customType: "foreman-task-signal",
      content: `${headline(source, task.id, paneStatus, taskEvent)}\n${context}`,
      details: {
        source,
        taskId: task.id,
        paneId,
        paneStatus,
        action,
        context,
        origin: taskEvent?.origin,
        stopReason: taskEvent?.stopReason,
        eventTimestamp: taskEvent?.timestamp,
      },
      createdAt: taskEvent?.timestamp ?? now(),
      triggerTurn: true,
      deliverAs: "steer",
    },
  };
};
