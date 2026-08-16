import { describe, expect, it } from "vitest";
import {
  FOREMAN_TAB_LABEL,
  renameForemanTabAtStartup,
} from "../extensions/foremanStartup.js";

describe("Foreman startup tab label", () => {
  it("renames the containing tab only on startup", () => {
    const calls: Array<[string, string]> = [];
    const result = renameForemanTabAtStartup({
      reason: "startup",
      tabId: "w1:t1",
      rename: (tabId, label) => {
        calls.push([tabId, label]);
        return { ok: true };
      },
    });

    expect(result).toEqual({ kind: "renamed" });
    expect(calls).toEqual([["w1:t1", FOREMAN_TAB_LABEL]]);
  });

  it("does not rename on reload or session replacement", () => {
    for (const reason of ["reload", "new", "resume", "fork"]) {
      let called = false;
      const result = renameForemanTabAtStartup({
        reason,
        tabId: "w1:t1",
        rename: () => {
          called = true;
          return { ok: true };
        },
      });

      expect(result).toEqual({ kind: "skipped", reason: "not-startup" });
      expect(called).toBe(false);
    }
  });

  it("starts normally outside Herdr", () => {
    let called = false;
    const result = renameForemanTabAtStartup({
      reason: "startup",
      rename: () => {
        called = true;
        return { ok: true };
      },
    });

    expect(result).toEqual({ kind: "skipped", reason: "outside-herdr" });
    expect(called).toBe(false);
  });

  it("returns rename failures instead of throwing", () => {
    const result = renameForemanTabAtStartup({
      reason: "startup",
      tabId: "w1:t1",
      rename: () => ({
        ok: false,
        error: { message: "herdr API unavailable" },
      }),
    });

    expect(result).toEqual({
      kind: "failed",
      message: "herdr API unavailable",
    });
  });
});
