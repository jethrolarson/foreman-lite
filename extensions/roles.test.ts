import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import foremanExtension from "./foreman.js";
import workerExtension, { buildWorkerSignalTool } from "./worker.js";
import verifierExtension from "./verifier.js";
import {
  taskEventsPath,
  taskIdFromEnvironment,
  taskStateDir,
} from "./taskState.js";

const fakePi = () => {
  const tools: Array<{ name: string }> = [];
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const sent: Array<{
    message: { customType: string };
    options?: { triggerTurn?: boolean };
  }> = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool),
    on: (name: string, handler: (...args: never[]) => unknown) =>
      handlers.set(name, handler),
    sendMessage: (
      message: { customType: string },
      options?: { triggerTurn?: boolean },
    ) => sent.push({ message, options }),
    events: { emit: vi.fn() },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers, sent };
};

const assistant = (
  stopReason: "stop" | "error" | "aborted",
  toolName?: string,
) => ({
  role: "assistant",
  stopReason,
  errorMessage: stopReason === "error" ? "429 insufficient balance" : undefined,
  content: toolName
    ? [{ type: "toolCall", name: toolName }]
    : [{ type: "text", text: "result" }],
});

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

const custom = (customType: string) => ({
  role: "custom",
  customType,
  content: "",
  display: true,
});

const homes: string[] = [];

afterEach(() => {
  delete process.env.FOREMAN_TASK_ID;
  vi.unstubAllEnvs();
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true }));
});

// Role extensions append to ~/.foreman; keep that under a throwaway HOME.
const isolatedHome = () => {
  const home = mkdtempSync(join(tmpdir(), "foreman-roles-"));
  homes.push(home);
  vi.stubEnv("HOME", home);
};

const recordedEvents = (taskId: string) => {
  try {
    return readFileSync(taskEventsPath(taskId), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

describe("task identity", () => {
  it("rejects missing and blank ids and keeps shared-directory ids distinct", () => {
    expect(() => taskIdFromEnvironment({})).toThrow(
      "FOREMAN_TASK_ID is required",
    );
    expect(() => taskIdFromEnvironment({ FOREMAN_TASK_ID: "  " })).toThrow(
      "FOREMAN_TASK_ID is required",
    );
    expect(taskStateDir("one")).not.toBe(taskStateDir("two"));
  });

  it("accepts prose, path, commit, and PR-shaped done context without a PR field", () => {
    const tool = buildWorkerSignalTool(fakePi().pi, "task");
    for (const context of [
      "The answer is 42.",
      "Report at docs/report.md",
      "Commit abc123 is ready",
      "PR https://example.test/pull/1",
    ])
      expect(Value.Check(tool.parameters, { action: "done", context })).toBe(
        true,
      );
  });
});

describe.each([
  ["worker", workerExtension, "worker_signal"],
  ["verifier", verifierExtension, "verifier_signal"],
] as const)("%s extension", (role, extension, signalName) => {
  it("registers only its signal and appends role plus task id to the prompt", () => {
    process.env.FOREMAN_TASK_ID = "task-7";
    const state = fakePi();
    extension(state.pi);
    expect(state.tools.map(({ name }) => name)).toEqual([signalName]);
    const result = state.handlers.get("before_agent_start")?.({
      systemPrompt: "base",
    } as never);
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("task-7"),
    });
  });

  const started = () => {
    isolatedHome();
    process.env.FOREMAN_TASK_ID = "task";
    const state = fakePi();
    extension(state.pi);
    const handler = (name: string) => (event: unknown) =>
      state.handlers.get(name)?.(event as never);
    const run = (messages: unknown[]) => {
      handler("agent_end")({ messages });
      handler("agent_settled")({});
    };
    handler("session_start")({ reason: "startup" });
    return { state, run, handler };
  };

  it("reports an unsignaled task stop with the final reply, never nagging", () => {
    const { state, run } = started();
    run([user("do the task"), assistant("stop")]);
    expect(recordedEvents("task")).toMatchObject([
      { role, action: "stopped", context: "result" },
    ]);
    expect(state.sent).toEqual([]);
  });

  it("reports provider errors and skips signaled or aborted runs", () => {
    const { run } = started();
    run([user("do the task"), assistant("stop", signalName)]);
    run([custom("directive"), assistant("aborted")]);
    run([custom("directive"), assistant("error")]);
    expect(recordedEvents("task").map(({ context }) => context)).toEqual([
      "Provider error: 429 insufficient balance",
    ]);
  });

  it("waits for settlement, reporting only the last run before idle", () => {
    const { handler } = started();
    handler("agent_end")({
      messages: [user("do the task"), assistant("error")],
    });
    // pi auto-retries; the retry run ends before the session settles.
    handler("agent_end")({ messages: [assistant("stop", signalName)] });
    handler("agent_settled")({});
    expect(recordedEvents("task")).toEqual([]);
  });

  it("stays silent when an attached human, not the task, started the run", () => {
    const { run } = started();
    run([user("do the task"), assistant("stop", signalName)]);
    run([user("why this approach?"), assistant("stop")]);
    expect(recordedEvents("task")).toEqual([]);
  });

  it("does not treat a run after /reload as the launch prompt", () => {
    const { run, handler } = started();
    run([user("do the task"), assistant("stop", signalName)]);
    handler("session_start")({ reason: "reload" });
    run([user("quick question?"), assistant("stop")]);
    expect(recordedEvents("task")).toEqual([]);
  });
});

describe("Foreman extension authority", () => {
  it("registers exactly the intended tools and appends its role prompt", () => {
    const state = fakePi();
    foremanExtension(state.pi);
    expect(state.tools.map(({ name }) => name)).toEqual([
      "create_task",
      "message_worker",
      "start_verifier",
      "halt_worker",
      "recover_task",
      "flag",
    ]);
    const result = state.handlers.get("before_agent_start")?.({
      systemPrompt: "base",
    } as never);
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Foreman"),
    });
  });
});
