import { describe, expect, it, vi } from "vitest";
import { createDisconnectCleanup } from "../disconnect-cleanup";
import { SessionManager } from "../manager";

describe("disconnect session cleanup", () => {
  it("stops every local session through the safe session-stop path", async () => {
    const remove = vi.fn(async () => {});
    let nextWindowId = 100;
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => nextWindowId++),
        ensureActiveTab: vi.fn(async () => {}),
        remove,
      },
    });
    await manager.start("aa11");
    await manager.start("bb22");
    const detachSession = vi.fn(async () => {});
    const onSessionsChanged = vi.fn();
    const cleanup = createDisconnectCleanup({
      manager,
      sessionStopDeps: { cdp: { detachSession } },
      onSessionsChanged,
    });

    const report = await cleanup();

    expect(report).toEqual({ stoppedSessionIds: ["aa11", "bb22"], failures: [] });
    expect(manager.list()).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(detachSession).toHaveBeenCalledWith("aa11");
    expect(detachSession).toHaveBeenCalledWith("bb22");
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping disconnect notifications", async () => {
    let releaseRemove: () => void = () => {};
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 100),
        ensureActiveTab: vi.fn(async () => {}),
        remove: vi.fn(() => removeGate),
      },
    });
    await manager.start("aa11");
    const cleanup = createDisconnectCleanup({ manager });

    const first = cleanup();
    const second = cleanup();
    expect(second).toBe(first);
    releaseRemove();

    await expect(first).resolves.toEqual({ stoppedSessionIds: ["aa11"], failures: [] });
  });
});
