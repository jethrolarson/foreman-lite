import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { runOrigin } from "./signalReminder.js";

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

  it("keeps forcing when a prior reminder re-ran the agent", () => {
    expect(
      runOrigin([custom("worker-signal-reminder"), assistant()], false),
    ).toBe("task");
  });

  it("fails safe to task when the run has no initiating message", () => {
    expect(runOrigin([], false)).toBe("task");
    expect(runOrigin([assistant()], false)).toBe("task");
  });
});
