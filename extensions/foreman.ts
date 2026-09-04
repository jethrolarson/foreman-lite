import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renameForemanTabAtStartup } from "./foremanStartup.js";
import { queueInboxMessage, registerInbox } from "./inbox.js";
import {
  addWorktreeCommand,
  agentListCommand,
  buildPiLaunchCommand,
  createTaskTabCommand,
  describeTabFailure,
  haltPaneCommand,
  paneGetCommand,
  parseLiveAgentPanes,
  removeWorktreeCommand,
  resolveRepositoryCommand,
  runPaneCommand,
  sharedPlacement,
  splitVerifierPaneCommand,
  verifierDisposition,
} from "./foremanMechanics.js";
import { readRole } from "./roles.js";

type TaskPlacement =
  | { kind: "shared"; path: string }
  | {
      kind: "git-worktree";
      path: string;
      repoRoot: string;
      revision: string;
    };

interface TaskRecord {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  placement: TaskPlacement;
  workspaceId: string;
  tabId: string;
  workerPaneId: string;
  workerSessionId: string;
  verifierPaneId?: string;
  verifierSessionId?: string;
  foremanPaneId?: string;
  provider?: string;
  model?: string;
  createdAt: number;
}

interface PaneRegistration extends TaskRecord {
  paneId: string;
  role: "worker" | "verifier";
}

interface HerdrError {
  code?: string;
  message: string;
}

export type CommandResult<T> =
  { ok: true; value: T } | { ok: false; error: HerdrError };
type Result<T> = CommandResult<T>;

export interface ForemanCommandRunner {
  run: (executable: string, args: string[]) => Result<string>;
  runJson: (
    executable: string,
    args: string[],
  ) => Result<Record<string, unknown>>;
}

export interface ForemanDependencies {
  commands: ForemanCommandRunner;
  stateRoot: string;
  now: () => number;
  newId: () => string;
  newSessionId: () => string;
  extensionPath: (role: "worker" | "verifier") => string;
  queueInbox: typeof queueInboxMessage;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (message: string, code?: string): Result<never> => ({
  ok: false,
  error: { message, code },
});

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const taskId = (name: string, suffix: string): string => {
  const slug = slugify(name).slice(0, 23);
  return slug ? `${slug}-${suffix}` : suffix;
};

const readJsonOptional = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeJsonAtomic = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, path);
};

const taskMetaPathAt = (stateRoot: string, id: string): string =>
  join(stateRoot, "tasks", id, "meta.json");

const readTaskRecord = (
  stateRoot: string,
  id: string,
): TaskRecord | undefined =>
  readJsonOptional<TaskRecord>(taskMetaPathAt(stateRoot, id));

const writeTaskRecord = (stateRoot: string, record: TaskRecord): void =>
  writeJsonAtomic(taskMetaPathAt(stateRoot, record.id), record);

const registryPath = (stateRoot: string): string =>
  join(stateRoot, "registry.json");

const readRegistry = (stateRoot: string): Record<string, PaneRegistration> =>
  readJsonOptional<Record<string, PaneRegistration>>(registryPath(stateRoot)) ??
  {};

const writePaneRegistration = (
  stateRoot: string,
  record: TaskRecord,
  paneId: string,
  role: PaneRegistration["role"],
): void => {
  const path = registryPath(stateRoot);
  const registry = readRegistry(stateRoot);
  registry[paneId] = { ...record, paneId, role };
  writeJsonAtomic(path, registry);
};

const parseCommandError = (
  executable: string,
  args: string[],
  error: unknown,
): HerdrError => {
  const stderr = (error as { stderr?: Buffer | string }).stderr?.toString();
  if (stderr) {
    try {
      const parsed = JSON.parse(stderr) as {
        error?: { message?: string; code?: string };
      };
      if (parsed.error?.message)
        return {
          message: `${executable} ${args.join(" ")} failed: ${parsed.error.message}`,
          code: parsed.error.code,
        };
    } catch {
      // Fall through to the exact stderr text.
    }
    return {
      message: `${executable} ${args.join(" ")} failed: ${stderr.trim()}`,
    };
  }
  return {
    message: `${executable} ${args.join(" ")} failed: ${String(error)}`,
  };
};

