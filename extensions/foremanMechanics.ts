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

export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildPiLaunchCommand = (
  role: "worker" | "verifier",
  task: { id: string; name: string; provider?: string; model?: string },
  extensionPath: string,
  promptFile: string,
): string => {
  const args = [
    "pi",
    "-e",
    extensionPath,
    "--name",
    `${role === "worker" ? "Worker" : "Verifier"}: ${task.name}`,
  ];
  if (task.provider) args.push("--provider", task.provider);
  if (task.model) args.push("--model", task.model);
  args.push(`@${promptFile}`);
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
