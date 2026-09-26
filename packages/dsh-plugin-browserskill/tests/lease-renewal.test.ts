import { describe, expect, it } from "vitest";
import { renewSessionLeases } from "../src/index";
import type { BskRunner, BskRunResult } from "../src/runner";
import { BskError } from "../src/runner";
import { SessionRegistry } from "../src/sessions";

function result(code: number, payload: unknown, timedOut = false): BskRunResult {
  return {
    code,
    stdout: JSON.stringify(payload),
    stderr: "",
    timedOut,
    aborted: false,
  };
}

function runner(reply: BskRunResult): BskRunner {
  return {
    async run() {
      return reply;
    },
    killAll() {},
    killFor: () => 0,
  };
}

function activeRegistry(): SessionRegistry {
  const registry = new SessionRegistry(5);
  registry.completeStart({ sessionId: "s1", startedAtMs: 1 });
  return registry;
}

describe("session lease renewal", () => {
  it("treats a non-zero bsk exit as a renewal failure", async () => {
    await expect(
      renewSessionLeases(
        runner(result(4, { code: "daemon_unavailable", message: "daemon unavailable" })),
        activeRegistry(),
        "owner",
      ),
    ).rejects.toBeInstanceOf(BskError);
  });

  it("marks locally tracked sessions unavailable when the daemon no longer renews them", async () => {
    const registry = activeRegistry();

    await expect(
      renewSessionLeases(runner(result(0, { session_ids: [] })), registry, "owner"),
    ).resolves.toEqual(["s1"]);
    expect(registry.stateFor("s1")).toBe("cleanup");
    expect(() => registry.resolve("s1", "browser_inspect")).toThrow("awaiting cleanup");
  });

  it("keeps sessions active when the daemon confirms their lease", async () => {
    const registry = activeRegistry();

    await expect(
      renewSessionLeases(runner(result(0, { session_ids: ["s1"] })), registry, "owner"),
    ).resolves.toEqual([]);
    expect(registry.stateFor("s1")).toBe("active");
  });
});
