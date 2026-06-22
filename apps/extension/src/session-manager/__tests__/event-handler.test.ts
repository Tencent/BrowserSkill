import { describe, expect, it, vi } from "vitest";
import type { ConnectionStateHandler, FrameHandler, Transport } from "@/transport/transport";
import type { ConnectionState, ProtocolFrame } from "@/transport/types";
import { attachSessionEventHandler, type WindowRemovedListener } from "../event-handler";
import { SessionManager } from "../manager";

function fakeWindowEvents() {
  const listeners = new Set<(windowId: number) => void>();
  const api: WindowRemovedListener = {
    addListener: (cb) => listeners.add(cb),
    removeListener: (cb) => listeners.delete(cb),
  };
  return {
    api,
    emit(id: number) {
      for (const l of listeners) l(id);
    },
    listenerCount: () => listeners.size,
  };
}

function fakeTransport(): Transport & { sent: ProtocolFrame[] } {
  const sent: ProtocolFrame[] = [];
  const t: Transport & { sent: ProtocolFrame[] } = {
    state: "connected" as ConnectionState,
    sent,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: (msg) => sent.push(msg),
    onMessage: (_h: FrameHandler) => ({ dispose: () => {} }),
    onConnectionStateChange: (_h: ConnectionStateHandler) => ({ dispose: () => {} }),
  };
  return t;
}

describe("attachSessionEventHandler", () => {
  it("drops the local session and emits session.window_closed when the agent window closes", async () => {
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    await manager.start("aa11");
    const transport = fakeTransport();
    const events = fakeWindowEvents();
    const cdp = { detachSession: vi.fn(async () => {}) };

    attachSessionEventHandler({
      manager,
      transport,
      windowEvents: events.api,
      cdp,
    });
    expect(events.listenerCount()).toBe(1);

    events.emit(4242);
    await vi.waitUntil(() => transport.sent.length > 0);

    expect(cdp.detachSession).toHaveBeenCalledWith("aa11");
    expect(manager.has("aa11")).toBe(false);
    expect(transport.sent).toEqual([
      {
        event: "session.window_closed",
        payload: { session_id: "aa11", reason: "user_closed_window" },
      },
    ]);
  });

  it("reports borrowed tabs as return failures when the Agent Window was already closed", async () => {
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 4242),
        remove: vi.fn(async () => {}),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const ctx = await manager.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const transport = fakeTransport();
    const events = fakeWindowEvents();

    attachSessionEventHandler({
      manager,
      transport,
      windowEvents: events.api,
    });

    events.emit(4242);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(transport.sent).toEqual([
      {
        event: "session.window_closed",
        payload: {
          session_id: "aa11",
          reason: "user_closed_window",
          return_failures: [
            {
              tab_id: 7,
              code: "cdp_failed",
              message: "Agent Window was closed before borrowed tab could be returned",
            },
          ],
        },
      },
    ]);
  });

  it("ignores non-agent windows", async () => {
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const transport = fakeTransport();
    const events = fakeWindowEvents();
    attachSessionEventHandler({ manager, transport, windowEvents: events.api });
    events.emit(9999);
    await Promise.resolve();
    expect(transport.sent).toEqual([]);
  });

  it("dispose() removes the listener", () => {
    const manager = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => 1),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(async () => {}),
      },
    });
    const transport = fakeTransport();
    const events = fakeWindowEvents();
    const handle = attachSessionEventHandler({
      manager,
      transport,
      windowEvents: events.api,
    });
    expect(events.listenerCount()).toBe(1);
    handle.dispose();
    expect(events.listenerCount()).toBe(0);
  });
});
