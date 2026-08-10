import { describe, expect, it } from "vitest";
import {
  addWorktreeCommand,
  buildPiLaunchCommand,
  createTaskTabCommand,
  describeTabFailure,
  haltPaneCommand,
  removeWorktreeCommand,
  resolveRepositoryCommand,
  runPaneCommand,
  sharedPlacement,
  verifierDisposition,
} from "./foremanMechanics.js";

describe("Foreman command planning", () => {
  it("uses shared placement directly without planning a Git command", () => {
    expect(sharedPlacement("/shared")).toEqual({
      kind: "shared",
      path: "/shared",
    });
  });

  it("plans detached worktree creation and rollback without a branch", () => {
    expect(resolveRepositoryCommand("/repo/sub").args).toEqual([
      "-C",
      "/repo/sub",
      "rev-parse",
      "--show-toplevel",
    ]);
    const add = addWorktreeCommand("/repo", "/worktree", "HEAD");
    expect(add).toEqual({
      executable: "git",
      args: ["-C", "/repo", "worktree", "add", "--detach", "/worktree", "HEAD"],
    });
    expect(add.args).not.toContain("-b");
    expect(removeWorktreeCommand("/repo", "/worktree").args).toEqual([
      "-C",
      "/repo",
      "worktree",
      "remove",
      "--force",
      "/worktree",
    ]);
  });

  it("creates a task tab in the existing workspace with cwd and task id", () => {
    const command = createTaskTabCommand("workspace", "/selected", "task-1");
    expect(command.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "workspace",
      "--cwd",
      "/selected",
      "--label",
      "task-1",
      "--env",
      "FOREMAN_TASK_ID=task-1",
      "--no-focus",
    ]);
    expect(command.args.filter((arg) => arg === "workspace")).toHaveLength(1);
  });

  it("keeps rollback failures visible in tab diagnostics", () => {
    expect(describeTabFailure("tab unavailable")).toBe(
      "Failed to create Task Thread tab: tab unavailable",
    );
    expect(describeTabFailure("tab unavailable", "worktree busy")).toContain(
      "Worktree rollback also failed: worktree busy",
    );
  });

  it("launches a Worker with task id, provider, model, extension and prompt", () => {
    const command = buildPiLaunchCommand(
      "worker",
      { id: "task 1", name: "Build", provider: "p", model: "m" },
      "/worker.ts",
      "/prompt file.txt",
    );
    expect(command).toContain("FOREMAN_TASK_ID='task 1'");
    for (const value of ["'p'", "'m'", "'/worker.ts'", "'@/prompt file.txt'"])
      expect(command).toContain(value);
    expect(runPaneCommand("worker-pane", command).args).toEqual([
      "pane",
      "run",
      "worker-pane",
      command,
    ]);
  });

  it("distinguishes first verification from reuse and targets halt by Worker pane", () => {
    expect(verifierDisposition()).toEqual({ kind: "create" });
    expect(verifierDisposition("verifier-pane")).toEqual({
      kind: "reuse",
      paneId: "verifier-pane",
    });
    expect(haltPaneCommand("worker-pane").args).toEqual([
      "agent",
      "send-keys",
      "worker-pane",
      "esc",
    ]);
  });
});
