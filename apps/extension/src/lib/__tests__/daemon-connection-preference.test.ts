import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRemoteConnection } from "@/transport/remote-storage";
import { WSTransport } from "@/transport/ws-transport";
import { ConnectionController } from "../connection-controller";
import { watchDaemonConnection } from "../daemon-connection-preference";

vi.mock("../instance-id", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-id")>()),
  getOrCreateInstanceId: async () => "test-browser",
  getLabel: async () => "test-label",
}));

vi.mock("@/transport/remote-storage", () => ({
  initializeRemoteStorage: async () => {},
  readRemoteConnection: vi.fn(),
  REMOTE_CONNECTION_REVISION: "revision",
  REMOTE_CONNECTION_MODE: "mode",
}));
let changed: (values: unknown, area: string) => void;
beforeEach(() => {
  vi.mocked(readRemoteConnection).mockReset();
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: async () => ({ bsk_daemon_port: 1234 }) },
      onChanged: {
        addListener: (fn: typeof changed) => {
          changed = fn;
        },
        removeListener: vi.fn(),
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("a late startup read cannot overwrite newer credentials", async () => {
  let finish!: (value: null) => void;
  vi.mocked(readRemoteConnection).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const callback = vi.fn();
  const watch = watchDaemonConnection(callback);
  await vi.waitFor(() => expect(readRemoteConnection).toHaveBeenCalledOnce());
  const remote = { url: "wss://example.com/bsk", token: "a".repeat(43) };
  vi.mocked(readRemoteConnection).mockResolvedValueOnce(remote);
  changed({ revision: {} }, "local");
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(remote.url, remote));
  finish(null);
  await watch.ready;
  expect(callback).toHaveBeenCalledTimes(1);
  watch.dispose();
});
it("disposal prevents pending reads from configuring a connection", async () => {
  vi.mocked(readRemoteConnection).mockResolvedValue(null);
  const callback = vi.fn();
  const watch = watchDaemonConnection(callback);
  watch.dispose();
  await Promise.resolve();
  expect(callback).not.toHaveBeenCalled();
});
it("corrupt remote storage fails closed instead of selecting localhost", async () => {
  vi.mocked(readRemoteConnection).mockRejectedValue(new Error("invalid storage"));
  const callback = vi.fn();
  const error = vi.fn();
  const watch = watchDaemonConnection(callback, error);
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  await watch.ready;
  expect(callback).not.toHaveBeenCalled();
  watch.dispose();
});
it("an explicit local selection can recover startup after a failed remote read", async () => {
  vi.mocked(readRemoteConnection).mockRejectedValueOnce(new Error("invalid storage"));
  const callback = vi.fn();
  const error = vi.fn();
  const watch = watchDaemonConnection(callback, error);
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(callback).not.toHaveBeenCalled();
  vi.mocked(readRemoteConnection).mockResolvedValue(null);
  changed({ mode: {} }, "local");
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("ws://127.0.0.1:1234", null));
  watch.dispose();
});

it.each([true, false])("recovers failed startup while preserving enabled=%s", async (enabled) => {
  vi.useFakeTimers();
  vi.mocked(readRemoteConnection).mockRejectedValue(new Error("invalid storage"));
  const error = vi.fn();
  const createSocket = vi.fn((_url: string) =>
    Object.assign(new EventTarget(), { close: vi.fn() }),
  );
  let valid = false;
  const transport = new WSTransport({
    url: "ws://127.0.0.1:52800",
    webSocketFactory: (url) => {
      if (!valid) throw new Error("Connection settings are unavailable");
      return createSocket(url) as unknown as WebSocket;
    },
  });
  const controller = new ConnectionController();
  const watch = watchDaemonConnection((url) => {
    void controller.reconfigureTransport(url, () => {
      valid = true;
      transport.setUrl(url);
    });
  }, error);
  await watch.ready;
  await controller.attach(transport, { name: "Chrome", version: "125" }, enabled);
  expect(error).toHaveBeenCalledOnce();
  expect(controller.snapshot()).toMatchObject({
    state: "disconnected",
    connectionEnabled: enabled,
    lastError: enabled ? "Connection settings are unavailable" : null,
  });
  expect(transport.state).toBe("disconnected");
  expect(createSocket).not.toHaveBeenCalled();

  // Periodic storage recovery must also work without a settings-change event.
  vi.mocked(readRemoteConnection).mockResolvedValue({
    url: "wss://example.com/bsk",
    token: "a".repeat(43),
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(controller.snapshot().lastError).toBeNull();
  expect(controller.isConnectionEnabled).toBe(enabled);
  if (!enabled) {
    expect(createSocket).not.toHaveBeenCalled();
    await controller.setConnectionEnabled(true);
  }
  expect(createSocket).toHaveBeenCalledExactlyOnceWith("wss://example.com/bsk");
  watch.dispose();
  await controller.setConnectionEnabled(false);
});
