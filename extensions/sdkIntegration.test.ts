import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import foremanExtension from "./foreman.js";
import workerExtension from "./worker.js";
import verifierExtension from "./verifier.js";

const registeredTools = async (factory: (pi: never) => void) => {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    extensionFactories: [factory as never],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return [...loader.getExtensions().extensions[0]!.tools.keys()];
};

afterEach(() => {
  delete process.env.FOREMAN_TASK_ID;
});

describe("Pi public SDK extension loading", () => {
  it("loads exactly Foreman's intended tools without a model call", async () => {
    expect(await registeredTools(foremanExtension as never)).toEqual([
      "create_task",
      "message_worker",
      "start_verifier",
      "halt_worker",
      "flag",
    ]);
  });

  it("loads only each role's own signal", async () => {
    process.env.FOREMAN_TASK_ID = "sdk-task";
    expect(await registeredTools(workerExtension as never)).toEqual([
      "worker_signal",
    ]);
    expect(await registeredTools(verifierExtension as never)).toEqual([
      "verifier_signal",
    ]);
  });
});
