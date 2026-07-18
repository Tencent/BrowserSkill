import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { NetworkResult } from "@/transport/types";
import { handleNetwork, type NetworkCdpRunner } from "../network";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

function makeDeps(
  opts: {
    get?: (tabId: number) => Promise<chrome.tabs.Tab>;
    query?: (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>;
    result?: NetworkResult;
    captureError?: Error;
  } = {},
) {
  const result =
    opts.result ??
    ({
      tab_id: 7,
      entries: [],
      next_since: 0,
      truncated: false,
    } satisfies NetworkResult);
  const ensureNetworkCapture = vi.fn(async () => {
    if (opts.captureError) throw opts.captureError;
  });
  const networkEntriesSince = vi.fn(() => result);
  const trackSessionTab = vi.fn();
  const cdp = {
    trackSessionTab,
    ensureNetworkCapture,
    networkEntriesSince,
  } satisfies NetworkCdpRunner;
  const tabsApi = {
    get:
      opts.get ??
      vi.fn(
        async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
      ),
    query:
      opts.query ?? vi.fn(async () => [{ id: 7, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return { cdp, tabsApi, ensureNetworkCapture, networkEntriesSince, trackSessionTab };
}

describe("handleNetwork", () => {
  it("reads the Agent Window active tab with safe defaults", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps({
      result: {
        tab_id: 7,
        entries: [
          { sequence: 3, kind: "response", url: "https://x/api", status: 404, truncated: false },
        ],
        next_since: 3,
        truncated: false,
      },
    });

    const res = await handleNetwork(sm, { session_id: "aa11" }, deps);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.entries[0].status).toBe(404);
    expect(deps.ensureNetworkCapture).toHaveBeenCalledWith(7);
    expect(deps.networkEntriesSince).toHaveBeenCalledWith(7, undefined, 50, 1000);
  });

  it("reads an explicit tab and forwards cursor options", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps({
      get: vi.fn(async () => ({ id: 9, windowId: 200, active: true }) as chrome.tabs.Tab),
    });

    await handleNetwork(
      sm,
      {
        session_id: "aa11",
        tab_id: 9,
        since: 12,
        limit: 75,
        max_text_chars: 1500,
      },
      deps,
    );

    expect(deps.ensureNetworkCapture).toHaveBeenCalledWith(9);
    expect(deps.networkEntriesSince).toHaveBeenCalledWith(9, 12, 75, 1500);
  });

  it("surfaces network capture failures as cdp_failed", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps({ captureError: new Error("Network.enable denied") });

    const res = await handleNetwork(sm, { session_id: "aa11" }, deps);

    expect(res).toEqual({ code: "cdp_failed", message: "Network.enable denied" });
    expect(deps.trackSessionTab).toHaveBeenCalledWith("aa11", 7);
    expect(deps.networkEntriesSince).not.toHaveBeenCalled();
  });

  it("hides other sessions' Agent Window tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 101]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const deps = makeDeps({
      get: vi.fn(async () => ({ id: 9, windowId: 101, active: true }) as chrome.tabs.Tab),
    });

    const res = await handleNetwork(sm, { session_id: "aa11", tab_id: 9 }, deps);

    expect(res).toMatchObject({ code: "not_found" });
    expect(deps.ensureNetworkCapture).not.toHaveBeenCalled();
  });
});
