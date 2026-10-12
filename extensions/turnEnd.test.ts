import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { excerpt, initiatorOrigin, unsignaledStop } from "./turnEnd.js";

const user = (text: string) =>
  ({
    role: "user",
    content: [{ type: "text", text }],
  }) as unknown as AgentMessage;
const assistant = (text = "ok") =>
  ({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
  }) as unknown as AgentMessage;
const custom = (customType: string) =>
  ({
    role: "custom",
    customType,
    content: "",
    display: true,
  }) as unknown as AgentMessage;

describe("initiatorOrigin", () => {
  it("treats the session's first run as task work", () => {
    expect(initiatorOrigin([user("do the task"), assistant()], true)).toBe(
      "task",
    );
  });

  it("treats a later bare user run as a human aside", () => {
    expect(initiatorOrigin([user("quick question?"), assistant()], false)).toBe(
      "human",
    );
  });

  it("treats any Foreman directive run as task work, first or not", () => {
    expect(
      initiatorOrigin([custom("foreman-worker-directive"), assistant()], false),
    ).toBe("task");
    expect(
      initiatorOrigin(
        [custom("foreman-verifier-directive"), assistant()],
        false,
      ),
    ).toBe("task");
  });

  it("leaves continuation runs (retries, compaction) to the caller", () => {
    expect(initiatorOrigin([], false)).toBeUndefined();
    expect(initiatorOrigin([assistant()], true)).toBeUndefined();
  });
});

describe("excerpt", () => {
  it("keeps short replies whole and both ends of long ones", () => {
    expect(excerpt("short", 20)).toBe("short");
    const long = `${"a".repeat(50)}${"b".repeat(50)}`;
    const cut = excerpt(long, 23);
    expect(cut.length).toBeLessThanOrEqual(23);
    expect(cut.startsWith("aaaa")).toBe(true);
    expect(cut.endsWith("bbbb")).toBe(true);
  });
});

describe("unsignaledStop", () => {
  it("reports when the final reply holds only thinking or tool calls", () => {
    const silent = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "toolCall", name: "bash" }],
    } as unknown as AgentMessage;
    expect(
      unsignaledStop([custom("directive"), silent], "worker_signal", {
        origin: "task",
      }),
    ).toEqual({
      origin: "task",
      stopReason: "stop",
      context: "(no text reply)",
    });
  });

  it("pairs a trimmed human message with a small reply excerpt", () => {
    const stop = unsignaledStop(
      [assistant("y".repeat(1000))],
      "worker_signal",
      {
        origin: "human",
        asked: "x".repeat(1000),
      },
    );
    const [asked = "", reply = ""] = stop?.context.split("\nReply: ") ?? [];
    expect(asked.length).toBeLessThanOrEqual("Human: ".length + 120);
    expect(reply.length).toBeLessThanOrEqual(200);
  });
});
