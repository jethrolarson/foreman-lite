export interface CommandPlan {
  executable: string;
  args: string[];
}

export const sharedPlacement = (path: string) =>
  ({ kind: "shared", path }) as const;

export const resolveRepositoryCommand = (cwd: string): CommandPlan => ({
  executable: "git",
  args: ["-C", cwd, "rev-parse", "--show-toplevel"],
});

export const addWorktreeCommand = (
  repoRoot: string,
  path: string,
  revision: string,
): CommandPlan => ({
  executable: "git",
  args: ["-C", repoRoot, "worktree", "add", "--detach", path, revision],
});

export const removeWorktreeCommand = (
  repoRoot: string,
  path: string,
): CommandPlan => ({
  executable: "git",
  args: ["-C", repoRoot, "worktree", "remove", "--force", path],
});

export const createTaskTabCommand = (
  workspaceId: string,
  cwd: string,
  taskId: string,
): CommandPlan => ({
  executable: "herdr",
  args: [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    cwd,
    "--label",
    taskId,
    "--env",
    `FOREMAN_TASK_ID=${taskId}`,
    "--no-focus",
  ],
});

export const splitVerifierPaneCommand = (
  workerPaneId: string,
  cwd: string,
): CommandPlan => ({
  executable: "herdr",
  args: [
    "pane",
    "split",
    workerPaneId,
    "--direction",
    "down",
    "--cwd",
    cwd,
    "--no-focus",
  ],
});

export const runPaneCommand = (
  paneId: string,
  command: string,
): CommandPlan => ({
  executable: "herdr",
  args: ["pane", "run", paneId, command],
});

export const haltPaneCommand = (paneId: string): CommandPlan => ({
  executable: "herdr",
  args: ["agent", "send-keys", paneId, "esc"],
});

export const agentListCommand = (): CommandPlan => ({
  executable: "herdr",
  args: ["agent", "list"],
});

export const paneGetCommand = (paneId: string): CommandPlan => ({
  executable: "herdr",
  args: ["pane", "get", paneId],
});

// Pane ids that currently host a live agent process. A pane whose pi has died
// keeps its shell but drops out of this set, which is how recovery tells a
// running child from one that needs relaunching.
export const parseLiveAgentPanes = (
  agentList: Record<string, unknown> | undefined,
): Set<string> => {
  const agents = (agentList?.agents ?? []) as Array<{ pane_id?: unknown }>;
  return new Set(
    agents
      .map((agent) => agent.pane_id)
      .filter((paneId): paneId is string => typeof paneId === "string"),
  );
};

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildPiLaunchCommand = (
  role: "worker" | "verifier",
  task: {
    id: string;
    name: string;
    provider?: string;
    model?: string;
    sessionId?: string;
  },
  extensionPath: string,
  promptFile: string,
  options: { resume?: boolean } = {},
): string => {
  const args = [
    "pi",
    "-e",
    extensionPath,
    "--name",
    `${role === "worker" ? "Worker" : "Verifier"}: ${task.name}`,
  ];
  // pi treats --session-id as "use this project session, creating it if
  // missing", so first launch and recovery relaunch pass the same flag. On
  // resume the transcript already holds the task prompt; re-injecting the
  // prompt file would replay it, so it is omitted and re-orientation comes
  // through the structured inbox instead.
  if (task.sessionId) args.push("--session-id", task.sessionId);
  if (task.provider) args.push("--provider", task.provider);
  if (task.model) args.push("--model", task.model);
  if (!options.resume) args.push(`@${promptFile}`);
  return `FOREMAN_TASK_ID=${shellQuote(task.id)} ${args.map(shellQuote).join(" ")}`;
};

export const verifierDisposition = (verifierPaneId?: string) =>
  verifierPaneId
    ? ({ kind: "reuse", paneId: verifierPaneId } as const)
    : ({ kind: "create" } as const);

export const describeTabFailure = (
  tabError: string,
  rollbackError?: string,
): string =>
  `Failed to create Task Thread tab: ${tabError}${
    rollbackError ? ` Worktree rollback also failed: ${rollbackError}` : ""
  }`;
