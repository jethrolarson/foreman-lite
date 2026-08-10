import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createInboxProtocol,
  type InboxMessage,
  type InboxProtocol,
} from "./inboxProtocol.js";

export type { InboxMessage } from "./inboxProtocol.js";

export interface InboxLifecycleDependencies {
  watchMessages: (path: string, drain: () => void) => FSWatcher;
  startPolling: (drain: () => void) => { close: () => void };
}

export const createInboxLifecycle = (
  pi: ExtensionAPI,
  paneId: string,
  protocol: InboxProtocol,
  dependencies: InboxLifecycleDependencies,
) => {
  let stopCurrent = (): void => {};

  const stop = (): void => {
    stopCurrent();
    stopCurrent = (): void => {};
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    const ownerToken = protocol.claim(
      paneId,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile(),
    );
    const drain = () =>
      protocol.drain(paneId, ownerToken, (message) =>
        pi.sendMessage(
          {
            customType: message.customType,
            content: message.content,
            display: true,
            details: message.details,
          },
          {
            triggerTurn: message.triggerTurn,
            deliverAs: message.deliverAs,
          },
        ),
      );

    let watcher: FSWatcher | undefined;
    try {
      watcher = dependencies.watchMessages(
        protocol.paths(paneId).messages,
        drain,
      );
      watcher.on("error", (error) => {
        console.error(`foreman-lite inbox watch failed: ${String(error)}`);
        watcher?.close();
        watcher = undefined;
      });
    } catch (error) {
      console.error(`foreman-lite inbox watch unavailable: ${String(error)}`);
    }
    const poller = dependencies.startPolling(drain);
    drain();
    stopCurrent = () => {
      watcher?.close();
      poller.close();
      protocol.release(paneId, ownerToken);
    };
  });

  pi.on("session_shutdown", stop);
};

const productionProtocol = createInboxProtocol({
  stateRoot: join(homedir(), ".foreman"),
  now: Date.now,
  newId: randomUUID,
});

export const queueInboxMessage = (
  paneId: string,
  message: Omit<InboxMessage, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  },
): InboxMessage => productionProtocol.queue(paneId, message);

export const registerInbox = (
  pi: ExtensionAPI,
  paneId: string | undefined,
): void => {
  if (!paneId) return;
  createInboxLifecycle(pi, paneId, productionProtocol, {
    watchMessages: (path, drain) => watch(path, drain),
    startPolling: (drain) => {
      const timer = setInterval(drain, 1_000);
      timer.unref();
      return { close: () => clearInterval(timer) };
    },
  });
};
