import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { OVERLAY_AUTOMATION_BYPASS } from "@/lib/overlay-bridge";
import { ToolDispatcher } from "@/tools/dispatcher";
import { evictSessionCdpRunner } from "@/tools/shared";
import type { Transport } from "@/transport/transport";
import type { ConnectionState, ProtocolFrame } from "@/transport/types";
import { createDisconnectCleanup } from "../disconnect-cleanup";
import { SessionManager } from "../manager";

function fakeChromeEvent<TArgs extends unknown[]>() {
  const listeners = new Set<(...args: TArgs) => void>();
  return {
    addListener: vi.fn((cb: (...args: TArgs) => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: (...args: TArgs) => void) => listeners.delete(cb)),
    fire: (...args: TArgs) => {
      for (const cb of [...listeners]) cb(...args);
    },
  };
}

function makeFakeTransport() {
  const listeners = new Set<(frame: ProtocolFrame) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const sent: ProtocolFrame[] = [];
  let currentState: ConnectionState = "connected";
  const transport: Transport = {
    get state(): ConnectionState {
      return currentState;
    },
    connect: async () => {},
    disconnect: async () => {},
    send: (frame) => {
      sent.push(frame);
    },
    onMessage: (handler) => {
      listeners.add(handler);
      return { dispose: () => listeners.delete(handler) };
    },
    onConnectionStateChange: (handler) => {
      stateListeners.add(handler);
      return { dispose: () => stateListeners.delete(handler) };
    },
  };
  return {
    transport,
    sent,
    receive: (frame: ProtocolFrame) => {
      for (const listener of [...listeners]) listener(frame);
    },
    setState: (state: ConnectionState) => {
      currentState = state;
      for (const listener of [...stateListeners]) listener(state);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disconnect session cleanup", () => {
  it("stops every local session through the safe session-stop path", async () => {
    const remove = vi.fn(async () => {});
    let nextWindowId = 100;
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: nextWindowId++, initialTabIds: [] })),
        ensureActiveTab: vi.fn(async () => 1),
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
        create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
        ensureActiveTab: vi.fn(async () => 1),
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

  it("cancels in-flight RPCs, dismisses open and chained beforeunload dialogs, and clears hover bypass on disconnect", async () => {
    const onEvent = fakeChromeEvent<[CdpDebuggee, string, unknown]>();
    const onDetach = fakeChromeEvent<[chrome.debugger.Debuggee, string]>();
    const dialogActions: Array<{ accept?: boolean }> = [];
    const order: string[] = [];

    const debuggerApi: CdpDebuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target, method, params) => {
        if (method === "Page.handleJavaScriptDialog") {
          const accept = (params as { accept?: boolean } | undefined)?.accept;
          dialogActions.push({ accept });
          order.push(`dialog:${accept ? "accept" : "dismiss"}`);
          onEvent.fire({ tabId: 11 }, "Page.javascriptDialogClosed", { result: Boolean(accept) });
          return {};
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
        }
        if (method === "DOM.getContentQuads") {
          return { quads: [[10, 10, 50, 10, 50, 50, 10, 50]] };
        }
        if (method === "Runtime.evaluate") {
          const expr = (params as { expression?: string } | undefined)?.expression ?? "";
          if (expr.includes("overlayHostPresent")) {
            return {
              result: {
                value: { overlayHostPresent: true, overlayHostConnected: true, hitIndex: 0 },
              },
            };
          }
          return { result: { value: "visible" } };
        }
        return {};
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onEvent: onEvent as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
      onDetach: onDetach as any,
    };

    const tabMessages: Array<{ tabId: number; message: unknown }> = [];
    const tab11 = { id: 11, windowId: 100, active: true, url: "https://example.test/" };
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async (tabId: number) => (tabId === 11 ? tab11 : undefined)),
        query: vi.fn(async () => [tab11]),
        sendMessage: vi.fn(async (tabId: number, message: unknown) => {
          tabMessages.push({ tabId, message });
          return {};
        }),
        update: vi.fn(async () => tab11),
        remove: vi.fn(async () => {}),
      },
      windows: {
        get: vi.fn(async () => ({ id: 100, focused: true })),
        update: vi.fn(async () => ({})),
      },
    });

    const cdp = new ChromiumCdp(debuggerApi);
    const remove = vi.fn(async () => {
      order.push("window:remove");
    });

    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: 100, initialTabIds: [11] })),
        ensureActiveTab: vi.fn(async () => 11),
        remove,
      },
    });
    const ctx = await manager.start("aa11");
    ctx.refStore.set("e1", 501, { tabId: 11 });
    cdp.trackSessionTab("aa11", 11);

    const { transport, sent, receive } = makeFakeTransport();
    const dispatcher = new ToolDispatcher({
      transport,
      sessions: manager,
      cdp,
    });
    dispatcher.start();

    try {
      // 1) Issue a real tool.hover so hoverBypassTabs/hoverLatches are populated on tab 11.
      receive({
        id: "hover-1",
        method: "tool.hover",
        params: { session_id: "aa11", tab_id: 11, ref: "e1", settle_ms: 0 },
      });
      await vi.waitFor(() =>
        expect(sent.some((frame) => "id" in frame && frame.id === "hover-1")).toBe(true),
      );
      expect(tabMessages).toContainEqual({
        tabId: 11,
        message: { type: OVERLAY_AUTOMATION_BYPASS, enabled: true },
      });

      // 2) Start an in-flight tool.wait_for_navigation that would otherwise linger across disconnect.
      receive({
        id: "wait-1",
        method: "tool.wait_for_navigation",
        params: { session_id: "aa11", tab_id: 11, timeout_ms: 60_000 },
      });
      await vi.waitFor(() => expect(dispatcher.inflightAbortControllers.has("wait-1")).toBe(true));

      const waitController = dispatcher.inflightAbortControllers.get("wait-1");
      expect(waitController).toBeDefined();

      // 3) Open an active JS alert dialog on tab 11 before transport drops, and fire a
      //    chained confirm dialog as soon as the first alert is dismissed.
      await cdp.ensureAttached(11);
      onEvent.fire({ tabId: 11 }, "Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked!",
      });
      expect(cdp.pendingDialogs(11)[0]?.type).toBe("alert");
      let chainedFired = false;
      const baseSend = debuggerApi.sendCommand;
      debuggerApi.sendCommand = vi.fn(async (target, method, params) => {
        const res = await baseSend(target, method, params);
        if (method === "Page.handleJavaScriptDialog" && !chainedFired) {
          chainedFired = true;
          onEvent.fire({ tabId: 11 }, "Page.javascriptDialogOpening", {
            type: "confirm",
            message: "Chained prompt!",
          });
        }
        return res;
      });

      const stopped = vi.fn((sessionId: string) => {
        evictSessionCdpRunner(cdp, sessionId);
      });
      const cleanup = createDisconnectCleanup({
        manager,
        cancelAll: () => dispatcher.cancelAll(),
        cancelSession: (sessionId) => dispatcher.cancelSession(sessionId),
        awaitSessionCancelled: (sessionId) => dispatcher.awaitSessionCancelled(sessionId),
        releaseHover: (sessionId) => dispatcher.releaseHoverForSession(sessionId),
        onSessionStopped: stopped,
        sessionStopDeps: { cdp },
      });

      const report = await cleanup();

      expect(report).toEqual({ stoppedSessionIds: ["aa11"], failures: [] });
      expect(waitController?.signal.aborted).toBe(true);
      expect(dispatcher.inflightAbortControllers.size).toBe(0);
      // Stale responses from cancelled pre-disconnect RPCs are suppressed across connection epochs.
      expect(sent.find((frame) => "id" in frame && frame.id === "wait-1")).toBeUndefined();
      expect(dialogActions).toEqual([{ accept: false }, { accept: false }]);
      expect(order.indexOf("dialog:dismiss")).toBeLessThan(order.indexOf("window:remove"));
      expect(tabMessages).toContainEqual({
        tabId: 11,
        message: { type: OVERLAY_AUTOMATION_BYPASS, enabled: false },
      });
      expect(stopped).toHaveBeenCalledWith("aa11");
      expect(manager.list()).toEqual([]);
      expect(cdp.isAttached(11)).toBe(false);
    } finally {
      dispatcher.stop();
      await cdp.detachAll();
      cdp.dispose();
    }
  });

  it("blocks new session_start during open-socket disconnect teardown and drops stale video read responses across reconnect", async () => {
    let releaseFirstWindowRemove!: () => void;
    const firstWindowRemoveGate = new Promise<void>((resolve) => {
      releaseFirstWindowRemove = resolve;
    });
    let nextWindowId = 200;
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: nextWindowId++, initialTabIds: [] })),
        ensureActiveTab: vi.fn(async () => 1),
        remove: vi.fn(async (windowId: number) => {
          if (windowId === 200) await firstWindowRemoveGate;
        }),
      },
    });
    await manager.start("existing");

    let finishVideoRead!: (value: { data_base64: string; byte_size: number }) => void;
    const videoReadPromise = new Promise<{ data_base64: string; byte_size: number }>((resolve) => {
      finishVideoRead = resolve;
    });
    const video = {
      rpc: vi.fn(() => videoReadPromise),
      stopSession: vi.fn(async () => {}),
    };

    const { transport, sent, receive, setState } = makeFakeTransport();
    const dispatcher = new ToolDispatcher({
      transport,
      sessions: manager,
      video: video as never,
    });
    dispatcher.start();

    try {
      // 1) Start a sessionless `tool.video` read before disconnect teardown begins.
      receive({
        id: "video-read-old-conn",
        method: "tool.video",
        params: {
          action: "read",
          browser: "chrome",
          recording_id: "rec-1",
          capability: "cap-1",
          offset: 0,
        },
      });
      await vi.waitFor(() => expect(video.rpc).toHaveBeenCalledOnce());

      // 2) Begin manual-disable disconnect cleanup while the socket is still open.
      const cleanup = createDisconnectCleanup({
        manager,
        cancelAll: () => dispatcher.beginDisconnectCleanup(),
        awaitPendingStarts: () => dispatcher.awaitPendingStarts(),
        cancelSession: (sessionId) => dispatcher.cancelSession(sessionId),
        awaitSessionCancelled: (sessionId) => dispatcher.awaitSessionCancelled(sessionId),
      });
      const cleaning = cleanup();

      // 3) A new `tool.session_start` arriving on the still-open socket during teardown must
      //    be refused immediately instead of creating a surviving session.
      receive({
        id: "late-start",
        method: "tool.session_start",
        params: { session_id: "sneaky-new" },
      });
      await vi.waitFor(() =>
        expect(sent.find((frame) => "id" in frame && frame.id === "late-start")).toMatchObject({
          error: { code: "cancelled" },
        }),
      );
      expect(manager.has("sneaky-new")).toBe(false);

      releaseFirstWindowRemove();
      await expect(cleaning).resolves.toEqual({ stoppedSessionIds: ["existing"], failures: [] });
      expect(manager.list()).toEqual([]);

      // 4) Transport reconnects to a new endpoint, and the old sessionless video read finishes.
      //    Its payload must be discarded rather than sent onto the new connection!
      setState("disconnected");
      setState("connected");
      const sentBeforeLateVideo = sent.length;
      finishVideoRead({ data_base64: "c2VjcmV0", byte_size: 6 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sent.slice(sentBeforeLateVideo)).toEqual([]);

      // 5) Fresh requests on the new connection work normally again.
      receive({
        id: "fresh-start",
        method: "tool.session_start",
        params: { session_id: "new-conn-session" },
      });
      await vi.waitFor(() =>
        expect(sent.find((frame) => "id" in frame && frame.id === "fresh-start")).toMatchObject({
          result: { agent_window_id: 201 },
        }),
      );
      expect(manager.has("new-conn-session")).toBe(true);
    } finally {
      dispatcher.stop();
    }
  });
});
