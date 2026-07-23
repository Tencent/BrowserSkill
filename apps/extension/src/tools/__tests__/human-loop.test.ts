import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { RequestHelpParams } from "@/transport/types";
import { handleRequestHelp, type RequestHelpDeps, resetHelpLifecycleForTests } from "../human-loop";

function chromeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: T) => {
      listeners.delete(listener);
    }),
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function installHelpLifecycleChrome() {
  const runtimeOnMessage =
    chromeEvent<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => unknown
    >();
  const tabsOnActivated = chromeEvent<(activeInfo: chrome.tabs.TabActiveInfo) => unknown>();
  const tabsOnCreated = chromeEvent<(tab: chrome.tabs.Tab) => unknown>();
  const tabsOnUpdated =
    chromeEvent<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => unknown>();
  const webNavigationOnCompleted =
    chromeEvent<(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => unknown>();

  vi.stubGlobal("chrome", {
    runtime: { onMessage: runtimeOnMessage },
    tabs: { onActivated: tabsOnActivated, onCreated: tabsOnCreated, onUpdated: tabsOnUpdated },
    webNavigation: { onCompleted: webNavigationOnCompleted },
  });

  return {
    runtimeOnMessage,
    tabsOnActivated,
    tabsOnCreated,
    tabsOnUpdated,
    webNavigationOnCompleted,
  };
}

function fakeManager(sessionId: string, agentWindowId: number, tabId: number) {
  const mgr = {
    get: (id: string) =>
      id === sessionId
        ? { sessionId, agentWindowId, refStore: { resolve: () => null }, borrowedTabs: new Map() }
        : null,
    findByWindowId: (wid: number) => (wid === agentWindowId ? { sessionId } : null),
  } as unknown as SessionManager;
  return mgr;
}

function baseParams(over: Partial<RequestHelpParams> = {}): RequestHelpParams {
  return { session_id: "abcd", prompt: "log in", ...over };
}

function baseDeps(over: Partial<RequestHelpDeps> = {}): RequestHelpDeps {
  return {
    tabsApi: {
      get: vi.fn(async () => ({ id: 5, windowId: 99, active: true, title: "Login" }) as never),
      query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
    },
    windows: { update: vi.fn(async () => ({}) as never) },
    activateTab: vi.fn(async () => {}),
    sendToTab: vi.fn(async () => ({ type: "bsk-help-response", outcome: "continued", note: "ok" })),
    cdp: { send: vi.fn(async () => ({})) } as unknown as RequestHelpDeps["cdp"],
    notifications: null,
    autoAttachLifecycle: false,
    ...over,
  };
}

describe("handleRequestHelp", () => {
  afterEach(() => {
    resetHelpLifecycleForTests();
    vi.unstubAllGlobals();
  });

  it("rejects unknown session", async () => {
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ session_id: "zzzz" }),
      baseDeps(),
    );
    expect("code" in res && res.code).toBe("not_found");
  });

  it("brings the tab to the foreground and returns the user outcome", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      deps,
    );
    expect(deps.windows.update).toHaveBeenCalledWith(99, { focused: true });
    expect(deps.activateTab).toHaveBeenCalledWith(5);
    expect(res).toMatchObject({ outcome: "continued", note: "ok", tab_id: 5 });
  });

  it("forwards title into the help request message when provided", async () => {
    const deps = baseDeps();
    await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, title: "Complete verification" }),
      deps,
    );
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg).toMatchObject({
      type: "bsk-help-request",
      prompt: "log in",
      title: "Complete verification",
    });
  });

  it("omits title from the help request message when not provided", async () => {
    const deps = baseDeps();
    await handleRequestHelp(fakeManager("abcd", 99, 5), baseParams({ tab_id: 5 }), deps);
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg.title).toBeUndefined();
  });

  it("does not complete merely because the tab navigates during the wait", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({
      sendToTab: vi.fn(() => new Promise(() => {})),
    });
    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(5);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ outcome: "timed_out", tab_id: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns timed_out when the wait expires", async () => {
    vi.useFakeTimers();
    try {
      const deps = baseDeps({
        sendToTab: vi.fn(() => new Promise(() => {})), // never resolves
      });
      const p = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      const res = await p;
      expect(res).toMatchObject({ outcome: "timed_out", tab_id: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns completed when explicit completion criteria match", async () => {
    const deps = baseDeps({
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      cdp: {
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "Runtime.evaluate") return { result: { value: true } };
          return {};
        }),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        tab_id: 5,
        completion_criteria: {
          any: [{ selector_exists: "#account-menu" }],
          stable_for_ms: 0,
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ outcome: "completed", completed_by: "system", tab_id: 5 });
  });

  it("keeps user control active on new tabs without moving completion off the primary tab", async () => {
    vi.useFakeTimers();
    const chromeEvents = installHelpLifecycleChrome();
    const sendToTab = vi.fn(async () => ({ type: "bsk-help-ack", ok: true }));
    const deps = baseDeps({
      autoAttachLifecycle: undefined,
      sendToTab,
      tabsApi: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 99,
          active: tabId === 6,
          url: tabId === 6 ? "https://app.example/reset/success" : "https://app.example/login",
        })) as never,
        query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
      },
    });

    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({
          tab_id: 5,
          timeout_ms: 1_000,
          completion_criteria: {
            any: [{ url_contains: "/reset/success" }],
            stable_for_ms: 0,
          },
        }),
        deps,
      );
      await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledWith(5, expect.anything()));

      chromeEvents.tabsOnActivated.emit({ tabId: 6, windowId: 99 });
      await vi.advanceTimersByTimeAsync(200);

      await vi.waitFor(() =>
        expect(sendToTab).toHaveBeenCalledWith(
          6,
          expect.objectContaining({
            type: "bsk-help-request",
            displayMode: "compact",
            selectors: [],
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        outcome: "timed_out",
        tab_id: 5,
      });
      expect(sendToTab).toHaveBeenCalledWith(
        6,
        expect.objectContaining({ type: "bsk-help-cancel" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets same-window tabs query active help after content-script load", async () => {
    const chromeEvents = installHelpLifecycleChrome();
    const ac = new AbortController();
    const cdpSend = vi.fn(async () => ({ root: { nodeId: 1 }, nodeIds: [] }));
    const deps = baseDeps({
      autoAttachLifecycle: undefined,
      signal: ac.signal,
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      cdp: {
        send: cdpSend,
      } as unknown as RequestHelpDeps["cdp"],
    });

    const pending = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, timeout_ms: 60_000 }),
      deps,
    );
    await vi.waitFor(() => expect(deps.sendToTab).toHaveBeenCalledWith(5, expect.anything()));

    const sameWindowResponse = vi.fn();
    chromeEvents.runtimeOnMessage.emit(
      { type: "bsk-help-query" },
      { tab: { id: 6 } as chrome.tabs.Tab },
      sameWindowResponse,
    );
    await vi.waitFor(() =>
      expect(sameWindowResponse).toHaveBeenCalledWith({
        active: true,
        request: expect.objectContaining({
          requestId: expect.any(String),
          prompt: "log in",
          displayMode: "compact",
          selectors: [],
        }),
      }),
    );

    const subjectResponse = vi.fn();
    chromeEvents.runtimeOnMessage.emit(
      { type: "bsk-help-query" },
      { tab: { id: 5 } as chrome.tabs.Tab },
      subjectResponse,
    );
    await vi.waitFor(() =>
      expect(subjectResponse).toHaveBeenCalledWith({
        active: true,
        request: expect.objectContaining({
          requestId: expect.any(String),
          prompt: "log in",
          displayMode: "full",
        }),
      }),
    );

    ac.abort();
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    expect(cdpSend).toHaveBeenCalledWith(
      5,
      "DOM.querySelectorAll",
      expect.objectContaining({ selector: "[data-bsk-help]" }),
    );
    expect(cdpSend).toHaveBeenCalledWith(
      6,
      "DOM.querySelectorAll",
      expect.objectContaining({ selector: "[data-bsk-help]" }),
    );
  });

  it("tags ref targets via CDP and reports them matched", async () => {
    const mgr = {
      get: (id: string) =>
        id === "abcd"
          ? {
              sessionId: "abcd",
              agentWindowId: 99,
              refStore: { resolve: () => 42 },
              borrowedTabs: new Map(),
            }
          : null,
      findByWindowId: (wid: number) => (wid === 99 ? { sessionId: "abcd" } : null),
    } as unknown as SessionManager;
    const deps = baseDeps({
      cdp: {
        send: vi.fn(async () => ({ object: { objectId: "obj-1" } })),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      mgr,
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg.selectors).toContain('[data-bsk-help="0"]');
    expect(res).toMatchObject({
      outcome: "continued",
      tab_id: 5,
      resolved_targets: [{ matched: true, ref: "@e1" }],
    });
  });

  it("reports ref target unmatched when ref does not resolve", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    expect(res).toMatchObject({
      outcome: "continued",
      resolved_targets: [{ matched: false, ref: "@e1" }],
    });
    expect("code" in res).toBe(false);
  });

  it("reports ref target unmatched when ref is for another tab", async () => {
    const mgr = {
      get: (id: string) =>
        id === "abcd"
          ? {
              sessionId: "abcd",
              agentWindowId: 99,
              refStore: {
                resolve: (ref: string, opts: { tabId?: number }) =>
                  ref === "e1" && opts.tabId === 4 ? 42 : null,
              },
              borrowedTabs: new Map(),
            }
          : null,
      findByWindowId: (wid: number) => (wid === 99 ? { sessionId: "abcd" } : null),
    } as unknown as SessionManager;
    const deps = baseDeps();
    const res = await handleRequestHelp(
      mgr,
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    expect(res).toMatchObject({
      outcome: "continued",
      resolved_targets: [{ matched: false, ref: "@e1" }],
    });
    expect("code" in res).toBe(false);
  });

  it("keeps waiting when the initial overlay delivery rejects", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({
      sendToTab: vi.fn(async () => {
        throw new Error("no receiver");
      }),
    });
    try {
      const res = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(res).resolves.toMatchObject({ outcome: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for explicit completion after a malformed help response", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({ sendToTab: vi.fn(async () => undefined) });
    try {
      const res = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(res).resolves.toMatchObject({ outcome: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports selector match status from CDP", async () => {
    const cdpFor = (querySelectorNodeId: number) =>
      ({
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          if (method === "DOM.querySelector") return { nodeId: querySelectorNodeId };
          return {};
        }),
      }) as unknown as RequestHelpDeps["cdp"];

    const miss = baseDeps({ cdp: cdpFor(0) });
    const resMiss = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      miss,
    );
    expect(resMiss).toMatchObject({
      resolved_targets: [{ matched: false, selector: "#x" }],
    });

    const hit = baseDeps({ cdp: cdpFor(42) });
    const resHit = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      hit,
    );
    expect(resHit).toMatchObject({
      resolved_targets: [{ matched: true, selector: "#x" }],
    });
  });

  it("marks selector unmatched when CDP cannot resolve the document root", async () => {
    const deps = baseDeps({
      cdp: {
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "DOM.getDocument") throw new Error("no document");
          return {};
        }),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      deps,
    );
    expect(res).toMatchObject({
      resolved_targets: [{ matched: false, selector: "#x" }],
    });
  });

  it("returns cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const deps = baseDeps({ signal: ac.signal, sendToTab: vi.fn(() => new Promise(() => {})) });
    const p = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, timeout_ms: 60_000 }),
      deps,
    );
    ac.abort();
    const res = await p;
    expect("code" in res ? res.code : (res as { outcome: string }).outcome).toMatch(/cancelled/);
  });
});
