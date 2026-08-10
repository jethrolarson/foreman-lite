import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createInboxLifecycle } from "./inbox.js";
import type { InboxProtocol } from "./inboxProtocol.js";

const setup = (watchThrows = false) => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: unknown[] = [];
  const pi = {
    on: (name: string, handler: (...args: never[]) => void) =>
      handlers.set(name, handler),
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  let queued = true;
  const release = vi.fn();
  const drain = vi.fn((_pane, _owner, send: (message: never) => void) => {
    if (!queued) return;
    queued = false;
    send({
      customType: "kind",
      content: "body",
      details: { x: 1 },
      triggerTurn: true,
      deliverAs: "steer",
    } as never);
  });
  const protocol = {
    paths: () => ({
      root: "/root",
      messages: "/messages",
      delivered: "/delivered",
      failed: "/failed",
      owner: "/owner",
    }),
    claim: () => "owner",
    release,
    drain,
  } as unknown as InboxProtocol;
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(),
  }) as unknown as FSWatcher;
  let watchedDrain = () => {};
  let polledDrain = () => {};
  const pollClose = vi.fn();
  createInboxLifecycle(pi, "pane", protocol, {
    watchMessages: (_path, callback) => {
      if (watchThrows) throw new Error("watch unavailable");
      watchedDrain = callback;
      return watcher;
    },
    startPolling: (callback) => {
      polledDrain = callback;
      return { close: pollClose };
    },
  });
  const manager = {
    getSessionId: () => "session",
    getSessionFile: () => undefined,
  };
  return {
    handlers,
    sent,
    drain,
    release,
    watcher,
    pollClose,
    manager,
    watched: () => watchedDrain(),
    poll: () => polledDrain(),
  };
};

describe("inbox lifecycle adapter", () => {
  it("drains existing messages at startup and preserves custom message fields", () => {
    const state = setup();
    state.handlers.get("session_start")?.(
      {} as never,
      { sessionManager: state.manager } as never,
    );
    expect(state.sent).toEqual([
      [
        {
          customType: "kind",
          content: "body",
          display: true,
          details: { x: 1 },
        },
        { triggerTurn: true, deliverAs: "steer" },
      ],
    ]);
  });

  it("polls even when watcher setup fails", () => {
    const state = setup(true);
    state.handlers.get("session_start")?.(
      {} as never,
      { sessionManager: state.manager } as never,
    );
    state.poll();
    expect(state.drain).toHaveBeenCalledTimes(2);
  });

  it("watch notifications drain and shutdown closes resources and releases its claim", () => {
    const state = setup();
    state.handlers.get("session_start")?.(
      {} as never,
      { sessionManager: state.manager } as never,
    );
    state.watched();
    state.handlers.get("session_shutdown")?.({} as never);
    expect(state.drain).toHaveBeenCalledTimes(2);
    expect(state.watcher.close).toHaveBeenCalledOnce();
    expect(state.pollClose).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledWith("pane", "owner");
  });
});
