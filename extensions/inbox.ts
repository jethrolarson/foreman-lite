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

const writeJsonIfAbsent = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
};

export const queueInboxMessage = (
  paneId: string,
  message: Omit<InboxMessage, "id"> & { id?: string },
): InboxMessage => {
  const queued: InboxMessage = {
    ...message,
    id: message.id ?? randomUUID(),
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

const deliverMessages = (
  pi: ExtensionAPI,
  paneId: string,
  ownerToken: string,
): void => {
  for (const path of undeliveredFiles(paneId)) {
    if (readOwner(paneId) !== ownerToken) return;
    const filename = basename(path);
    let message: InboxMessage;
    try {
      message = JSON.parse(readFileSync(path, "utf8")) as InboxMessage;
      if (!message.id || !message.customType || !message.content)
        throw new Error("missing required inbox message fields");
    } catch (error) {
      console.error(`foreman-lite inbox rejected ${path}: ${String(error)}`);
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
      console.error(`foreman-lite inbox delivery failed: ${String(error)}`);
      return;
    }
  }
};

const watchMessages = (
  paneId: string,
  deliver: () => void,
): FSWatcher | undefined => {
  try {
    const watcher = watch(messagesDir(paneId), deliver);
    watcher.on("error", (error) => {
      console.error(`foreman-lite inbox watch failed: ${String(error)}`);
      watcher.close();
    });
    return watcher;
  } catch (error) {
    console.error(`foreman-lite inbox watch unavailable: ${String(error)}`);
    return undefined;
  }
};

const startInboxSession = (
  pi: ExtensionAPI,
  paneId: string,
  session: { id: string; file: string | undefined },
): (() => void) => {
  const ownerToken = `${session.id}:${process.pid}:${randomUUID()}`;
  writeJsonAtomic(ownerPath(paneId), {
    token: ownerToken,
    sessionId: session.id,
    sessionFile: session.file,
    pid: process.pid,
    claimedAt: Date.now(),
  });
  mkdirSync(messagesDir(paneId), { recursive: true });

  const deliver = (): void => deliverMessages(pi, paneId, ownerToken);
  const watcher = watchMessages(paneId, deliver);
  const poller = setInterval(deliver, 1_000);
  poller.unref();
  deliver();

  return () => {
    watcher?.close();
    clearInterval(poller);
    if (readOwner(paneId) === ownerToken)
      rmSync(ownerPath(paneId), { force: true });
  };
};

export const registerInbox = (
  pi: ExtensionAPI,
  paneId: string | undefined,
): void => {
  if (!paneId) return;

  let stopCurrent = (): void => {};

  pi.on("session_start", (_event, ctx) => {
    stopCurrent();
    stopCurrent = startInboxSession(pi, paneId, {
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
    });
  });

  pi.on("session_shutdown", () => {
    stopCurrent();
    stopCurrent = (): void => {};
  });
};
