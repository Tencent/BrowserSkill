import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { RequestHelpParams } from "@/transport/types";
import { handleRequestHelp, type RequestHelpDeps } from "../human-loop";

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
    watchTabNavigation: () => () => {},
    cdp: { send: vi.fn(async () => ({})) } as unknown as RequestHelpDeps["cdp"],
    notifications: null,
    ...over,
  };
}

describe("handleRequestHelp", () => {
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

  it("returns navigated when the tab navigates during the wait", async () => {
    const unwatch = vi.fn();
    const deps = baseDeps({
      sendToTab: vi.fn(() => new Promise(() => {})),
      watchTabNavigation: vi.fn((_tabId, cb) => {
        queueMicrotask(() => cb());
        return unwatch;
      }),
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      deps,
    );
    expect(res).toMatchObject({ outcome: "navigated", tab_id: 5 });
    expect(unwatch).toHaveBeenCalled();
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

  it("returns protocol_error when sendToTab rejects", async () => {
    const deps = baseDeps({
      sendToTab: vi.fn(async () => {
        throw new Error("no receiver");
      }),
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      deps,
    );
    expect("code" in res && res.code).toBe("protocol_error");
  });

  it("returns protocol_error for a malformed help response", async () => {
    const undefinedReply = baseDeps({ sendToTab: vi.fn(async () => undefined) });
    const res1 = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      undefinedReply,
    );
    expect("code" in res1 && res1.code).toBe("protocol_error");

    const badOutcome = baseDeps({
      sendToTab: vi.fn(async () => ({ type: "bsk-help-response", outcome: "weird" })),
    });
    const res2 = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      badOutcome,
    );
    expect("code" in res2 && res2.code).toBe("protocol_error");
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
