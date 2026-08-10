import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InboxMessage {
  id: string;
  customType: string;
  content: string;
  details?: Record<string, unknown>;
  createdAt: number;
  triggerTurn: boolean;
  deliverAs: "steer" | "followUp" | "nextTurn";
}

const inboxRoot = (paneId: string): string =>
  join(homedir(), ".foreman", "inboxes", encodeURIComponent(paneId));

const messagesDir = (paneId: string): string =>
  join(inboxRoot(paneId), "messages");
const deliveredDir = (paneId: string): string =>
  join(inboxRoot(paneId), "delivered");
const failedDir = (paneId: string): string => join(inboxRoot(paneId), "failed");
const ownerPath = (paneId: string): string =>
  join(inboxRoot(paneId), "owner.json");

const writeJsonAtomic = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, path);
};

const writeJsonIfAbsent = (path: string, value: unknown): boolean => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
};

export const queueInboxMessage = (
  paneId: string,
  message: Omit<InboxMessage, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  },
): InboxMessage => {
  const queued: InboxMessage = {
    ...message,
    id: message.id ?? randomUUID(),
    createdAt: message.createdAt ?? Date.now(),
  };
  writeJsonIfAbsent(join(messagesDir(paneId), `${queued.id}.json`), queued);
  return queued;
};

const readOwner = (paneId: string): string | undefined => {
  try {
    return (
      JSON.parse(readFileSync(ownerPath(paneId), "utf8")) as {
        token?: string;
      }
    ).token;
  } catch {
    return undefined;
  }
};

const undeliveredFiles = (paneId: string): string[] => {
  try {
    return readdirSync(messagesDir(paneId))
      .filter((name) => name.endsWith(".json"))
      .filter(
        (name) =>
          !existsSync(join(deliveredDir(paneId), name)) &&
          !existsSync(join(failedDir(paneId), name)),
      )
      .sort()
      .map((name) => join(messagesDir(paneId), name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const registerInbox = (pi: ExtensionAPI, paneId: string | undefined) => {
  if (!paneId) return;

  let watcher: FSWatcher | undefined;
  let poller: NodeJS.Timeout | undefined;
  let ownerToken: string | undefined;
  let draining = false;
  let drainAgain = false;

  const ownsInbox = (): boolean =>
    ownerToken !== undefined && readOwner(paneId) === ownerToken;

  const drain = async (): Promise<void> => {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        for (const path of undeliveredFiles(paneId)) {
          if (!ownsInbox()) return;
          const filename = basename(path);
          let message: InboxMessage;
          try {
            message = JSON.parse(readFileSync(path, "utf8")) as InboxMessage;
            if (!message.id || !message.customType || !message.content)
              throw new Error("missing required inbox message fields");
          } catch (error) {
            console.error(
              `foreman-lite inbox rejected ${path}: ${String(error)}`,
            );
            writeJsonAtomic(join(failedDir(paneId), filename), {
              failedAt: Date.now(),
              error: String(error),
            });
            continue;
          }

          try {
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
            );
            writeJsonAtomic(join(deliveredDir(paneId), filename), {
              messageId: message.id,
              sessionOwner: ownerToken,
              deliveredAt: Date.now(),
            });
          } catch (error) {
            console.error(
              `foreman-lite inbox delivery failed: ${String(error)}`,
            );
            return;
          }
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  };

  const stop = (): void => {
    watcher?.close();
    watcher = undefined;
    if (poller) clearInterval(poller);
    poller = undefined;
    if (ownsInbox()) rmSync(ownerPath(paneId), { force: true });
    ownerToken = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    ownerToken = `${ctx.sessionManager.getSessionId()}:${process.pid}:${randomUUID()}`;
    writeJsonAtomic(ownerPath(paneId), {
      token: ownerToken,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      pid: process.pid,
      claimedAt: Date.now(),
    });
    mkdirSync(messagesDir(paneId), { recursive: true });

    try {
      watcher = watch(messagesDir(paneId), () => void drain());
      watcher.on("error", (error) => {
        console.error(`foreman-lite inbox watch failed: ${String(error)}`);
        watcher?.close();
        watcher = undefined;
      });
    } catch (error) {
      console.error(`foreman-lite inbox watch unavailable: ${String(error)}`);
    }

    poller = setInterval(() => void drain(), 1_000);
    poller.unref();
    void drain();
  });

  pi.on("session_shutdown", stop);
};
