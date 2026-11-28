import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAEMON_WS_URL } from "../generated/methods";
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

  emitClose(code = 1006): void {
    this.emit("close", { code, reason: "delayed-close" });
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
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const connectPromise = t.connect();
    expect(FakeSocket.instances.length).toBe(1);
    expect(lastSocket().url).toBe(DEFAULT_DAEMON_WS_URL);
    lastSocket().open();
    await connectPromise;
    expect(t.state).toBe("connected");
  });

  it("emits connection state transitions disconnected → connecting → connected", async () => {
    const transitions: ConnectionState[] = [];
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    t.onConnectionStateChange((s) => transitions.push(s));
    const p = t.connect();
    lastSocket().open();
    await p;
    expect(transitions).toEqual(["connecting", "connected"]);
  });

  it("rejects a blocked socket attempt and allows a later retry", async () => {
    const factory = vi.fn((url: string) => new FakeSocket(url) as unknown as WebSocket);
    factory.mockImplementationOnce(() => {
      throw new Error("Connection settings are unavailable");
    });
    const t = new WSTransport({ url: "wss://example.com/bsk", webSocketFactory: factory });
    await expect(t.connect()).rejects.toThrow("Connection settings are unavailable");
    expect(t.state).toBe("disconnected");
    expect(FakeSocket.instances).toHaveLength(0);
    const retry = t.connect();
    lastSocket().open();
    await retry;
    expect(t.state).toBe("connected");
    await t.disconnect();
  });

  it("rejects an existing connect promise if the next physical attempt is blocked", async () => {
    const factory = vi.fn((url: string) => new FakeSocket(url) as unknown as WebSocket);
    const t = new WSTransport({ url: "wss://example.com/bsk", webSocketFactory: factory });
    const pending = t.connect();
    const rejected = expect(pending).rejects.toThrow("Connection settings are unavailable");
    lastSocket().serverClose();
    factory.mockImplementationOnce(() => {
      throw new Error("Connection settings are unavailable");
    });
    expect(t.connect()).toBe(pending);
    await rejected;
    expect(t.state).toBe("disconnected");
    await t.disconnect();
  });

  it("serialises outbound frames as JSON when the socket is open", async () => {
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const p = t.connect();
    lastSocket().open();
    await p;
    t.send({ id: "1", method: "system.ping" });
    expect(lastSocket().sent).toEqual([JSON.stringify({ id: "1", method: "system.ping" })]);
  });

  it("replaces lone surrogates so the daemon's strict JSON parser accepts the frame", async () => {
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const p = t.connect();
    lastSocket().open();
    await p;
    // "Hi 🚀 there" cut at 4 UTF-16 units keeps only the rocket's high surrogate.
    const cut = "Hi 🚀 there".slice(0, 4);
    t.send({ id: "1", result: { text: cut, kept: "🚀", literal: "\\ud83d" } });
    const [payload] = lastSocket().sent;
    // serde_json rejects `\udXXX` escapes that are not a surrogate pair.
    expect(payload).not.toMatch(/(?<!\\)\\u[dD][89a-fA-F]/);
    expect(JSON.parse(payload)).toEqual({
      id: "1",
      result: { text: "Hi �", kept: "🚀", literal: "\\ud83d" },
    });
  });

  it("invokes onMessage for inbound JSON frames", async () => {
    const handler = vi.fn();
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
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
      url: DEFAULT_DAEMON_WS_URL,
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
      url: DEFAULT_DAEMON_WS_URL,
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
      url: DEFAULT_DAEMON_WS_URL,
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

  it("cancels pending backoff and ignores delayed events from a replaced socket", async () => {
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const initial = t.connect();
    const first = lastSocket();
    first.open();
    await initial;

    first.serverClose();
    const reconnect = t.connect();
    expect(FakeSocket.instances).toHaveLength(2);
    const second = lastSocket();
    second.open();
    await reconnect;

    // A real browser can deliver the old close callback after the replacement
    // socket is already open. It must not clear or disconnect the new socket.
    first.emitClose();
    t.send({ id: "current", method: "system.ping" });
    expect(second.sent).toEqual([JSON.stringify({ id: "current", method: "system.ping" })]);
    expect(t.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("ignores malformed inbound messages (non-JSON) without throwing", async () => {
    const handler = vi.fn();
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
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
      url: DEFAULT_DAEMON_WS_URL,
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

  it("setUrl returns false for the same URL and uses the new URL on the next connect", async () => {
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    expect(t.setUrl(DEFAULT_DAEMON_WS_URL)).toBe(false);
    expect(t.setUrl("ws://127.0.0.1:53200")).toBe(true);

    const p = t.connect();
    expect(lastSocket().url).toBe("ws://127.0.0.1:53200");
    lastSocket().open();
    await p;
    expect(t.state).toBe("connected");
  });
});

it("authenticates before connected, rejects early sends, and closes a second final frame", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const t = new WSTransport({
    url: DEFAULT_DAEMON_WS_URL,
    authenticate: () => gate,
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  const handler = vi.fn();
  t.onMessage(handler);
  const pending = t.connect();
  lastSocket().open();
  expect(t.state).toBe("connecting");
  expect(() => t.send({ id: "early", method: "system.handshake" })).toThrow();
  lastSocket().receive({ id: "early", result: {} });
  expect(handler).not.toHaveBeenCalled();
  complete();
  await pending;
  expect(t.state).toBe("connected");
  lastSocket().receive({
    type: "local.auth.ready",
    v: 1,
    rotation: null,
    commit: null,
  } as unknown as ProtocolFrame);
  expect(handler).not.toHaveBeenCalled();
  expect(t.state).toBe("disconnected");
  await t.disconnect();
});
it("auth failures back off for 30 seconds and explicit retry resets the delay", async () => {
  vi.useFakeTimers();
  const authenticate = vi.fn().mockRejectedValue(new Error("server_unverified"));
  const t = new WSTransport({
    url: DEFAULT_DAEMON_WS_URL,
    authenticate,
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  const pending = t.connect();
  lastSocket().open();
  await expect(pending).rejects.toThrow("server_unverified");
  const count = FakeSocket.instances.length;
  await vi.advanceTimersByTimeAsync(29_999);
  expect(FakeSocket.instances).toHaveLength(count);
  await expect(t.connect()).rejects.toThrow("backoff");
  t.resetAuthenticationBackoff();
  authenticate.mockResolvedValue(undefined);
  const retried = t.connect();
  lastSocket().open();
  await retried;
  expect(t.state).toBe("connected");
  await t.disconnect();
  vi.useRealTimers();
});

it("resets auth backoff on setUrl() and disconnect()", async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  const authenticate = vi.fn().mockRejectedValue(new Error("server_unverified"));
  const t = new WSTransport({
    url: DEFAULT_DAEMON_WS_URL,
    authenticate,
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });

  // 1) Trigger local auth backoff, then switch URL via setUrl(): must connect immediately.
  const first = t.connect();
  lastSocket().open();
  await expect(first).rejects.toThrow("server_unverified");
  await expect(t.connect()).rejects.toThrow("backoff");

  expect(t.setUrl("wss://gateway.example/api/v1/local-browser/extension")).toBe(true);
  authenticate.mockResolvedValue(undefined);
  const switched = t.connect();
  expect(lastSocket().url).toBe("wss://gateway.example/api/v1/local-browser/extension");
  lastSocket().open();
  await switched;
  expect(t.state).toBe("connected");

  // 2) Trigger auth backoff again, then disconnect(): next connect() must not stay locked out.
  authenticate.mockRejectedValueOnce(new Error("server_unverified"));
  lastSocket().serverClose();
  await vi.advanceTimersByTimeAsync(1_000);
  lastSocket().open();
  await vi.waitFor(() => expect(authenticate).toHaveBeenCalledTimes(3));
  await expect(t.connect()).rejects.toThrow("backoff");

  await t.disconnect();
  authenticate.mockResolvedValue(undefined);
  const resumed = t.connect();
  lastSocket().open();
  await resumed;
  expect(t.state).toBe("connected");
  await t.disconnect();
  vi.useRealTimers();
});

it("re-arms reconnect instead of stalling if the auth-backoff timer wakes slightly early", async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  let earlyOffsetMs = 0;
  const realPerformanceNow = performance.now.bind(performance);
  const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => {
    const value = realPerformanceNow() - earlyOffsetMs;
    return value;
  });
  try {
    const authenticate = vi.fn().mockRejectedValueOnce(new Error("server_unverified"));
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      authenticate,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    const first = t.connect();
    lastSocket().open();
    await expect(first).rejects.toThrow("server_unverified");
    expect(FakeSocket.instances).toHaveLength(1);

    // Simulate OS/browser timer firing 2ms before the monotonic backoff deadline.
    earlyOffsetMs = 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);

    // Once the remaining 2ms elapse, the re-armed timer must open the next socket.
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);

    authenticate.mockResolvedValue(undefined);
    lastSocket().open();
    await vi.waitFor(() => expect(t.state).toBe("connected"));
    await t.disconnect();
  } finally {
    perfSpy.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps auth-backoff reconnect on schedule when wall-clock Date.now() jumps backward", async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  try {
    const authenticate = vi.fn().mockRejectedValueOnce(new Error("server_unverified"));
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      authenticate,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    const first = t.connect();
    lastSocket().open();
    await expect(first).rejects.toThrow("server_unverified");
    expect(FakeSocket.instances).toHaveLength(1);

    // NTP / manual clock adjustment moves wall clock backward by 60 seconds.
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);

    authenticate.mockResolvedValue(undefined);
    lastSocket().open();
    await vi.waitFor(() => expect(t.state).toBe("connected"));
    await t.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

it("shortens a pending auth-backoff reconnect timer when resetAuthenticationBackoff() is called", async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  try {
    const authenticate = vi.fn().mockRejectedValueOnce(new Error("server_unverified"));
    const t = new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      authenticate,
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    const first = t.connect();
    lastSocket().open();
    await expect(first).rejects.toThrow("server_unverified");
    expect(FakeSocket.instances).toHaveLength(1);

    // Credentials rotated / remote authorization succeeded while waiting out the 30s backoff.
    authenticate.mockResolvedValue(undefined);
    t.resetAuthenticationBackoff();

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);

    lastSocket().open();
    await vi.waitFor(() => expect(t.state).toBe("connected"));
    await t.disconnect();
  } finally {
    vi.useRealTimers();
  }
});

it("treats socket close during async unpaired authenticate resolution as normal reconnect, not auth failure backoff", async () => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  let finishAuth!: () => void;
  const authGate = new Promise<void>((resolve) => {
    finishAuth = resolve;
  });
  const onAuthenticationError = vi.fn();
  const authenticate = vi.fn(() => authGate);
  const t = new WSTransport({
    url: DEFAULT_DAEMON_WS_URL,
    authenticate,
    onAuthenticationError,
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });

  const pending = t.connect();
  const first = lastSocket();
  first.open();
  expect(authenticate).toHaveBeenCalledOnce();

  // Daemon closes the socket while unpaired authenticate() is still awaiting IndexedDB readLocalState().
  first.serverClose(1006);
  // Async read finishes and resolves without error (unpaired skip path).
  finishAuth();
  await Promise.resolve();
  await Promise.resolve();

  // Must NOT fire onAuthenticationError or enter 30s local_auth_backoff; normal 1s reconnect applies.
  expect(onAuthenticationError).not.toHaveBeenCalled();
  expect(FakeSocket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(FakeSocket.instances).toHaveLength(2);

  authenticate.mockResolvedValue(undefined);
  lastSocket().open();
  await pending;
  expect(t.state).toBe("connected");
  await t.disconnect();
  vi.useRealTimers();
});

describe("WSTransport physical connect timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTransport(connectTimeoutMs: number): WSTransport {
    return new WSTransport({
      url: DEFAULT_DAEMON_WS_URL,
      reconnect: { connectTimeoutMs, initialDelayMs: 5, maxDelayMs: 5 },
      webSocketFactory: (url: string) => new FakeSocket(url) as unknown as WebSocket,
    });
  }

  it("drops a socket stuck in CONNECTING and retries", async () => {
    const t = makeTransport(10);
    void t.connect().catch(() => {});

    const stuck = lastSocket();
    expect(stuck.readyState).toBe(0);
    expect(t.state).toBe("connecting");

    await vi.advanceTimersByTimeAsync(10);

    expect(stuck.closeCalls).toBe(1);
    expect(t.state).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(5);
    expect(FakeSocket.instances).toHaveLength(2);

    lastSocket().open();
    await Promise.resolve();
    expect(t.state).toBe("connected");
    await t.disconnect();
  });

  it("leaves a socket that opens in time untouched", async () => {
    const t = makeTransport(10);
    const pending = t.connect();

    await vi.advanceTimersByTimeAsync(5);
    const socket = lastSocket();
    socket.open();
    await pending;
    expect(t.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.closeCalls).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);
    await t.disconnect();
  });

  it("clears the connect timer on disconnect", async () => {
    const t = makeTransport(10);
    void t.connect().catch(() => {});
    const socket = lastSocket();

    await t.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(socket.closeCalls).toBe(1);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
