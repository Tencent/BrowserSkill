import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import type { ConsoleResult } from "@/transport/types";
import { handleConsole } from "../console";

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
    result?: ConsoleResult;
  } = {},
) {
  const result =
    opts.result ??
    ({
      tab_id: 7,
      entries: [],
      next_since: 0,
      truncated: false,
    } satisfies ConsoleResult);
  const ensureConsoleCapture = vi.fn(async () => {});
  const consoleEntriesSince = vi.fn(() => result);
  const cdp = {
    send: vi.fn(),
    ensureConsoleCapture,
    consoleEntriesSince,
  } as unknown as CdpRunner;
  const tabsApi = {
    get:
      opts.get ??
      vi.fn(
        async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
      ),
    query:
      opts.query ?? vi.fn(async () => [{ id: 7, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return { cdp, tabsApi, ensureConsoleCapture, consoleEntriesSince };
}

describe("handleConsole", () => {
  it("reads the Agent Window active tab with safe defaults", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps({
      result: {
        tab_id: 7,
        entries: [{ sequence: 3, kind: "console", level: "log", text: "hello", truncated: false }],
        next_since: 3,
        truncated: false,
      },
    });

    const res = await handleConsole(sm, { session_id: "aa11" }, deps);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.entries[0].text).toBe("hello");
    expect(deps.ensureConsoleCapture).toHaveBeenCalledWith(7);
    expect(deps.consoleEntriesSince).toHaveBeenCalledWith(7, undefined, 50, 1000, false);
  });

  it("reads an explicit tab and forwards bounded options", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps({
      get: vi.fn(async () => ({ id: 9, windowId: 200, active: true }) as chrome.tabs.Tab),
    });

    await handleConsole(
      sm,
      {
        session_id: "aa11",
        tab_id: 9,
        since: 12,
        limit: 500,
        max_text_chars: 9999,
        include_stack: true,
      },
      deps,
    );

    expect(deps.ensureConsoleCapture).toHaveBeenCalledWith(9);
    expect(deps.consoleEntriesSince).toHaveBeenCalledWith(9, 12, 200, 4096, true);
  });

  it("rejects invalid bounds before touching CDP", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps();

    const res = await handleConsole(sm, { session_id: "aa11", limit: 0 }, deps);

    expect(res).toMatchObject({ code: "invalid_params", message: /limit/ });
    expect(deps.ensureConsoleCapture).not.toHaveBeenCalled();
    expect(deps.consoleEntriesSince).not.toHaveBeenCalled();
  });

  it("hides other sessions' Agent Window tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 101]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const deps = makeDeps({
      get: vi.fn(async () => ({ id: 9, windowId: 101, active: true }) as chrome.tabs.Tab),
    });

    const res = await handleConsole(sm, { session_id: "aa11", tab_id: 9 }, deps);

    expect(res).toMatchObject({ code: "not_found" });
    expect(deps.ensureConsoleCapture).not.toHaveBeenCalled();
  });
});
