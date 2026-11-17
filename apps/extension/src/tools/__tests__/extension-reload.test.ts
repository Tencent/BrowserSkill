import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame, RequestFrame, ResponseFrame } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";

function fakeTransport() {
  let handler: ((frame: ProtocolFrame) => void) | undefined;
  const sent: ResponseFrame[] = [];
  const transport: Transport = {
    state: "connected",
    connect: async () => {},
    disconnect: async () => {},
    send: (frame) => sent.push(frame as ResponseFrame),
    onMessage: (next) => {
      handler = next;
      return { dispose: () => (handler = undefined) };
    },
    onConnectionStateChange: () => ({ dispose: () => {} }),
  };
  return {
    transport,
    sent,
    deliver: (frame: RequestFrame) => handler?.(frame),
  };
}

describe("extension.reload", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges an explicit reload only while idle, then reloads the extension", async () => {
    vi.useFakeTimers();
    const { transport, sent, deliver } = fakeTransport();
    const reloadExtension = vi.fn();
    const dispatcher = new ToolDispatcher({
      transport,
      sessions: new SessionManager(),
      reloadExtension,
    });
    dispatcher.start();

    deliver({
      id: "reload-1",
      method: "extension.reload",
      params: { browser_instance_id: "b1234567" },
    });

    expect(sent).toEqual([
      {
        id: "reload-1",
        result: { scheduled: true, browser_instance_id: "b1234567" },
      },
    ]);
    expect(reloadExtension).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(reloadExtension).toHaveBeenCalledOnce();
    dispatcher.stop();
  });

  it("refuses a reload while a session is active", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const reloadExtension = vi.fn();
    const sessions = { list: () => [{ sessionId: "active" }] } as unknown as SessionManager;
    const dispatcher = new ToolDispatcher({ transport, sessions, reloadExtension });
    dispatcher.start();

    deliver({
      id: "reload-2",
      method: "extension.reload",
      params: { browser_instance_id: "b1234567" },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toMatchObject({
      id: "reload-2",
      error: { code: "unsupported", data: { reason: "session_busy" } },
    });
    expect(reloadExtension).not.toHaveBeenCalled();
    dispatcher.stop();
  });

  it("rejects a reload request without a browser instance id", () => {
    const { transport, sent, deliver } = fakeTransport();
    const reloadExtension = vi.fn();
    const dispatcher = new ToolDispatcher({
      transport,
      sessions: new SessionManager(),
      reloadExtension,
    });
    dispatcher.start();

    deliver({ id: "reload-3", method: "extension.reload", params: {} });

    expect(sent).toMatchObject([{ id: "reload-3", error: { code: "invalid_params" } }]);
    expect(reloadExtension).not.toHaveBeenCalled();
    dispatcher.stop();
  });
});
