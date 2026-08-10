import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import foremanExtension from "./foreman.js";
import { createInboxLifecycle } from "./inbox.js";
import type { InboxProtocol } from "./inboxProtocol.js";
import workerExtension from "./worker.js";
import verifierExtension from "./verifier.js";

const createRunner = async (factory: (pi: ExtensionAPI) => void) => {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    extensionFactories: [factory],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const sessionManager = SessionManager.inMemory(process.cwd());
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    process.cwd(),
    sessionManager,
    {} as never,
  );
  const sent: Array<{ message: unknown; options: unknown }> = [];
  runner.bindCore(
    {
      sendMessage: (message: unknown, options: unknown) =>
        sent.push({ message, options }),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      getSessionName: vi.fn(),
      setLabel: vi.fn(),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: vi.fn(),
      refreshTools: vi.fn(),
      getCommands: () => [],
      setModel: vi.fn(),
      getThinkingLevel: () => "off",
      setThinkingLevel: vi.fn(),
    } as never,
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: vi.fn(),
      hasPendingMessages: () => false,
      shutdown: vi.fn(),
      getContextUsage: () => undefined,
      compact: vi.fn(),
      getSystemPrompt: () => "base",
    },
  );
  return { runner, sent, sessionManager };
};

const toolNames = (runner: ExtensionRunner) =>
  runner.getAllRegisteredTools().map(({ definition }) => definition.name);

afterEach(() => {
  delete process.env.FOREMAN_TASK_ID;
  delete process.env.HERDR_PANE_ID;
});

describe("Pi public SDK extension integration", () => {
  it("loads exactly the intended tools without a model call", async () => {
    expect(toolNames((await createRunner(foremanExtension)).runner)).toEqual([
      "create_task",
      "message_worker",
      "start_verifier",
      "halt_worker",
      "flag",
    ]);
    process.env.FOREMAN_TASK_ID = "sdk-task";
    expect(toolNames((await createRunner(workerExtension)).runner)).toEqual([
      "worker_signal",
    ]);
    expect(toolNames((await createRunner(verifierExtension)).runner)).toEqual([
      "verifier_signal",
    ]);
  });

  it("runs each role prompt hook through ExtensionRunner", async () => {
    const foreman = (await createRunner(foremanExtension)).runner;
    expect(
      (
        await foreman.emitBeforeAgentStart(
          "prompt",
          undefined,
          "base",
          {} as never,
        )
      )?.systemPrompt,
    ).toContain("Foreman");

    process.env.FOREMAN_TASK_ID = "sdk-task";
    for (const [extension, role] of [
      [workerExtension, "Worker"],
      [verifierExtension, "Verifier"],
    ] as const) {
      const runner = (await createRunner(extension)).runner;
      const prompt = await runner.emitBeforeAgentStart(
        "prompt",
        undefined,
        "base",
        {} as never,
      );
      expect(prompt?.systemPrompt).toContain("sdk-task");
      expect(prompt?.systemPrompt).toContain(role);
    }
  });

  it("runs inbox start/shutdown handlers and preserves custom message fields and options", async () => {
    const release = vi.fn();
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(),
    }) as unknown as FSWatcher;
    const pollClose = vi.fn();
    let delivered = false;
    const protocol = {
      paths: () => ({
        root: "/root",
        messages: "/messages",
        delivered: "/delivered",
        failed: "/failed",
        owner: "/owner",
      }),
      claim: () => "owner-token",
      release,
      drain: (
        _pane: string,
        _owner: string,
        send: (message: unknown) => void,
      ) => {
        if (delivered) return;
        delivered = true;
        send({
          customType: "sdk-custom",
          content: "structured content",
          details: { taskId: "task" },
          createdAt: 1,
          id: "message",
          triggerTurn: true,
          deliverAs: "followUp",
        });
      },
    } as unknown as InboxProtocol;
    const factory = (pi: ExtensionAPI) =>
      createInboxLifecycle(pi, "pane", protocol, {
        watchMessages: () => watcher,
        startPolling: () => ({ close: pollClose }),
      });
    const { runner, sent } = await createRunner(factory);
    await runner.emit({ type: "session_start", reason: "new" });
    expect(sent).toEqual([
      {
        message: {
          customType: "sdk-custom",
          content: "structured content",
          display: true,
          details: { taskId: "task" },
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      },
    ]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(pollClose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("pane", "owner-token");
  });
});
