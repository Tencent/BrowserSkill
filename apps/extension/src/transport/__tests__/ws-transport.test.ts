import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, ProtocolFrame } from "../types";
import { WSTransport } from "../ws-transport";

type WebSocketEventListener = (event: { data?: unknown } | undefined) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = 0;
  sent: string[] = [];
  closeCalls = 0;
  listeners: Record<string, WebSocketEventListener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: WebSocketEventListener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "client" });
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", undefined);
  }

  receive(frame: ProtocolFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  serverClose(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code, reason: "server-gone" });
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake mirrors WebSocket Event shape
      l(ev as any);
    }
  }
}

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances.at(-1);
  if (!s) throw new Error("no FakeSocket created yet");
  return s;
}

describe("WSTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs a WebSocket against the configured URL when connect() is called", async () => {
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const connectPromise = t.connect();
    expect(FakeSocket.instances.length).toBe(1);
    expect(lastSocket().url).toBe("ws://127.0.0.1:52800");
    lastSocket().open();
    await connectPromise;
    expect(t.state).toBe("connected");
  });

  it("emits connection state transitions disconnected → connecting → connected", async () => {
    const transitions: ConnectionState[] = [];
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    t.onConnectionStateChange((s) => transitions.push(s));
    const p = t.connect();
    lastSocket().open();
    await p;
    expect(transitions).toEqual(["connecting", "connected"]);
  });

  it("serialises outbound frames as JSON when the socket is open", async () => {
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const p = t.connect();
    lastSocket().open();
    await p;
    t.send({ id: "1", method: "system.ping" });
    expect(lastSocket().sent).toEqual([JSON.stringify({ id: "1", method: "system.ping" })]);
  });

  it("invokes onMessage for inbound JSON frames", async () => {
    const handler = vi.fn();
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    t.onMessage(handler);
    const p = t.connect();
    lastSocket().open();
    await p;
    lastSocket().receive({ id: "1", result: { pong: true } });
    expect(handler).toHaveBeenCalledWith({ id: "1", result: { pong: true } });
  });

  it("disconnect() closes the socket and stops reconnecting", async () => {
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const p = t.connect();
    lastSocket().open();
    await p;
    await t.disconnect();
    expect(lastSocket().closeCalls).toBeGreaterThan(0);
    expect(t.state).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("backs off exponentially across consecutive failed reconnects (1s, 2s, 4s, …, capped at 5s)", async () => {
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const states: ConnectionState[] = [];
    t.onConnectionStateChange((s) => states.push(s));

    const p = t.connect();
    lastSocket().open();
    await p;
    expect(FakeSocket.instances.length).toBe(1);

    // First unexpected close kicks off the backoff cascade. From this point
    // we never let a reconnect attempt succeed; each new socket is closed
    // immediately so the backoff counter keeps growing.
    lastSocket().serverClose();

    const expectedDelays = [1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000];
    for (let i = 0; i < expectedDelays.length; i += 1) {
      const beforeCount = FakeSocket.instances.length;
      const advance = expectedDelays[i];
      if (advance > 1) {
        await vi.advanceTimersByTimeAsync(advance - 1);
        expect(FakeSocket.instances.length).toBe(beforeCount);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances.length).toBe(beforeCount + 1);
      lastSocket().serverClose();
    }

    expect(states.includes("connecting")).toBe(true);
    expect(states.includes("disconnected")).toBe(true);
  });

  it("resets the backoff counter after a successful (re)connect", async () => {
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const p = t.connect();
    lastSocket().open();
    await p;

    // First reconnect attempt at 1s, succeeds.
    lastSocket().serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(2);
    lastSocket().open();
    await Promise.resolve();

    // After a successful reconnect, the next failure should once again wait
    // only the initial delay (1s), not 2s.
    lastSocket().serverClose();
    const beforeCount = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances.length).toBe(beforeCount);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances.length).toBe(beforeCount + 1);
  });

  it("ignores malformed inbound messages (non-JSON) without throwing", async () => {
    const handler = vi.fn();
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    t.onMessage(handler);
    const p = t.connect();
    lastSocket().open();
    await p;

    const socket = lastSocket();
    for (const l of socket.listeners.message ?? []) {
      l({ data: "{not json" });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(t.state).toBe("connected");
  });

  it("disposes handlers via Disposable returned from onMessage", async () => {
    const handler = vi.fn();
    const t = new WSTransport({
      url: "ws://127.0.0.1:52800",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const disp = t.onMessage(handler);
    const p = t.connect();
    lastSocket().open();
    await p;

    lastSocket().receive({ id: "1", result: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    disp.dispose();
    lastSocket().receive({ id: "2", result: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
