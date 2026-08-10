import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createForemanExtension,
  type CommandResult,
  type ForemanCommandRunner,
  type ForemanDependencies,
} from "./foreman.js";
import type { InboxMessage } from "./inbox.js";

type TestTool = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

const roots: string[] = [];
const environments = [
  "HERDR_WORKSPACE_ID",
  "HERDR_PANE_ID",
  "PI_PROVIDER",
  "PI_MODEL",
] as const;

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true }));
  environments.forEach((name) => delete process.env[name]);
});

const fail = <T>(message: string): CommandResult<T> => ({
  ok: false,
  error: { message },
});

const setup = (
  behavior?: (
    kind: "run" | "json",
    executable: string,
    args: string[],
  ) => CommandResult<string | Record<string, unknown>> | undefined,
) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foreman-execution-"));
  roots.push(stateRoot);
  const calls: Array<{
    kind: "run" | "json";
    executable: string;
    args: string[];
  }> = [];
  const invoke = <T>(
    kind: "run" | "json",
    executable: string,
    args: string[],
  ) => {
    calls.push({ kind, executable, args });
    const result = behavior?.(kind, executable, args);
    return (result ?? {
      ok: true,
      value: kind === "run" ? "" : {},
    }) as CommandResult<T>;
  };
  const commands: ForemanCommandRunner = {
    run: (executable, args) => invoke<string>("run", executable, args),
    runJson: (executable, args) =>
      invoke<Record<string, unknown>>("json", executable, args),
  };
  const queued: Array<{
    paneId: string;
    message: Omit<InboxMessage, "id" | "createdAt">;
  }> = [];
  const dependencies: ForemanDependencies = {
    commands,
    stateRoot,
    now: () => 100,
    newId: () => "fixed",
    extensionPath: (role) => `/extensions/${role}.ts`,
    queueInbox: (paneId, message) => {
      queued.push({ paneId, message });
      return { ...message, id: message.id ?? "message-id", createdAt: 101 };
    },
  };
  const tools: TestTool[] = [];
  const pi = {
    registerTool: (tool: TestTool) => tools.push(tool),
    on: () => {},
  } as unknown as ExtensionAPI;
  createForemanExtension(dependencies)(pi);
  const tool = (name: string) =>
    tools.find((candidate) => candidate.name === name)!;
  const execute = (name: string, params: unknown, cwd = "/shared") =>
    tool(name).execute("call", params, undefined, undefined, { cwd });
  return { stateRoot, calls, queued, execute };
};

const successfulCommands = (
  kind: "run" | "json",
  _executable: string,
  args: string[],
): CommandResult<string | Record<string, unknown>> | undefined => {
  if (kind === "json" && args[0] === "tab")
    return {
      ok: true,
      value: {
        tab: { tab_id: "tab-1" },
        root_pane: { pane_id: "worker-pane" },
      },
    };
  if (kind === "json" && args[0] === "pane" && args[1] === "split")
    return { ok: true, value: { pane: { pane_id: "verifier-pane" } } };
  return undefined;
};

const createSharedTask = async (state: ReturnType<typeof setup>) => {
  process.env.HERDR_WORKSPACE_ID = "workspace";
  process.env.HERDR_PANE_ID = "foreman-pane";
  const result = await state.execute("create_task", {
    name: "Task",
    prompt: "Do work",
    placement: { kind: "shared" },
  });
  expect(result.isError).not.toBe(true);
  return "task-fixed";
};

describe("Foreman execution through an injected command runner", () => {
  it("creates shared placement without executing Git", async () => {
    const state = setup(successfulCommands);
    await createSharedTask(state);
    expect(state.calls.some(({ executable }) => executable === "git")).toBe(
      false,
    );
    expect(state.calls).toContainEqual(
      expect.objectContaining({
        executable: "herdr",
        args: expect.arrayContaining([
          "--workspace",
          "workspace",
          "--cwd",
          "/shared",
          "--env",
          "FOREMAN_TASK_ID=task-fixed",
        ]),
      }),
    );
  });

  it("rolls a worktree back after tab failure and exposes rollback failure", async () => {
    const state = setup((kind, executable, args) => {
      if (kind === "run" && executable === "git" && args.includes("rev-parse"))
        return { ok: true, value: "/repo" };
      if (kind === "json" && args[0] === "tab") return fail("tab failed");
      if (kind === "run" && executable === "git" && args.includes("remove"))
        return fail("rollback failed");
      return undefined;
    });
    process.env.HERDR_WORKSPACE_ID = "workspace";
    const result = await state.execute(
      "create_task",
      { name: "Task", prompt: "Do work", placement: { kind: "git-worktree" } },
      "/repo/subdir",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Worktree rollback also failed: rollback failed",
    );
    expect(state.calls.some(({ args }) => args.includes("remove"))).toBe(true);
  });

  it("routes message_worker to the recorded Worker pane", async () => {
    const state = setup(successfulCommands);
    const id = await createSharedTask(state);
    await state.execute("message_worker", { id, context: "new direction" });
    expect(state.queued).toContainEqual({
      paneId: "worker-pane",
      message: expect.objectContaining({
        customType: "foreman-worker-directive",
        details: { taskId: id, context: "new direction" },
      }),
    });
  });

  it("creates one Verifier then reuses it for arbitrary non-PR context", async () => {
    const state = setup(successfulCommands);
    const id = await createSharedTask(state);
    const context = "Verify the prose answer against the supplied arithmetic.";
    const first = await state.execute("start_verifier", { id, context });
    const second = await state.execute("start_verifier", {
      id,
      context: "Check the revised prose too.",
    });
    expect(first.content[0].text).toContain("Started Verifier");
    expect(second.content[0].text).toContain("Messaged existing Verifier");
    expect(
      state.calls.filter(
        ({ kind, args }) =>
          kind === "json" && args[0] === "pane" && args[1] === "split",
      ),
    ).toHaveLength(1);
    expect(
      readFileSync(
        join(state.stateRoot, "prompts", `${id}-verifier.txt`),
        "utf8",
      ),
    ).toContain(context);
    expect(state.queued.at(-1)).toMatchObject({ paneId: "verifier-pane" });
  });

  it("halts the recorded Worker pane without mutating lifecycle state", async () => {
    const state = setup(successfulCommands);
    const id = await createSharedTask(state);
    const meta = join(state.stateRoot, "tasks", id, "meta.json");
    const before = readFileSync(meta, "utf8");
    await state.execute("halt_worker", { id });
    expect(state.calls.at(-1)).toMatchObject({
      kind: "json",
      executable: "herdr",
      args: ["agent", "send-keys", "worker-pane", "esc"],
    });
    expect(readFileSync(meta, "utf8")).toBe(before);
    expect(() =>
      readFileSync(join(state.stateRoot, "tasks", id, "events.jsonl")),
    ).toThrow();
  });
});
