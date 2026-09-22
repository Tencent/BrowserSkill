import { describe, expect, it } from "vitest";
import type { BskRunResult } from "../src/runner";
import { harness, ok } from "./session-lifecycle-harness";

describe("profile selection through browser_session", () => {
  it.each([
    "a1b2c3d4",
    "Required Profile A",
  ])("preserves the verified selector %s in the start command and returned identity", async (browser) => {
    const h = harness(async (args) => {
      if (args[1] === "start") {
        return ok({ session_id: "selected", browser_instance_id: "a1b2c3d4" });
      }
      return ok({ state: args.includes("--claim") ? "active" : "closed" });
    });
    await expect(h.session({ action: "start", browser })).resolves.toMatchObject({
      sessionId: "selected",
      browserInstanceId: "a1b2c3d4",
    });
    const starts = h.calls.filter(({ args }) => args[0] === "session" && args[1] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).toEqual([
      "session",
      "start",
      "--request-id",
      expect.any(String),
      "--browser",
      browser,
    ]);
  });

  it.each([
    ["a1b2c3d4", "not_found"],
    ["Shared label", "invalid_params"],
  ])("does not fall back or navigate when %s fails with %s", async (browser, code) => {
    const h = harness(async (args): Promise<BskRunResult> => {
      if (args[1] === "start") {
        if (args.includes("--browser")) {
          return {
            ...ok({ code, message: "Required browser is unavailable or ambiguous" }),
            code: 1,
          };
        }
        // An unqualified retry would succeed on the wrong, online browser.
        return ok({ session_id: "wrong", browser_instance_id: "b1c2d3e4" });
      }
      return ok({ state: "closed" });
    });
    await expect(
      h.session({ action: "start", browser, url: "https://example.test/" }),
    ).rejects.toMatchObject({ code });
    const starts = h.calls.filter(({ args }) => args[0] === "session" && args[1] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args.slice(-2)).toEqual(["--browser", browser]);
    expect(h.calls.some(({ args }) => args[0] === "navigate")).toBe(false);
    expect(h.registry.current()).toBeUndefined();
    expect(h.registry.size()).toBe(0);
  });

  it("keeps an unqualified start available when no profile selector was supplied", async () => {
    const h = harness(async (args) => {
      if (args[1] === "start") {
        return ok({ session_id: "default", browser_instance_id: "b1c2d3e4" });
      }
      return ok({ state: args.includes("--claim") ? "active" : "closed" });
    });
    await expect(h.session({ action: "start" })).resolves.toMatchObject({
      browserInstanceId: "b1c2d3e4",
    });
    const starts = h.calls.filter(({ args }) => args[0] === "session" && args[1] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].args).not.toContain("--browser");
  });
});
