import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { excerpt, runOrigin, unsignaledStopContext } from "./turnEnd.js";

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

describe("runOrigin", () => {
  it("treats the session's first run as task work", () => {
    expect(runOrigin([user("do the task"), assistant()], true)).toBe("task");
  });

  it("treats a later bare user run as a human aside", () => {
    expect(runOrigin([user("quick question?"), assistant()], false)).toBe(
      "human",
    );
  });

  it("treats any Foreman directive run as task work, first or not", () => {
    expect(
      runOrigin([custom("foreman-worker-directive"), assistant()], false),
    ).toBe("task");
    expect(
      runOrigin([custom("foreman-verifier-directive"), assistant()], false),
    ).toBe("task");
  });

  it("fails safe to task when the run has no initiating message", () => {
    expect(runOrigin([], false)).toBe("task");
    expect(runOrigin([assistant()], false)).toBe("task");
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

describe("unsignaledStopContext", () => {
  it("reports when the final reply holds only thinking or tool calls", () => {
    const silent = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "toolCall", name: "bash" }],
    } as unknown as AgentMessage;
    expect(
      unsignaledStopContext(
        [custom("directive"), silent],
        "worker_signal",
        false,
      ),
    ).toBe("(no text reply)");
  });
});
