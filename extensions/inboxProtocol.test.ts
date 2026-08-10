import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInboxProtocol, type InboxMessage } from "./inboxProtocol.js";

const roots: string[] = [];
const setup = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "foreman-inbox-"));
  roots.push(stateRoot);
  let id = 0;
  const protocol = createInboxProtocol({
    stateRoot,
    now: () => 123,
    newId: () => `id-${++id}`,
  });
  return { stateRoot, protocol };
};

const queueInSubprocess = (stateRoot: string, content: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      join(process.cwd(), "node_modules", ".bin", "vite-node"),
      [
        join(process.cwd(), "extensions", "fixtures", "queueInbox.ts"),
        stateRoot,
        "pane",
        "same",
        content,
      ],
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`queue process exited ${code}: ${stderr}`)),
    );
  });

const message = (id?: string) => ({
  id,
  customType: "test",
  content: "hello",
  details: { fact: true },
  triggerTurn: true,
  deliverAs: "steer" as const,
});

afterEach(() =>
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true })),
);

describe("inbox protocol", () => {
  it("keeps one complete immutable message from concurrent duplicate writers", async () => {
    const { stateRoot, protocol } = setup();
    await Promise.all([
      queueInSubprocess(stateRoot, "first complete value"),
      queueInSubprocess(stateRoot, "second complete value"),
    ]);
    const stored = JSON.parse(
      readFileSync(join(protocol.paths("pane").messages, "same.json"), "utf8"),
    ) as InboxMessage;
    expect(["first complete value", "second complete value"]).toContain(
      stored.content,
    );
    protocol.queue("pane", message("different"));
    expect(
      readFileSync(join(protocol.paths("pane").messages, "different.json")),
    ).toBeTruthy();
  });

  it("writes a receipt only after successful delivery and retries failures", () => {
    const { protocol } = setup();
    protocol.queue("pane", message("one"));
    const owner = protocol.claim("pane", "session");
    protocol.drain("pane", owner, () => {
      throw new Error("send failed");
    });
    expect(() =>
      readFileSync(join(protocol.paths("pane").delivered, "one.json")),
    ).toThrow();
    const sent: InboxMessage[] = [];
    protocol.drain("pane", owner, (value) => sent.push(value));
    expect(sent).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(
          join(protocol.paths("pane").delivered, "one.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ messageId: "one", deliveredAt: 123 });
  });

  it("fails malformed input without blocking later messages", () => {
    const { protocol } = setup();
    protocol.queue("pane", message("b-valid"));
    writeFileSync(
      join(protocol.paths("pane").messages, "a-invalid.json"),
      "{}\n",
    );
    const sent: InboxMessage[] = [];
    protocol.drain("pane", protocol.claim("pane", "session"), (value) =>
      sent.push(value),
    );
    expect(sent.map(({ id }) => id)).toEqual(["b-valid"]);
    expect(
      readFileSync(
        join(protocol.paths("pane").failed, "a-invalid.json"),
        "utf8",
      ),
    ).toContain("missing required");
  });

  it("prevents stale owners from delivering or deleting the current claim", () => {
    const { protocol } = setup();
    protocol.queue("pane", message("one"));
    const stale = protocol.claim("pane", "old");
    const current = protocol.claim("pane", "new");
    const sent: InboxMessage[] = [];
    protocol.drain("pane", stale, (value) => sent.push(value));
    protocol.release("pane", stale);
    protocol.drain("pane", current, (value) => sent.push(value));
    expect(sent.map(({ id }) => id)).toEqual(["one"]);
  });
});
