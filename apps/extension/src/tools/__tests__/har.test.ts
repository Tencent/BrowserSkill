import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { HarCdpRunner } from "../har";
import { handleHarStart, handleHarStatus, handleHarStop } from "../har";

function makeSessionManager() {
  return new SessionManager({
    agentWindow: {
      create: vi.fn(async () => 100),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => {}),
    },
  });
}

function makeCdp(): HarCdpRunner {
  let active = false;
  return {
    startHar: vi.fn(async (_sessionId, tabId) => {
      active = true;
      return {
        tab_id: tabId,
        started_at: "2026-07-21T00:00:00.000Z",
        capture_content: true,
        sanitize: true,
        max_body_bytes: 1024,
        max_total_body_bytes: 2048,
        max_entries: 100,
      };
    }),
    harStatus: vi.fn(() => ({
      active,
      ...(active ? { tab_id: 7, started_at: "2026-07-21T00:00:00.000Z" } : {}),
      entry_count: 0,
      in_flight: 0,
      body_bytes: 0,
      truncated: false,
    })),
    stopHar: vi.fn(async () => {
      active = false;
      return {
        tab_id: 7,
        entry_count: 1,
        body_bytes: 0,
        truncated: false,
        har: { log: { version: "1.2", entries: [] } },
      };
    }),
  };
}

describe("HAR tool handlers", () => {
  it("starts capture on the active Agent Window tab", async () => {
    const manager = makeSessionManager();
    await manager.start("aa11");
    const cdp = makeCdp();
    const result = await handleHarStart(
      manager,
      { session_id: "aa11" },
      {
        cdp,
        tabsApi: {
          get: vi.fn(),
          query: vi.fn(async () => [{ id: 7, windowId: 100, active: true } as chrome.tabs.Tab]),
        },
      },
    );

    expect(result).toMatchObject({ tab_id: 7, capture_content: true, sanitize: true });
    expect(cdp.startHar).toHaveBeenCalledWith("aa11", 7, { session_id: "aa11" });
  });

  it("rejects a second active recording", async () => {
    const manager = makeSessionManager();
    await manager.start("aa11");
    const cdp = makeCdp();
    await cdp.startHar("aa11", 7, { session_id: "aa11" });

    const result = await handleHarStart(
      manager,
      { session_id: "aa11" },
      { cdp, tabsApi: { get: vi.fn(), query: vi.fn() } },
    );

    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("rejects normal user tabs outside the Agent Window", async () => {
    const manager = makeSessionManager();
    await manager.start("aa11");
    const cdp = makeCdp();

    const result = await handleHarStart(
      manager,
      { session_id: "aa11", tab_id: 9 },
      {
        cdp,
        tabsApi: {
          get: vi.fn(async () => ({ id: 9, windowId: 200, active: true }) as chrome.tabs.Tab),
          query: vi.fn(),
        },
      },
    );

    expect(result).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
    expect(cdp.startHar).not.toHaveBeenCalled();
  });

  it("rejects borrowed user tabs even after they enter the Agent Window", async () => {
    const manager = makeSessionManager();
    const ctx = await manager.start("aa11");
    ctx.borrowedTabs.set(9, { tabId: 9, originalWindowId: 200, originalIndex: 0 });
    const cdp = makeCdp();

    const result = await handleHarStart(
      manager,
      { session_id: "aa11", tab_id: 9 },
      {
        cdp,
        tabsApi: {
          get: vi.fn(async () => ({ id: 9, windowId: 100, active: true }) as chrome.tabs.Tab),
          query: vi.fn(),
        },
      },
    );

    expect(result).toMatchObject({ code: "permission_denied" });
    expect(cdp.startHar).not.toHaveBeenCalled();
  });

  it("reports status and stops with the requested settle timeout", async () => {
    const manager = makeSessionManager();
    await manager.start("aa11");
    const cdp = makeCdp();
    await cdp.startHar("aa11", 7, { session_id: "aa11" });

    expect(handleHarStatus(manager, { session_id: "aa11" }, { cdp })).toMatchObject({
      active: true,
      tab_id: 7,
    });
    const result = await handleHarStop(
      manager,
      { session_id: "aa11", settle_timeout_ms: 500 },
      { cdp },
    );
    expect(result).toMatchObject({ entry_count: 1, har: { log: { version: "1.2" } } });
    expect(cdp.stopHar).toHaveBeenCalledWith("aa11", 500);
  });
});