const runJsonCommand = (
  executable: string,
  args: string[],
): Result<Record<string, unknown>> => {
  let stdout: string;
  try {
    stdout = execFileSync(executable, args, { encoding: "utf8" });
  } catch (error) {
    const parsed = parseCommandError(executable, args, error);
    return fail(parsed.message, parsed.code);
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
    return parsed.result
      ? ok(parsed.result)
      : fail(`${executable} returned no result: ${stdout}`);
  } catch {
    return fail(`${executable} returned non-JSON: ${stdout}`);
  }
};

const runCommand = (executable: string, args: string[]): Result<string> => {
  try {
    return ok(execFileSync(executable, args, { encoding: "utf8" }).trim());
  } catch (error) {
    const parsed = parseCommandError(executable, args, error);
    return fail(parsed.message, parsed.code);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runHerdrNoOutputRetryingPaneBusy = async (
  commands: ForemanCommandRunner,
  args: string[],
  attempts = 5,
): Promise<Result<void>> => {
  for (let attempt = 1; ; attempt++) {
    const result = commands.run("herdr", args);
    if (result.ok) return ok(undefined);
    if (result.error.code !== "agent_pane_busy" || attempt >= attempts)
      return result;
    await sleep(500);
  }
};

const productionExtensionPath = (name: "worker" | "verifier"): string =>
  join(dirname(fileURLToPath(import.meta.url)), `${name}.ts`);

const writePromptFile = (
  stateRoot: string,
  name: string,
  prompt: string,
): string => {
  const path = join(stateRoot, "prompts", `${name}.txt`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, prompt);
  return path;
};

const piCommand = (
  dependencies: ForemanDependencies,
  role: "worker" | "verifier",
  record: Pick<TaskRecord, "id" | "name" | "provider" | "model"> & {
    sessionId?: string;
  },
  promptFile: string,
  options: { resume?: boolean } = {},
): string =>
  buildPiLaunchCommand(
    role,
    record,
    dependencies.extensionPath(role),
    promptFile,
    options,
  );

const createDetachedWorktree = (
  dependencies: ForemanDependencies,
  cwd: string,
  id: string,
  revision: string,
): Result<TaskPlacement> => {
  const resolved = resolveRepositoryCommand(cwd);
  const root = dependencies.commands.run(resolved.executable, resolved.args);
  if (!root.ok)
    return fail(
      `git-worktree placement requires a Git repository: ${root.error.message}`,
    );
  const path = join(dependencies.stateRoot, "worktrees", id);
  mkdirSync(dirname(path), { recursive: true });
  const command = addWorktreeCommand(root.value, path, revision);
  const added = dependencies.commands.run(command.executable, command.args);
  return added.ok
    ? ok({ kind: "git-worktree", path, repoRoot: root.value, revision })
    : fail(added.error.message, added.error.code);
};

const removeDetachedWorktree = (
  commands: ForemanCommandRunner,
  placement: TaskPlacement,
): Result<void> => {
  if (placement.kind !== "git-worktree") return ok(undefined);
  const command = removeWorktreeCommand(placement.repoRoot, placement.path);
  const removed = commands.run(command.executable, command.args);
  return removed.ok ? ok(undefined) : removed;
};

const createTaskTab = (
  commands: ForemanCommandRunner,
  workspaceId: string,
  cwd: string,
  id: string,
): Result<{ tabId: string; paneId: string }> => {
  const command = createTaskTabCommand(workspaceId, cwd, id);
  const created = commands.runJson(command.executable, command.args);
  if (!created.ok) return created;
  const value = created.value as {
    tab?: { tab_id?: string };
    root_pane?: { pane_id?: string; tab_id?: string };
    pane?: { pane_id?: string; tab_id?: string };
  };
  const pane = value.root_pane ?? value.pane;
  const paneId = pane?.pane_id;
  const tabId = value.tab?.tab_id ?? pane?.tab_id;
  return paneId && tabId
    ? ok({ paneId, tabId })
    : fail(
        `herdr tab create returned no tab/pane id: ${JSON.stringify(value)}`,
      );
};

const startWorker = async (
  dependencies: ForemanDependencies,
  record: TaskRecord,
  options: { resume?: boolean } = {},
): Promise<Result<void>> => {
  const promptFile = options.resume
    ? ""
    : writePromptFile(dependencies.stateRoot, record.id, record.prompt);
  const command = runPaneCommand(
    record.workerPaneId,
    piCommand(
      dependencies,
      "worker",
      { ...record, sessionId: record.workerSessionId },
      promptFile,
      options,
    ),
  );
  return runHerdrNoOutputRetryingPaneBusy(dependencies.commands, command.args);
};

const verifierPrompt = (record: TaskRecord, context: string): string =>
  [
    `Task ${record.id}.`,
    `Original request: ${record.prompt}`,
    `Foreman verification request: ${context}`,
    "",
    "Independently verify the identified artifact, claim, or result against the request. Inspect the relevant evidence and run appropriate checks. Do not implement fixes. Record detailed findings on the artifact's natural durable surface when one exists; otherwise include them in your verdict context. Then call verifier_signal with approve, deny, or flag.",
  ].join("\n");

const startVerifier = async (
  dependencies: ForemanDependencies,
  record: TaskRecord,
  context: string,
): Promise<Result<{ paneId: string; reused: boolean }>> => {
  const disposition = verifierDisposition(record.verifierPaneId);
  if (disposition.kind === "reuse") {
    dependencies.queueInbox(disposition.paneId, {
      customType: "foreman-verifier-directive",
      content: `New verification request for task ${record.id}:\n${context}`,
      details: { taskId: record.id, context },
      triggerTurn: true,
      deliverAs: "steer",
    });
    return ok({ paneId: disposition.paneId, reused: true });
  }

  const splitCommand = splitVerifierPaneCommand(
    record.workerPaneId,
    record.cwd,
  );
  const split = dependencies.commands.runJson(
    splitCommand.executable,
    splitCommand.args,
  );
  if (!split.ok) return split;
  const paneId = (split.value as { pane?: { pane_id?: string } }).pane?.pane_id;
  if (!paneId)
    return fail(
      `herdr pane split returned no pane id: ${JSON.stringify(split.value)}`,
    );

  const promptFile = writePromptFile(
    dependencies.stateRoot,
    `${record.id}-verifier`,
    verifierPrompt(record, context),
  );
  const verifierSessionId = dependencies.newSessionId();
  const paneRun = runPaneCommand(
    paneId,
    piCommand(
      dependencies,
      "verifier",
      { ...record, sessionId: verifierSessionId },
      promptFile,
    ),
  );
  const launched = await runHerdrNoOutputRetryingPaneBusy(
    dependencies.commands,
    paneRun.args,
  );
  if (!launched.ok) return launched;

  record.verifierPaneId = paneId;
  record.verifierSessionId = verifierSessionId;
  writeTaskRecord(dependencies.stateRoot, record);
  writePaneRegistration(
    dependencies.stateRoot,
    record,
    record.workerPaneId,
    "worker",
  );
  writePaneRegistration(dependencies.stateRoot, record, paneId, "verifier");
  return ok({ paneId, reused: false });
};

const haltWorker = (
  commands: ForemanCommandRunner,
  paneId: string,
): Result<void> => {
  const command = haltPaneCommand(paneId);
  const result = commands.runJson(command.executable, command.args);
  return result.ok ? ok(undefined) : result;
};

const sendOsNotification = (
  commands: ForemanCommandRunner,
  message: string,
): Result<void> => {
  if (process.platform === "darwin") {
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const sent = commands.run("osascript", [
      "-e",
      `display notification "${escaped}" with title "Foreman" sound name "Glass"`,
    ]);
    return sent.ok ? ok(undefined) : sent;
  }
  if (process.platform === "linux") {
    const sent = commands.run("notify-send", ["Foreman", message]);
    return sent.ok ? ok(undefined) : sent;
  }
  return fail(`no notifier for platform ${process.platform}`);
};

const listTaskIds = (stateRoot: string): string[] => {
  try {
    return readdirSync(join(stateRoot, "tasks"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => readTaskRecord(stateRoot, id) !== undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const recoveryDirective = (
  role: "worker" | "verifier",
  taskId: string,
): Parameters<typeof queueInboxMessage>[1] => ({
  customType: `foreman-${role}-directive`,
  content:
    `Your ${role} session for task ${taskId} was restarted by Foreman recovery. ` +
    "The transcript is intact but the previous turn may have been interrupted. " +
    "Re-read your working surface (files, PR, prior signals), then send a fresh " +
    `${role === "worker" ? "worker_signal (planned/done/flag)" : "verifier_signal (approve/deny/flag)"} ` +
    "reflecting current status before continuing.",
  details: { taskId, recovery: true },
  triggerTurn: true,
  deliverAs: "steer",
});

interface RoleRecoveryOutcome {
  role: "worker" | "verifier";
  paneId: string;
  action: "already-live" | "resumed-in-place" | "recreated-tab" | "failed";
  detail?: string;
}

const resumeRoleInPane = async (
  dependencies: ForemanDependencies,
  record: TaskRecord,
  role: "worker" | "verifier",
  paneId: string,
  sessionId: string,
): Promise<Result<void>> => {
  const command = runPaneCommand(
    paneId,
    piCommand(dependencies, role, { ...record, sessionId }, "", {
      resume: true,
    }),
  );
  const launched = await runHerdrNoOutputRetryingPaneBusy(
    dependencies.commands,
    command.args,
  );
  if (!launched.ok) return launched;
  dependencies.queueInbox(paneId, recoveryDirective(role, record.id));
  return ok(undefined);
};

const recoverRole = async (
  dependencies: ForemanDependencies,
  record: TaskRecord,
  role: "worker" | "verifier",
  paneId: string,
  sessionId: string,
  livePanes: ReadonlySet<string>,
): Promise<RoleRecoveryOutcome> => {
  if (livePanes.has(paneId)) return { role, paneId, action: "already-live" };

  const paneCheck = paneGetCommand(paneId);
  const paneExists = dependencies.commands.runJson(
    paneCheck.executable,
    paneCheck.args,
  );
  if (paneExists.ok) {
    const resumed = await resumeRoleInPane(
      dependencies,
      record,
      role,
      paneId,
      sessionId,
    );
    return resumed.ok
      ? { role, paneId, action: "resumed-in-place" }
      : { role, paneId, action: "failed", detail: resumed.error.message };
  }

  // A verifier whose pane is gone is recreated on demand through start_verifier;
  // recovery only rebuilds the load-bearing Worker tab.
  if (role === "verifier")
    return {
      role,
      paneId,
      action: "failed",
      detail: "verifier pane is gone; call start_verifier to recreate it",
    };

  const tab = createTaskTab(
    dependencies.commands,
    record.workspaceId,
    record.cwd,
    record.id,
  );
  if (!tab.ok)
    return {
      role,
      paneId,
      action: "failed",
      detail: `worker pane is gone and tab recreation failed: ${tab.error.message}`,
    };
  record.tabId = tab.value.tabId;
  record.workerPaneId = tab.value.paneId;
  const resumed = await resumeRoleInPane(
    dependencies,
    record,
    role,
    tab.value.paneId,
    sessionId,
  );
  return resumed.ok
    ? { role, paneId: tab.value.paneId, action: "recreated-tab" }
    : {
        role,
        paneId: tab.value.paneId,
        action: "failed",
        detail: resumed.error.message,
      };
};

const recoverTask = async (
  dependencies: ForemanDependencies,
  record: TaskRecord,
): Promise<Result<{ id: string; roles: RoleRecoveryOutcome[] }>> => {
  const list = agentListCommand();
  const agents = dependencies.commands.runJson(list.executable, list.args);
  if (!agents.ok)
    return fail(
      `cannot assess child liveness: herdr agent list failed: ${agents.error.message}`,
    );
  const livePanes = parseLiveAgentPanes(agents.value);

  const roles: RoleRecoveryOutcome[] = [
    await recoverRole(
      dependencies,
      record,
      "worker",
      record.workerPaneId,
      record.workerSessionId,
      livePanes,
    ),
  ];
  if (record.verifierPaneId && record.verifierSessionId)
    roles.push(
      await recoverRole(
        dependencies,
        record,
        "verifier",
        record.verifierPaneId,
        record.verifierSessionId,
        livePanes,
      ),
    );

  writeTaskRecord(dependencies.stateRoot, record);
  writePaneRegistration(
    dependencies.stateRoot,
    record,
    record.workerPaneId,
    "worker",
  );
  if (record.verifierPaneId)
    writePaneRegistration(
      dependencies.stateRoot,
      record,
      record.verifierPaneId,
      "verifier",
    );
  return ok({ id: record.id, roles });
};

const toolResult = (text: string, details?: unknown, isError?: boolean) => ({
  content: [{ type: "text" as const, text }],
  details,
  isError,
});

const createTaskTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "create_task",
    label: "Create Task",
    description:
      "Create a Task Thread as a tab in the Foreman workspace and start its Worker. Explicitly choose the shared current directory or a detached Git worktree; the Worker owns any branch or PR decision.",
    promptSnippet: "Create a Worker Task Thread with intentional placement",
    parameters: Type.Object({
      name: Type.String({ description: "Short human-readable task name" }),
      prompt: Type.String({ description: "Task instructions for the Worker" }),
      placement: Type.Union([
        Type.Object({ kind: Type.Literal("shared") }),
        Type.Object({
          kind: Type.Literal("git-worktree"),
          revision: Type.Optional(
            Type.String({
              description: "Commit-ish to detach at; defaults to HEAD",
            }),
          ),
        }),
      ]),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (!workspaceId)
        return toolResult(
          "create_task requires Foreman to run inside a Herdr workspace (HERDR_WORKSPACE_ID is missing).",
          undefined,
          true,
        );

      const id = taskId(params.name, dependencies.newId());
      const placement =
        params.placement.kind === "shared"
          ? ok<TaskPlacement>(sharedPlacement(ctx.cwd))
          : createDetachedWorktree(
              dependencies,
              ctx.cwd,
              id,
              params.placement.revision ?? "HEAD",
            );
      if (!placement.ok)
        return toolResult(
          `Failed to prepare ${params.placement.kind} placement: ${placement.error.message}`,
          undefined,
          true,
        );

      const tab = createTaskTab(
        dependencies.commands,
        workspaceId,
        placement.value.path,
        id,
      );
      if (!tab.ok) {
        const rollback = removeDetachedWorktree(
          dependencies.commands,
          placement.value,
        );
        return toolResult(
          describeTabFailure(
            tab.error.message,
            rollback.ok ? undefined : rollback.error.message,
          ),
          undefined,
          true,
        );
      }

      const record: TaskRecord = {
        id,
        name: params.name,
        prompt: params.prompt,
        cwd: placement.value.path,
        placement: placement.value,
        workspaceId,
        tabId: tab.value.tabId,
        workerPaneId: tab.value.paneId,
        workerSessionId: dependencies.newSessionId(),
        foremanPaneId: process.env.HERDR_PANE_ID,
        provider: process.env.PI_PROVIDER,
        model: process.env.PI_MODEL,
        createdAt: dependencies.now(),
      };
      writeTaskRecord(dependencies.stateRoot, record);
      writePaneRegistration(
        dependencies.stateRoot,
        record,
        record.workerPaneId,
        "worker",
      );

      const started = await startWorker(dependencies, record);
      if (!started.ok)
        return toolResult(
          `Task ${id} is tracked in tab ${record.tabId}, but Worker launch failed: ${started.error.message}`,
          record,
          true,
        );

      return toolResult(
        `Created task ${id} in tab ${record.tabId}, pane ${record.workerPaneId}, using ${record.placement.kind} placement at ${record.cwd}.`,
        record,
      );
    },
  });

const messageWorkerTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "message_worker",
    label: "Message Worker",
    description:
      "Send contextual input or a new instruction to an existing task's Worker through its structured inbox. This does not imply a lifecycle transition.",
    promptSnippet: "Send a safe contextual message to a Worker",
    parameters: Type.Object({
      id: Type.String({ description: "Task id returned by create_task" }),
      context: Type.String({
        description: "Instruction or context for the Worker",
      }),
    }),
    async execute(_toolCallId, params) {
      const record = readTaskRecord(dependencies.stateRoot, params.id);
      if (!record)
        return toolResult(
          `No task found with id ${params.id}`,
          undefined,
          true,
        );
      const message = dependencies.queueInbox(record.workerPaneId, {
        customType: "foreman-worker-directive",
        content: `Foreman message for task ${record.id}:\n${params.context}`,
        details: { taskId: record.id, context: params.context },
        triggerTurn: true,
        deliverAs: "steer",
      });
      return toolResult(
        `Queued message ${message.id} for task ${record.id}'s Worker.`,
        { task: record, message },
      );
    },
  });

const startVerifierTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "start_verifier",
    label: "Start or Reuse Verifier",
    description:
      "Contextually request independent verification of any artifact, claim, or result. Starts a persistent Verifier in the task tab or reuses the existing one.",
    promptSnippet: "Choose and describe independent verification",
    parameters: Type.Object({
      id: Type.String({ description: "Task id returned by create_task" }),
      context: Type.String({
        description:
          "What should be verified, where its evidence lives, and what correctness means here",
      }),
    }),
    async execute(_toolCallId, params) {
      const record = readTaskRecord(dependencies.stateRoot, params.id);
      if (!record)
        return toolResult(
          `No task found with id ${params.id}`,
          undefined,
          true,
        );
      const started = await startVerifier(dependencies, record, params.context);
      if (!started.ok)
        return toolResult(
          `Failed to start or message Verifier: ${started.error.message}`,
          undefined,
          true,
        );
      return toolResult(
        `${started.value.reused ? "Messaged existing" : "Started"} Verifier for task ${params.id} in pane ${started.value.paneId}.`,
        { task: record, ...started.value },
      );
    },
  });

const haltWorkerTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "halt_worker",
    label: "Halt Worker",
    description:
      "Interrupt a Worker's current turn with Escape. The Task Thread and session remain available.",
    promptSnippet: "Interrupt a Worker's current turn",
    parameters: Type.Object({
      id: Type.String({ description: "Task id returned by create_task" }),
    }),
    async execute(_toolCallId, params) {
      const record = readTaskRecord(dependencies.stateRoot, params.id);
      if (!record)
        return toolResult(
          `No task found with id ${params.id}`,
          undefined,
          true,
        );
      const halted = haltWorker(dependencies.commands, record.workerPaneId);
      return halted.ok
        ? toolResult(`Sent halt to task ${params.id}'s Worker.`, record)
        : toolResult(
            `Failed to halt task ${params.id}: ${halted.error.message}`,
            undefined,
            true,
          );
    },
  });

