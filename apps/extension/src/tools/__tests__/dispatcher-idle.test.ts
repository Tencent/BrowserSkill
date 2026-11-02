import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const create = vi.fn(async () => ({ windowId: 10, initialTabIds: [100] }));
  const remove = vi.fn(async () => {});
  const sessions = new SessionManager({
    agentWindow: { create, remove, ensureActiveTab: async () => 100 },
  });
  let receive!: FrameHandler;
  const send = vi.fn<(frame: ProtocolFrame) => void>();
  const transport: Transport = {
    state: "connected",
    connect: async () => {},
    disconnect: async () => {},
    send,
    onMessage: (handler) => {
      receive = handler;
      return { dispose: () => {} };
    },
    onConnectionStateChange: () => ({ dispose: () => {} }),
  };
  const dispatcher = new ToolDispatcher({ transport, sessions });
  dispatcher.start();
  const start = (id: string) =>
    receive({ id, method: "tool.session_start", params: { session_id: id } });
  return { dispatcher, sessions, create, remove, send, receive, start };
}

describe("idle connection changes", () => {
  it("leaves an existing session alone", async () => {
    const s = setup();
    await s.sessions.start("active");
    const change = vi.fn(async () => {});

    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(s.sessions.has("active")).toBe(true);
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("reserves a start from receipt through asynchronous window creation", async () => {
    const s = setup();
    const window = deferred<{ windowId: number; initialTabIds: number[] }>();
    s.create.mockImplementationOnce(() => window.promise);
    const change = vi.fn(async () => {});

    s.start("starting");
    // The request has not yet passed the dispatcher's asynchronous preparation.
    expect(s.create).not.toHaveBeenCalled();
    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);
    await vi.waitFor(() => expect(s.create).toHaveBeenCalledOnce());
    expect(s.sessions.list()).toHaveLength(0);
    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);

    window.resolve({ windowId: 10, initialTabIds: [100] });
    await vi.waitFor(() =>
      expect(s.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "starting", result: expect.any(Object) }),
      ),
    );
    expect(s.sessions.has("starting")).toBe(true);
    expect(change).not.toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("rejects starts throughout saving and reconnecting, then allows a fresh request", async () => {
    const s = setup();
    const saved = deferred<void>();
    const reconnected = deferred<void>();
    const reconnect = vi.fn(() => reconnected.promise);
    const change = s.dispatcher.runWhenIdle(async () => {
      await saved.promise;
      await reconnect();
    });

    const expectStartRejected = async (id: string) => {
      s.start(id);
      await vi.waitFor(() =>
        expect(s.send).toHaveBeenCalledWith({
          id,
          error: {
            code: "protocol_error",
            message: "Browser settings are updating; retry session start.",
          },
        }),
      );
      expect(s.create).not.toHaveBeenCalled();
      expect(s.sessions.list()).toHaveLength(0);
    };
    await expectStartRejected("during-save");
    saved.resolve();
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce());
    await expectStartRejected("during-reconnect");
    const secondChange = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(secondChange)).toBe(false);
    expect(secondChange).not.toHaveBeenCalled();

    reconnected.resolve();
    expect(await change).toBe(true);
    s.start("retry");
    await vi.waitFor(() => expect(s.sessions.has("retry")).toBe(true));
    expect(s.create).toHaveBeenCalledOnce();
    expect(s.remove).not.toHaveBeenCalled();
  });

  it("releases the reservation when a settings update fails", async () => {
    const s = setup();
    await expect(
      s.dispatcher.runWhenIdle(async () => {
        throw new Error("storage unavailable");
      }),
    ).rejects.toThrow("storage unavailable");

    s.start("retry");
    await vi.waitFor(() => expect(s.sessions.has("retry")).toBe(true));
    expect(s.create).toHaveBeenCalledOnce();
  });

  it("allows a connection change after a failed session start", async () => {
    const s = setup();
    s.create.mockRejectedValueOnce(new Error("window creation failed"));
    s.start("failed");
    await vi.waitFor(() =>
      expect(s.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "failed", error: expect.any(Object) }),
      ),
    );
    const change = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(change)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled start reserved until its window rollback finishes", async () => {
    const s = setup();
    const window = deferred<{ windowId: number; initialTabIds: number[] }>();
    const removed = deferred<void>();
    s.create.mockImplementationOnce(() => window.promise);
    s.remove.mockImplementationOnce(() => removed.promise);
    s.start("cancelled");
    await vi.waitFor(() => expect(s.create).toHaveBeenCalledOnce());
    s.receive({ id: "cancel", method: "cancel", params: { rpc_id: "cancelled" } });
    const change = vi.fn(async () => {});
    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);

    window.resolve({ windowId: 10, initialTabIds: [100] });
    await vi.waitFor(() => expect(s.remove).toHaveBeenCalledWith(10));
    expect(await s.dispatcher.runWhenIdle(change)).toBe(false);
    removed.resolve();
    await vi.waitFor(() =>
      expect(s.send).toHaveBeenCalledWith({
        id: "cancelled",
        error: { code: "cancelled", message: "session_start aborted" },
      }),
    );
    expect(s.remove).toHaveBeenCalledWith(10);
    expect(await s.dispatcher.runWhenIdle(change)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
  });
});
