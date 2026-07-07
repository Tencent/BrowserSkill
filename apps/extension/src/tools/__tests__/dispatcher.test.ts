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
    vi.unstubAllGlobals();
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
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp });
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
    };
    const dispatcher = new ToolDispatcher({ transport, sessions, cdp });
    dispatcher.start();

    deliver(makeRequest("tool.session_stop", { session_id: "aa11" }));
    await flushMicrotasks();
    expect(cdp.detachSession).toHaveBeenCalledWith("aa11");
    expect(sessions.has("aa11")).toBe(false);
    expect(sent[0]).toEqual({ id: "r-1", result: {} });
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

    // Cancel ack arrived synchronously; the slow tool replies with
    // `cancelled` once the dispatcher's race observes the abort.
    const ack = sent.find(
      (m) =>
        typeof (m as { id?: string }).id === "string" && (m as { id: string }).id === "cancel-1",
    );
    expect(ack).toEqual({ id: "cancel-1", result: { cancelled: true } });

    const slow = sent.find(
      (m) => typeof (m as { id?: string }).id === "string" && (m as { id: string }).id === "r-1",
    );
    expect(slow).toMatchObject({ id: "r-1", error: { code: "cancelled" } });
    expect(dispatcher.inflightAbortControllers.has("r-1")).toBe(false);

    // Drain the dangling create promise so vitest does not warn.
    resolveCreate(9999);
    await flushMicrotasks();
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