const describeRoleOutcome = (outcome: RoleRecoveryOutcome): string => {
  const suffix = outcome.detail ? ` (${outcome.detail})` : "";
  return `${outcome.role} ${outcome.action} in pane ${outcome.paneId}${suffix}`;
};

const recoverTaskTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "recover_task",
    label: "Recover Task Children",
    description:
      "Rebootstrap the Worker (and any Verifier) for one task, or every task on disk when id is omitted. Live children are left alone; a dead child is resumed into its existing pane by pi session id, or its Worker tab is recreated if the pane is gone. Each recovered child receives a re-orientation directive.",
    promptSnippet: "Rebootstrap dead task children after a restart",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Task id to recover; omit to recover every task on disk",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const ids = params.id ? [params.id] : listTaskIds(dependencies.stateRoot);
      if (ids.length === 0)
        return toolResult(
          params.id
            ? `No task found with id ${params.id}`
            : "No tasks found on disk under ~/.foreman/tasks.",
          undefined,
          true,
        );

      const reports: Array<{ id: string; roles: RoleRecoveryOutcome[] }> = [];
      const errors: string[] = [];
      for (const id of ids) {
        const record = readTaskRecord(dependencies.stateRoot, id);
        if (!record) {
          errors.push(`${id}: no meta.json`);
          continue;
        }
        const recovered = await recoverTask(dependencies, record);
        if (recovered.ok) reports.push(recovered.value);
        else errors.push(`${id}: ${recovered.error.message}`);
      }

      const lines = reports.map(
        (report) =>
          `${report.id}: ${report.roles.map(describeRoleOutcome).join("; ")}`,
      );
      const anyFailure =
        errors.length > 0 ||
        reports.some((report) =>
          report.roles.some((role) => role.action === "failed"),
        );
      return toolResult(
        [...lines, ...errors.map((error) => `error ${error}`)].join("\n") ||
          "Nothing to recover.",
        { reports, errors },
        anyFailure || undefined,
      );
    },
  });

