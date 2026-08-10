import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { queueInboxMessage, registerInbox } from "./inbox.js";
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
  verifierPaneId?: string;
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
  record: Pick<TaskRecord, "id" | "name" | "provider" | "model">,
  promptFile: string,
): string =>
  buildPiLaunchCommand(
    role,
    record,
    dependencies.extensionPath(role),
    promptFile,
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
): Promise<Result<void>> => {
  const promptFile = writePromptFile(
    dependencies.stateRoot,
    record.id,
    record.prompt,
  );
  const command = runPaneCommand(
    record.workerPaneId,
    piCommand(dependencies, "worker", record, promptFile),
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
  const paneRun = runPaneCommand(
    paneId,
    piCommand(dependencies, "verifier", record, promptFile),
  );
  const launched = await runHerdrNoOutputRetryingPaneBusy(
    dependencies.commands,
    paneRun.args,
  );
  if (!launched.ok) return launched;

  record.verifierPaneId = paneId;
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
    pi.registerTool(flagTool(dependencies));
    registerInbox(pi, process.env.HERDR_PANE_ID);

    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${FOREMAN_ROLE_PROMPT}`,
    }));
  };

const productionDependencies: ForemanDependencies = {
  commands: { run: runCommand, runJson: runJsonCommand },
  stateRoot: join(homedir(), ".foreman"),
  now: Date.now,
  newId: () => Date.now().toString(36),
  extensionPath: productionExtensionPath,
  queueInbox: queueInboxMessage,
};

export default createForemanExtension(productionDependencies);
