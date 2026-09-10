import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@/transport/handshake";
import { WSTransport } from "@/transport/ws-transport";
import { ConnectionController } from "../connection-controller";
import { getLabel } from "../instance-id";

vi.mock("../instance-id", () => ({
  getOrCreateInstanceId: vi.fn(async () => "a1b2c3d4"),
  getLabel: vi.fn(async () => "test-label"),
}));

class Socket extends EventTarget {
  readyState = 0;
  sent: Array<{ id: string }> = [];
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  reply(protocol = PROTOCOL_VERSION) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: this.sent[0].id,
          result: { server: "browser-skill-daemon", version: "0.1.0", protocol_version: protocol },
        }),
      }),
    );
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function setup(cleanup = vi.fn(async () => {})) {
  const sockets: Socket[] = [];
  const transport = new WSTransport({
    url: "ws://127.0.0.1:52800",
    webSocketFactory: (url) => {
      const socket = new Socket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const controller = new ConnectionController();
  const configure = (port: number) => {
    const url = `ws://127.0.0.1:${port}`;
    return controller.reconfigureTransport(url, () => {
      transport.setUrl(url);
    });
  };
  const attach = (enabled = true) =>
    controller.attach(transport, { name: "Chrome", version: "125" }, enabled, {
      beforeDisconnect: cleanup,
      onDisconnected: cleanup,
    });
  return { controller, transport, sockets, configure, attach, cleanup };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection reconfiguration with WSTransport", () => {
  it("finishes initialization even when the first socket never opens", async () => {
    const s = setup();
    s.controller.requestConnect();
    expect(s.sockets).toHaveLength(0);
    await s.configure(53200);
    await s.attach();
    expect(s.sockets.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:53200"]);
    await s.configure(53300);
    expect(s.sockets.at(-1)?.url).toBe("ws://127.0.0.1:53300");
    await s.controller.setConnectionEnabled(false);
    expect(s.transport.state).toBe("disconnected");
    expect(s.controller.snapshot().lastError).toBeNull();
  });

  it("uses configuration and user preference changes received during attach", async () => {
    const gate = deferred();
    vi.mocked(getLabel).mockImplementationOnce(async () => {
      await gate.promise;
      return "test-label";
    });
    const s = setup();
    const attaching = s.attach();
    await flush();
    await s.configure(53200);
    await s.controller.setConnectionEnabled(false);
    s.controller.requestConnect();
    gate.resolve();
    await attaching;
    expect(s.sockets).toHaveLength(0);
    await s.controller.setConnectionEnabled(true);
    expect(s.sockets.at(-1)?.url).toBe("ws://127.0.0.1:53200");
  });

  it("waits for one cleanup, coalesces changes, and rejects wake requests during cleanup", async () => {
    const gate = deferred();
    const s = setup(vi.fn(() => gate.promise));
    await s.attach();
    s.sockets[0].open();
    s.sockets[0].reply();
    await flush();
    const first = s.configure(53200);
    await flush();
    const last = s.configure(53300);
    s.controller.requestConnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.cleanup).toHaveBeenCalledOnce();
    expect(s.controller.snapshot().state).toBe("disconnected");
    gate.resolve();
    await Promise.all([first, last]);
    expect(s.sockets.map((socket) => socket.url)).toEqual([
      "ws://127.0.0.1:52800",
      "ws://127.0.0.1:53300",
    ]);
    await s.configure(53300);
    expect(s.sockets).toHaveLength(2);
    expect(s.cleanup).toHaveBeenCalledOnce();
  });

  it("does not reconnect if disabled during a port change", async () => {
    const gate = deferred();
    const s = setup(vi.fn(() => gate.promise));
    await s.attach();
    s.sockets[0].open();
    const changing = s.configure(53200);
    await flush();
    const disabling = s.controller.setConnectionEnabled(false);
    gate.resolve();
    await Promise.all([changing, disabling]);
    s.controller.requestConnect();
    expect(s.sockets).toHaveLength(1);
    expect(s.controller.snapshot().connectionEnabled).toBe(false);
    expect(s.controller.snapshot().lastError).toBeNull();
  });

  it("honors re-enabling and a port update while user-disable cleanup is pending", async () => {
    const gate = deferred();
    const s = setup(vi.fn(() => gate.promise));
    await s.attach();
    s.sockets[0].open();
    const disabling = s.controller.setConnectionEnabled(false);
    await flush();
    // Losing the socket during cleanup must not resurrect its retry timer.
    s.sockets[0].close();
    await s.controller.setConnectionEnabled(true);
    const changing = s.configure(53200);
    expect(s.controller.snapshot().state).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sockets).toHaveLength(1);
    gate.resolve();
    await Promise.all([disabling, changing]);
    expect(s.cleanup).toHaveBeenCalledOnce();
    expect(s.sockets).toHaveLength(2);
    expect(s.sockets[1].url).toBe("ws://127.0.0.1:53200");
    expect(s.controller.snapshot().connectionEnabled).toBe(true);
  });

  it("cancels a pending handshake retry when reconfiguring", async () => {
    const gate = deferred();
    const s = setup(vi.fn(() => gate.promise));
    await s.attach();
    s.sockets[0].open();
    s.sockets[0].dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: s.sockets[0].sent[0].id,
          error: { code: "protocol_error", message: "bad handshake" },
        }),
      }),
    );
    await flush();
    const changing = s.configure(53200);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.sockets).toHaveLength(1);
    gate.resolve();
    await changing;
    s.sockets[1].open();
    s.sockets[1].reply();
    await flush();
    expect(s.controller.snapshot().lastError).toBeNull();
    expect(s.controller.snapshot().state).toBe("connected");
  });

  it("allows wake-driven recovery after upgrading a rejected daemon", async () => {
    const s = setup();
    await s.attach();
    s.sockets[0].open();
    s.sockets[0].reply("99.0");
    await flush();
    s.controller.requestConnect();
    s.sockets[1].open();
    s.sockets[1].reply();
    await flush();
    expect(s.controller.snapshot().state).toBe("connected");
    expect(s.controller.snapshot().lastError).toBeNull();
  });

  it("shares cleanup already running after unexpected loss", async () => {
    const gate = deferred();
    const s = setup(vi.fn(() => gate.promise));
    await s.attach();
    s.sockets[0].open();
    s.sockets[0].close();
    await flush();
    const changing = s.configure(53200);
    gate.resolve();
    await changing;
    expect(s.cleanup).toHaveBeenCalledOnce();
    expect(s.sockets).toHaveLength(2);
    expect(s.sockets[1].url).toBe("ws://127.0.0.1:53200");
  });

  it("keeps failed cleanup blocking the new endpoint until a retry succeeds", async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("tab return failed"))
      .mockResolvedValue(undefined);
    const s = setup(cleanup);
    await s.attach();
    s.sockets[0].open();
    await s.configure(53200);
    expect(s.sockets).toHaveLength(1);
    expect(s.controller.snapshot().lastError).toBe("tab return failed");
    s.controller.requestConnect();
    await flush();
    expect(s.sockets.at(-1)?.url).toBe("ws://127.0.0.1:53200");
    expect(s.cleanup).toHaveBeenCalledTimes(2);
  });

  it("preserves transport backoff for unreachable endpoints", async () => {
    const s = setup();
    await s.attach();
    s.sockets[0].close();
    await flush();
    expect(s.sockets).toHaveLength(1);
    expect(s.cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.sockets).toHaveLength(2);
    s.sockets[1].close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(s.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sockets).toHaveLength(3);
  });

  it("keeps protocol rejection visible and allows a different endpoint", async () => {
    const s = setup();
    await s.attach();
    s.sockets[0].open();
    s.sockets[0].reply("99.0");
    await flush();
    expect(s.controller.snapshot().lastError).toContain("version_too_old");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sockets).toHaveLength(1);
    await s.configure(53200);
    s.sockets[1].open();
    s.sockets[1].reply();
    await flush();
    expect(s.controller.snapshot().state).toBe("connected");
    expect(s.controller.snapshot().lastError).toBeNull();
  });

  it("does not let a late old handshake clobber the new connection", async () => {
    const s = setup();
    await s.attach();
    s.sockets[0].open();
    await s.configure(53200);
    s.sockets[1].open();
    s.sockets[1].reply();
    await flush();
    s.sockets[0].reply("99.0");
    await flush();
    expect(s.controller.snapshot().state).toBe("connected");
    expect(s.controller.snapshot().lastError).toBeNull();
  });
});
