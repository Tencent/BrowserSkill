import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { ConnectionStateHandler, FrameHandler, Transport } from "@/transport/transport";
import type {
  ConnectionState,
  ConsoleResult,
  ProtocolFrame,
  RequestFrame,
} from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";
import { resetBrowserObservationForTests, setBrowserObservationAttachForTests } from "../record";

type TestDispatcherCdp = NonNullable<ConstructorParameters<typeof ToolDispatcher>[0]["cdp"]>;

function fakeTransport() {
  const handlers = new Set<FrameHandler>();
  const stateHandlers = new Set<ConnectionStateHandler>();
  const sent: ProtocolFrame[] = [];
  const t: Transport = {
    state: "connected" as ConnectionState,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: (msg) => sent.push(msg),
    onMessage: (h) => {
      handlers.add(h);
      return { dispose: () => handlers.delete(h) };
    },
    onConnectionStateChange: (h) => {
      stateHandlers.add(h);
      return { dispose: () => stateHandlers.delete(h) };
    },
  };
  return {
    transport: t,
    sent,
    deliver(frame: ProtocolFrame) {
      for (const h of handlers) h(frame);
    },
  };
}

function makeRequest(method: string, params: unknown): RequestFrame {
  return { id: "r-1", method, params };
}

describe("ToolDispatcher", () => {
  afterEach(() => {
    resetBrowserObservationForTests();
    vi.unstubAllGlobals();
  });

  it("uses the configured recording runtime for start and stop", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    const tab = {
      id: 7,
      windowId: 4242,
      active: true,
      status: "complete",
      url: "https://example.com/start",
    } as chrome.tabs.Tab;
    const frameCoordinator = {
      begin: vi.fn(),
      armTab: vi.fn(async () => true),
      sourceFor: vi.fn(() => null),
      stop: vi.fn(async () => true),
      cancel: vi.fn(),
    };
    const sendToTab = vi.fn(async () => ({ ok: true }));
    setBrowserObservationAttachForTests(
      () => () => {},
      () => () => {},
    );
    const dispatcher = new ToolDispatcher({
      transport,
      sessions,
      recording: {
        tabsApi: {
          get: vi.fn(async () => tab),
          query: vi.fn(async () => [tab]),
        },
        frameCoordinator,
        sendToTab,
      },
    });
    dispatcher.start();

    deliver(
      makeRequest("tool.record_start", {
        session_id: "aa11",
        url: "https://example.com/start",
      }),
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toMatchObject({ result: { tab_id: 7, recording: true } });
    expect(frameCoordinator.begin).toHaveBeenCalledOnce();
    expect(frameCoordinator.armTab).toHaveBeenCalledWith(expect.any(String), 7);

    deliver({ id: "r-2", method: "tool.record_stop", params: { session_id: "aa11" } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(frameCoordinator.stop).toHaveBeenCalledOnce();
    expect(sent[1]).toMatchObject({ id: "r-2", result: { trace: { steps: [] } } });
  });

  it("routes tool.session_start to the SessionManager and replies with the window id", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(sessions.has("aa11")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      id: "r-1",
      result: { agent_window_id: 4242 },
    });
  });

  it("forwards an unfocused session start to the Agent Window", async () => {
    const { transport, deliver } = fakeTransport();
    const create = vi.fn(async () => 4242);
    const sessions = new SessionManager({
      agentWindow: {
        create,
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa11", focused: false }));
    await flushMicrotasks();

    expect(create).toHaveBeenCalledWith("about:blank", { focused: false });
  });

  it("routes tool.session_stop and replies with empty result", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_stop", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(sessions.has("aa11")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ id: "r-1", result: {} });
  });

  it("routes tool.console through the CDP console buffer", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => [{ id: 7, windowId: 4242, active: true }]),
      },
    });
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    const cdp = {
      send: vi.fn(),
      detachSession: vi.fn(async () => {}),
      ensureConsoleCapture: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      consoleEntriesSince: vi.fn(
        () =>
          ({
            tab_id: 7,
            entries: [
              { sequence: 1, kind: "console", level: "log", text: "hello", truncated: false },
            ],
            next_since: 1,
            truncated: false,
          }) satisfies ConsoleResult,
      ),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    dispatcher.start();

    deliver(makeRequest("tool.console", { session_id: "aa11" }));
    await flushMicrotasks();

    expect(cdp.ensureConsoleCapture).toHaveBeenCalledWith(7);
    expect(sent[0]).toEqual({
      id: "r-1",
      result: {
        tab_id: 7,
        entries: [{ sequence: 1, kind: "console", level: "log", text: "hello", truncated: false }],
        next_since: 1,
        truncated: false,
      },
    });
  });

  it("bypasses and restores the control overlay for an upload trigger click", async () => {
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async () => ({ id: 7, windowId: 4242, active: true })),
        query: vi.fn(async () => [{ id: 7, windowId: 4242, active: true }]),
        sendMessage,
      },
    });
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const ctx = await sessions.start("aa11");
    ctx.refStore.set("e1", 123, { tabId: 7 });
    const send = vi.fn(async <T>(_tabId: number, method: string, params?: object) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } } as T;
      }
      if (method === "DOM.getContentQuads") {
        return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] } as T;
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "trigger-object" } } as T;
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 456 } } as T;
      if (method === "Runtime.callFunctionOn") {
        const declaration = (params as { functionDeclaration?: string }).functionDeclaration ?? "";
        if (declaration.includes("count: state.inputs.length")) {
          return { result: { value: { count: 1, multiple: false } } } as T;
        }
        if (declaration.includes("inputs[0]")) {
          return { result: { objectId: "input-object" } } as T;
        }
        return { result: { value: true } } as T;
      }
      if (method === "Runtime.evaluate") {
        const expression = (params as { expression?: string }).expression ?? "";
        if (expression.includes("overlayDetails")) {
          return { result: { value: { hitIndex: 0 } } } as T;
        }
        if (expression.includes("overlayHostPresent")) {
          return {
            result: {
              value: { overlayHostPresent: true, overlayHostConnected: true },
            },
          } as T;
        }
        if (expression.includes("count:")) {
          return { result: { value: { count: 1, multiple: false } } } as T;
        }
        if (expression.includes("?.inputs[0]")) {
          return { result: { objectId: "input-object" } } as T;
        }
        return { result: { value: true } } as T;
      }
      return {} as T;
    });
    const cdp = {
      send,
      detachSession: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    dispatcher.start();

    deliver(
      makeRequest("tool.upload", {
        session_id: "aa11",
        ref: "@e1",
        files: [{ transfer_id: "tr_1", name: "test.png", staged_path: "/stage/test.png" }],
      }),
    );
    await flushMicrotasks();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toMatchObject({ result: { tab_id: 7, file_names: ["test.png"] } });
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, {
      type: "bh-automation-bypass",
      enabled: true,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 7, {
      type: "bh-automation-bypass",
      enabled: false,
    });
  });

  it("detaches CDP state before stopping a session", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    const cdp = {
      send: vi.fn(),
      detachSession: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    dispatcher.start();

    deliver(makeRequest("tool.session_stop", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(cdp.detachSession).toHaveBeenCalledWith("aa11");
    expect(sessions.has("aa11")).toBe(false);
    expect(sent[0]).toEqual({ id: "r-1", result: {} });
  });

  it("forwards daemon cancellation into an in-flight session stop", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const remove = vi.fn(async () => {});
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove,
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    let finishDetach: () => void = () => {};
    const detach = new Promise<void>((resolve) => {
      finishDetach = resolve;
    });
    const cdp = {
      send: vi.fn(),
      detachSession: vi.fn(() => detach),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    dispatcher.start();

    deliver(makeRequest("tool.session_stop", { session_id: "aa11" }));
    await vi.waitFor(() => expect(cdp.detachSession).toHaveBeenCalledWith("aa11"));
    deliver({ id: "cancel-stop", method: "cancel", params: { rpc_id: "r-1" } });
    await flushMicrotasks();
    finishDetach();
    await flushMicrotasks();

    expect(sent).toContainEqual({ id: "cancel-stop", result: { cancelled: true } });
    expect(sent).toContainEqual({
      id: "r-1",
      error: expect.objectContaining({ code: "cancelled" }),
    });
    expect(sessions.has("aa11")).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns not_found when stopping an unknown session", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_stop", { session_id: "zzzz" }));
    await flushMicrotasks();
    expect(sent[0]).toMatchObject({
      id: "r-1",
      error: { code: "not_found" },
    });
  });

  it("returns unknown_method for unimplemented methods", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();
    // M9 wired `tool.evaluate` and `tool.wait_for_navigation`; pick a
    // canary that still lives outside the extension (daemon-side
    // `tool.wait_ms` cannot reach this dispatcher in production, but
    // routing it here lets us keep catching regressions in the
    // default branch).
    deliver(makeRequest("tool.wait_ms", { duration_ms: 10 }));
    await flushMicrotasks();
    expect(sent[0]).toMatchObject({
      id: "r-1",
      error: { code: "unknown_method" },
    });
  });

  it("ignores non-request frames", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();
    deliver({ id: "ignore", result: { ok: true } });
    deliver({ event: "browser.connected", payload: {} });
    await flushMicrotasks();
    expect(sent).toEqual([]);
  });

  it("stop() detaches the message handler", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();
    dispatcher.stop();
    deliver(makeRequest("tool.session_start", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(sent).toEqual([]);
  });

  it("invokes onSessionsChanged after session.start and session.stop", async () => {
    const { transport, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const onSessionsChanged = vi.fn();
    const dispatcher = new ToolDispatcher({ transport, sessions, onSessionsChanged });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);

    deliver({ ...makeRequest("tool.session_stop", { session_id: "aa11" }), id: "r-2" });
    await flushMicrotasks();
    expect(onSessionsChanged).toHaveBeenCalledTimes(2);
  });

  it("invokes onBrowserControlResumed for browser-control tools but not passive reads", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const onBrowserControlResumed = vi.fn();
    const dispatcher = new ToolDispatcher({ transport, sessions, onBrowserControlResumed });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa11" }));
    await flushMicrotasks();
    sent.length = 0;

    deliver({ ...makeRequest("tool.snapshot", { session_id: "aa11" }), id: "r-passive" });
    await flushMicrotasks();
    expect(onBrowserControlResumed).not.toHaveBeenCalled();

    deliver({
      ...makeRequest("tool.tab_create", { session_id: "aa11", url: "https://example.test/" }),
      id: "r-control",
    });
    await flushMicrotasks();
    expect(onBrowserControlResumed).toHaveBeenCalledWith("aa11");
  });

  it("reasserts remembered hover before follow-up work and releases only after actions", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        sendMessage: vi.fn(async () => undefined),
      },
    });
    const { transport } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const order: string[] = [];
    const cdp = {
      send: vi.fn(async <T>() => {
        order.push("hover");
        return {} as T;
      }),
      detachSession: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });

    (
      dispatcher as unknown as { rememberHover: (sessionId: string, result: unknown) => unknown }
    ).rememberHover("aa11", {
      tab_id: 7,
      x: 10,
      y: 20,
    });
    const helpers = dispatcher as unknown as {
      withHoverReassert: <T>(
        params: { session_id: string; tab_id?: number },
        work: () => Promise<T>,
        options?: { releaseAfter?: boolean },
      ) => Promise<T>;
      setHoverBypass: (sessionId: string, tabId: number, enabled: boolean) => Promise<void>;
    };

    await helpers.withHoverReassert({ session_id: "aa11", tab_id: 7 }, async () => {
      order.push("observe");
      return {};
    });
    expect(order).toEqual(["hover", "observe"]);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );

    await helpers.setHoverBypass("aa11", 7, true);
    await helpers.withHoverReassert(
      { session_id: "aa11", tab_id: 7 },
      async () => {
        order.push("click");
        return {};
      },
      { releaseAfter: true },
    );

    expect(cdp.send).toHaveBeenLastCalledWith(7, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 10,
      y: 20,
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("does not reassert or disable hover latches from another session", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        sendMessage: vi.fn(async () => undefined),
      },
    });
    const { transport } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const cdp = {
      send: vi.fn(async <T>() => ({}) as T),
      detachSession: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 7,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    const helpers = dispatcher as unknown as {
      rememberHover: (sessionId: string, result: unknown) => unknown;
      setHoverBypass: (sessionId: string, tabId: number, enabled: boolean) => Promise<void>;
      withHoverReassert: <T>(
        params: { session_id: string; tab_id?: number },
        work: () => Promise<T>,
        options?: { releaseAfter?: boolean },
      ) => Promise<T>;
      releaseHoverLatch: (sessionId?: string, tabId?: number) => Promise<void>;
    };

    helpers.rememberHover("aa11", { tab_id: 7, x: 10, y: 20 });
    await helpers.setHoverBypass("aa11", 7, true);

    await helpers.withHoverReassert({ session_id: "bb22", tab_id: 7 }, async () => ({}), {
      releaseAfter: true,
    });

    expect(cdp.send).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );

    await helpers.releaseHoverLatch("aa11", 7);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("transfers hover overlay bypass ownership between sessions", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        sendMessage: vi.fn(async () => undefined),
      },
    });
    const { transport } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    const helpers = dispatcher as unknown as {
      setHoverBypass: (sessionId: string, tabId: number, enabled: boolean) => Promise<void>;
    };

    await helpers.setHoverBypass("aa11", 7, true);
    await helpers.setHoverBypass("bb22", 7, true);
    await helpers.setHoverBypass("aa11", 7, false);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );

    await helpers.setHoverBypass("bb22", 7, false);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("limits default-target hover reassertion to the active tab", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => [{ id: 9, windowId: 4242, active: true }]),
        get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 4242, active: tabId === 9 })),
        sendMessage: vi.fn(async () => undefined),
      },
    });
    const { transport } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await sessions.start("aa11");
    const cdp = {
      send: vi.fn(async <T>() => ({}) as T),
      detachSession: vi.fn(async () => {}),
      ensureNetworkCapture: vi.fn(async () => {}),
      networkEntriesSince: vi.fn(() => ({
        tab_id: 9,
        entries: [],
        next_since: 0,
        truncated: false,
      })),
      setDeviceMetricsOverride: vi.fn(async () => {}),
      clearDeviceMetricsOverride: vi.fn(async () => {}),
      setUserAgentOverride: vi.fn(async () => {}),
      setTouchEmulationEnabled: vi.fn(async () => {}),
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp: cdp as TestDispatcherCdp });
    const helpers = dispatcher as unknown as {
      rememberHover: (sessionId: string, result: unknown) => unknown;
      withHoverReassert: <T>(
        params: { session_id: string; tab_id?: number },
        work: () => Promise<T>,
      ) => Promise<T>;
    };

    helpers.rememberHover("aa11", { tab_id: 7, x: 10, y: 20 });
    helpers.rememberHover("aa11", { tab_id: 9, x: 30, y: 40 });

    await helpers.withHoverReassert({ session_id: "aa11" }, async () => ({}));

    expect(cdp.send).toHaveBeenCalledTimes(1);
    expect(cdp.send).toHaveBeenCalledWith(9, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 30,
      y: 40,
    });
  });

  it("releases the current session hover latch before navigation-style work", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        sendMessage: vi.fn(async () => undefined),
      },
    });
    const { transport } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    const helpers = dispatcher as unknown as {
      rememberHover: (sessionId: string, result: unknown) => unknown;
      setHoverBypass: (sessionId: string, tabId: number, enabled: boolean) => Promise<void>;
      withHoverReleaseForRequest: <T>(
        params: { session_id: string; tab_id?: number },
        work: () => Promise<T>,
      ) => Promise<T>;
      withHoverReassert: <T>(
        params: { session_id: string; tab_id?: number },
        work: () => Promise<T>,
      ) => Promise<T>;
    };
    helpers.rememberHover("aa11", { tab_id: 7, x: 10, y: 20 });
    await helpers.setHoverBypass("aa11", 7, true);

    await helpers.withHoverReleaseForRequest({ session_id: "aa11", tab_id: 7 }, async () => ({}));
    await helpers.withHoverReassert({ session_id: "aa11", tab_id: 7 }, async () => ({}));

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("disconnects the transport when send() fails so keepalive can rebuild", async () => {
    const { transport, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    transport.send = () => {
      throw new Error("simulated send failure");
    };
    const disconnect = vi.spyOn(transport, "disconnect");
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa22" }));
    await flushMicrotasks();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("rolls back the session_start side effects when send() fails", async () => {
    const { transport, deliver } = fakeTransport();
    const remove = vi.fn(async () => {});
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 5555),
        remove,
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    transport.send = () => {
      throw new Error("simulated send failure");
    };
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa33" }));
    await flushMicrotasks();
    // Window opened then closed during rollback; SessionContext gone.
    expect(remove).toHaveBeenCalledWith(5555);
    expect(sessions.has("aa33")).toBe(false);
  });

  it("registers an AbortController per RPC and cancel() trips the matching one", async () => {
    const { transport, sent, deliver } = fakeTransport();
    // Slow agent-window create lets us observe the controller before
    // the handler resolves.
    let resolveCreate: (id: number) => void = () => {};
    const createPromise = new Promise<number>((r) => {
      resolveCreate = r;
    });
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(() => createPromise),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa44" }));
    // Wait for the controller to register.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(dispatcher.inflightAbortControllers.has("r-1")).toBe(true);
    const ac = dispatcher.inflightAbortControllers.get("r-1");
    expect(ac?.signal.aborted).toBe(false);

    // Push a cancel for the same id.
    deliver({ id: "cancel-1", method: "cancel", params: { rpc_id: "r-1" } });
    await flushMicrotasks();
    expect(ac?.signal.aborted).toBe(true);

    // Cancel ack arrives synchronously, but the original RPC must not reply
    // until the in-progress window creation has completed and been rolled back.
    const ack = sent.find(
      (m) =>
        typeof (m as { id?: string }).id === "string" && (m as { id: string }).id === "cancel-1",
    );
    expect(ack).toEqual({ id: "cancel-1", result: { cancelled: true } });

    expect(
      sent.find(
        (m) => typeof (m as { id?: string }).id === "string" && (m as { id: string }).id === "r-1",
      ),
    ).toBeUndefined();
    expect(dispatcher.inflightAbortControllers.has("r-1")).toBe(true);

    resolveCreate(9999);
    await flushMicrotasks();

    const slow = sent.find(
      (m) => typeof (m as { id?: string }).id === "string" && (m as { id: string }).id === "r-1",
    );
    expect(slow).toMatchObject({ id: "r-1", error: { code: "cancelled" } });
    expect(dispatcher.inflightAbortControllers.has("r-1")).toBe(false);
    expect(sessions.has("aa44")).toBe(false);
    expect(sessions.list()).toEqual([]);
  });

  it("cancel for an unknown rpc_id replies with cancelled=false", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver({ id: "cancel-x", method: "cancel", params: { rpc_id: "ghost" } });
    await flushMicrotasks();
    expect(sent[0]).toEqual({ id: "cancel-x", result: { cancelled: false } });
  });

  it("stop() aborts every in-flight controller", async () => {
    const { transport, deliver } = fakeTransport();
    let resolveCreate: (id: number) => void = () => {};
    const createPromise = new Promise<number>((r) => {
      resolveCreate = r;
    });
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(() => createPromise),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const dispatcher = new ToolDispatcher({ transport, sessions });
    dispatcher.start();

    deliver(makeRequest("tool.session_start", { session_id: "aa55" }));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    const ac = dispatcher.inflightAbortControllers.get("r-1");
    expect(ac).toBeDefined();

    dispatcher.stop();
    expect(ac?.signal.aborted).toBe(true);
    expect(dispatcher.inflightAbortControllers.size).toBe(0);

    // Drain the dangling create promise.
    resolveCreate(9999);
    await flushMicrotasks();
  });
});

async function flushMicrotasks() {
  // The dispatcher uses an `await` chain; resolve enough microtask
  // turns to drain even the deepest invocation graph (M10.2 added
  // `Promise.race` wrapping on top of the existing await depth, which
  // pushes the required-turn count past the original 4).
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}
