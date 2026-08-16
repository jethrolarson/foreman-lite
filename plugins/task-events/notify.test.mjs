import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildNotification, latestRoleEvent } from "./notify-core.mjs";

const homes = [];
afterEach(() =>
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true })),
);

const run = (home, event) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [new URL("./notify.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          HOME: home,
          HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event),
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(undefined)
        : reject(new Error(`exit ${code}: ${stderr}`)),
    );
  });

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "foreman-plugin-"));
  homes.push(home);
  const root = join(home, ".foreman");
  const task = {
    id: "task-1",
    role: "worker",
    foremanPaneId: "foreman",
    workerPaneId: "worker",
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "registry.json"), JSON.stringify({ worker: task }));
  const events = join(root, "tasks", task.id, "events.jsonl");
  mkdirSync(dirname(events), { recursive: true });
  writeFileSync(
    events,
    [
      JSON.stringify({
        role: "worker",
        action: "done",
        context: "artifact",
        timestamp: 10,
      }),
      JSON.stringify({
        role: "verifier",
        action: "approve",
        context: "checked",
        timestamp: 20,
      }),
    ].join("\n"),
  );
  return { home, root, task, events };
};

describe("task event notification logic", () => {
  it("keeps the wrapper notification-only", () => {
    const source = readFileSync(
      new URL("./notify.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/agent["']?\s*,\s*["']prompt/);
    expect(source).not.toContain("worker.ts");
    expect(source).not.toContain("verifier.ts");
  });

  it("selects the latest event for each role", () => {
    const raw = [
      JSON.stringify({ role: "worker", action: "planned", timestamp: 1 }),
      JSON.stringify({ role: "verifier", action: "approve", timestamp: 3 }),
      JSON.stringify({ role: "worker", action: "done", timestamp: 2 }),
    ].join("\n");
    expect(latestRoleEvent(raw, "worker").action).toBe("done");
    expect(latestRoleEvent(raw, "verifier").action).toBe("approve");
  });

  it("emits the complete factual message and skips a missing Foreman pane", () => {
    const task = { id: "task", role: "verifier", foremanPaneId: "foreman" };
    const result = buildNotification({
      task,
      paneId: "verifier",
      paneStatus: "done",
      taskEvent: {
        role: "verifier",
        action: "approve",
        context: "ok",
        timestamp: 42,
      },
      now: () => 99,
    });
    expect(result.message.details).toEqual({
      source: "verifier",
      taskId: "task",
      paneId: "verifier",
      paneStatus: "done",
      action: "approve",
      context: "ok",
      eventTimestamp: 42,
    });
    expect(result.message.createdAt).toBe(42);
    expect(
      buildNotification({
        task: { ...task, foremanPaneId: undefined },
        paneId: "v",
        paneStatus: "done",
        now: () => 1,
      }),
    ).toBeUndefined();
  });

  it("ignores untracked panes and non-reactable statuses", async () => {
    const { home, root } = fixture();
    await run(home, { data: { pane_id: "unknown", agent_status: "done" } });
    await run(home, { data: { pane_id: "worker", agent_status: "working" } });
    expect(() =>
      readdirSync(join(root, "inboxes", "foreman", "messages")),
    ).toThrow();
  });

  it("deduplicates concurrent wrapper invocations into one immutable message", async () => {
    const { home, root } = fixture();
    const event = { data: { pane_id: "worker", agent_status: "done" } };
    await Promise.all([run(home, event), run(home, event)]);
    const directory = join(root, "inboxes", "foreman", "messages");
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const message = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(message.details).toMatchObject({
      source: "worker",
      taskId: "task-1",
      paneStatus: "done",
      action: "done",
      context: "artifact",
      eventTimestamp: 10,
    });
  });
});