const flagTool = (dependencies: ForemanDependencies) =>
  defineTool({
    name: "flag",
    label: "Flag to Human",
    description:
      "Send a native OS notification when contextual judgment says the human's attention is required. Use sparingly.",
    promptSnippet: "Notify the human about a decision or risk",
    parameters: Type.Object({
      context: Type.String({
        description: "What needs human attention and why",
      }),
    }),
    async execute(_toolCallId, params) {
      const sent = sendOsNotification(dependencies.commands, params.context);
      return sent.ok
        ? toolResult(`Notified the human: ${params.context}`, {
            context: params.context,
            delivered: true,
          })
        : toolResult(
            `OS notification not delivered (${sent.error.message}). Flag context: ${params.context}`,
            { context: params.context, delivered: false },
            true,
          );
    },
  });

const FOREMAN_ROLE_PROMPT = readRole("foreman");

export const createForemanExtension =
  (dependencies: ForemanDependencies) =>
  (pi: ExtensionAPI): void => {
    pi.registerTool(createTaskTool(dependencies));
    pi.registerTool(messageWorkerTool(dependencies));
    pi.registerTool(startVerifierTool(dependencies));
    pi.registerTool(haltWorkerTool(dependencies));
    pi.registerTool(recoverTaskTool(dependencies));
    pi.registerTool(flagTool(dependencies));
    registerInbox(pi, process.env.HERDR_PANE_ID);

    pi.on("session_start", (event, ctx) => {
      const renamed = renameForemanTabAtStartup({
        reason: event.reason,
        tabId: process.env.HERDR_TAB_ID,
        rename: (tabId, label) => {
          const result = dependencies.commands.run("herdr", [
            "tab",
            "rename",
            tabId,
            label,
          ]);
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        },
      });
      if (renamed.kind === "failed")
        ctx.ui.notify(
          `Could not rename the Herdr tab to Foreman: ${renamed.message}`,
          "warning",
        );

      if (event.reason === "startup") {
        const taskCount = listTaskIds(dependencies.stateRoot).length;
        if (taskCount > 0)
          ctx.ui.notify(
            `${taskCount} Task Thread(s) on disk. After a restart, call recover_task to resume dead Workers/Verifiers.`,
            "info",
          );
      }
    });

    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${FOREMAN_ROLE_PROMPT}`,
    }));
  };

const productionDependencies: ForemanDependencies = {
  commands: { run: runCommand, runJson: runJsonCommand },
  stateRoot: join(homedir(), ".foreman"),
  now: Date.now,
  newId: () => Date.now().toString(36),
  newSessionId: randomUUID,
  extensionPath: productionExtensionPath,
  queueInbox: queueInboxMessage,
};

export default createForemanExtension(productionDependencies);
