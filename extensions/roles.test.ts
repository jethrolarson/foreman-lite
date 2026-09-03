import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import foremanExtension from "./foreman.js";
import workerExtension, {
  buildWorkerSignalTool,
  workerEndedWithModelFailure,
} from "./worker.js";
import verifierExtension, {
  verifierEndedWithModelFailure,
} from "./verifier.js";
import { taskIdFromEnvironment, taskStateDir } from "./taskState.js";

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
  content: toolName
    ? [{ type: "toolCall", name: toolName }]
    : [{ type: "text", text: "result" }],
});

afterEach(() => {
  delete process.env.FOREMAN_TASK_ID;
});

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
  ["Worker", workerExtension, "worker_signal", workerEndedWithModelFailure],
  [
    "Verifier",
    verifierExtension,
    "verifier_signal",
    verifierEndedWithModelFailure,
  ],
] as const)(
  "%s extension",
  (_label, extension, signalName, endedWithFailure) => {
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

    it("does not remind after provider errors or explicit aborts", () => {
      expect(endedWithFailure([assistant("error") as never])).toBe(true);
      expect(endedWithFailure([assistant("aborted") as never])).toBe(true);
      process.env.FOREMAN_TASK_ID = "task";
      const state = fakePi();
      extension(state.pi);
      state.handlers.get("agent_end")?.({
        messages: [assistant("error")],
      } as never);
      state.handlers.get("agent_end")?.({
        messages: [assistant("aborted")],
      } as never);
      expect(state.sent).toEqual([]);
    });

    it("bounds ordinary reminders and a signal resets the cycle", () => {
      process.env.FOREMAN_TASK_ID = "task";
      const state = fakePi();
      extension(state.pi);
      const end = state.handlers.get("agent_end");
      end?.({ messages: [assistant("stop")] } as never);
      end?.({ messages: [assistant("stop", signalName)] } as never);
      end?.({ messages: [assistant("stop")] } as never);
      end?.({ messages: [assistant("stop")] } as never);
      end?.({ messages: [assistant("stop")] } as never);
      end?.({ messages: [assistant("stop")] } as never);
      expect(
        state.sent.filter(({ options }) => options?.triggerTurn),
      ).toHaveLength(4);
      expect(state.sent.at(-1)?.options?.triggerTurn).toBe(false);
    });
  },
);

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
