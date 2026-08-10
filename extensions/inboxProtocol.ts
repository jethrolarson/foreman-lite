import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface InboxMessage {
  id: string;
  customType: string;
  content: string;
  details?: Record<string, unknown>;
  createdAt: number;
  triggerTurn: boolean;
  deliverAs: "steer" | "followUp" | "nextTurn";
}

export interface InboxDependencies {
  stateRoot: string;
  now: () => number;
  newId: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface InboxProtocol {
  paths: (paneId: string) => {
    root: string;
    messages: string;
    delivered: string;
    failed: string;
    delivering: string;
    owner: string;
  };
  queue: (
    paneId: string,
    message: Omit<InboxMessage, "id" | "createdAt"> & {
      id?: string;
      createdAt?: number;
    },
  ) => InboxMessage;
  claim: (paneId: string, sessionId: string, sessionFile?: string) => string;
  release: (paneId: string, ownerToken: string) => void;
  drain: (
    paneId: string,
    ownerToken: string,
    send: (message: InboxMessage) => void,
  ) => void;
}

const readJsonOptional = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeJsonAtomic = (path: string, value: unknown, newId: () => string) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${newId()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, path);
};

const writeJsonIfAbsent = (
  path: string,
  value: unknown,
  newId: () => string,
): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${newId()}.tmp`;
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

const DELIVERY_MODES = new Set(["steer", "followUp", "nextTurn"]);

const validMessage = (value: unknown): value is InboxMessage => {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<InboxMessage>;
  return (
    typeof message.id === "string" &&
    message.id.length > 0 &&
    typeof message.customType === "string" &&
    message.customType.length > 0 &&
    typeof message.content === "string" &&
    message.content.length > 0 &&
    typeof message.createdAt === "number" &&
    typeof message.triggerTurn === "boolean" &&
    typeof message.deliverAs === "string" &&
    DELIVERY_MODES.has(message.deliverAs) &&
    (message.details === undefined ||
      (typeof message.details === "object" && message.details !== null))
  );
};

export const createInboxProtocol = ({
  stateRoot,
  now,
  newId,
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
}: InboxDependencies): InboxProtocol => {
  const paths = (paneId: string) => {
    const root = join(stateRoot, "inboxes", encodeURIComponent(paneId));
    return {
      root,
      messages: join(root, "messages"),
      delivered: join(root, "delivered"),
      failed: join(root, "failed"),
      delivering: join(root, "delivering"),
      owner: join(root, "owner.json"),
    };
  };

  const claimPath = (paneId: string, token: string) =>
    join(paths(paneId).root, "owners", `${encodeURIComponent(token)}.json`);
  const ownerToken = (paneId: string): string | undefined =>
    readJsonOptional<{ token?: string }>(paths(paneId).owner)?.token;
  const owns = (paneId: string, token: string): boolean =>
    ownerToken(paneId) === token && existsSync(claimPath(paneId, token));

  const reclaimDeadLease = (lease: string): void => {
    const candidate = `${lease}.${process.pid}.${newId()}.reclaim`;
    try {
      linkSync(lease, candidate);
      const current = statSync(lease);
      const linked = statSync(candidate);
      if (current.dev === linked.dev && current.ino === linked.ino)
        rmSync(lease, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      rmSync(candidate, { force: true });
    }
  };

  const acquireDelivery = (
    paneId: string,
    filename: string,
    token: string,
  ): string | undefined => {
    const lease = join(paths(paneId).delivering, filename);
    mkdirSync(dirname(lease), { recursive: true });
    const temporary = `${lease}.${process.pid}.${newId()}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ token, pid: process.pid, acquiredAt: now() })}\n`,
      { flag: "wx" },
    );
    try {
      linkSync(temporary, lease);
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const holder = readJsonOptional<{ pid?: number }>(lease);
        if (typeof holder?.pid === "number" && !isProcessAlive(holder.pid)) {
          reclaimDeadLease(lease);
          return acquireDelivery(paneId, filename, token);
        }
        return undefined;
      }
      throw error;
    } finally {
      unlinkSync(temporary);
    }
  };

  const undelivered = (paneId: string): string[] => {
    const location = paths(paneId);
    try {
      return readdirSync(location.messages)
        .filter((name) => name.endsWith(".json"))
        .filter(
          (name) =>
            !existsSync(join(location.delivered, name)) &&
            !existsSync(join(location.failed, name)),
        )
        .sort()
        .map((name) => join(location.messages, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  return {
    paths,
    queue: (paneId, message) => {
      const queued: InboxMessage = {
        ...message,
        id: message.id ?? newId(),
        createdAt: message.createdAt ?? now(),
      };
      writeJsonIfAbsent(
        join(paths(paneId).messages, `${queued.id}.json`),
        queued,
        newId,
      );
      return queued;
    },
    claim: (paneId, sessionId, sessionFile) => {
      const token = `${sessionId}:${newId()}`;
      const claim = {
        token,
        sessionId,
        sessionFile,
        pid: process.pid,
        claimedAt: now(),
      };
      writeJsonAtomic(claimPath(paneId, token), claim, newId);
      writeJsonAtomic(paths(paneId).owner, claim, newId);
      mkdirSync(paths(paneId).messages, { recursive: true });
      return token;
    },
    release: (paneId, token) => {
      rmSync(claimPath(paneId, token), { force: true });
    },
    drain: (paneId, token, send) => {
      const location = paths(paneId);
      for (const path of undelivered(paneId)) {
        if (!owns(paneId, token)) return;
        const filename = basename(path);
        const lease = acquireDelivery(paneId, filename, token);
        if (!lease) continue;
        let message: InboxMessage;
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (!validMessage(parsed))
            throw new Error("missing required inbox message fields");
          message = parsed;
        } catch (error) {
          writeJsonAtomic(
            join(location.failed, filename),
            { failedAt: now(), error: String(error) },
            newId,
          );
          rmSync(lease, { force: true });
          continue;
        }
        try {
          send(message);
          writeJsonAtomic(
            join(location.delivered, filename),
            { messageId: message.id, sessionOwner: token, deliveredAt: now() },
            newId,
          );
        } catch {
          rmSync(lease, { force: true });
          return;
        }
        rmSync(lease, { force: true });
      }
    },
  };
};
