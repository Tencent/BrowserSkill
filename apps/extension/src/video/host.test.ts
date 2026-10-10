import { afterEach, expect, it, vi } from "vitest";
import { BrowserVideoHost } from "./host";
import type { VideoHostCommand, VideoHostReply } from "./host-protocol";

function setup() {
  function connect() {
    const messages = new Set<(reply: VideoHostReply) => void>();
    const disconnects = new Set<() => void>();
    const port = {
      onMessage: { addListener: (fn: (reply: VideoHostReply) => void) => messages.add(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn) },
      postMessage: vi.fn((message: { id: string; command: VideoHostCommand }) => {
        queueMicrotask(() =>
          port.reply({ id: message.id, result: message.command.action === "idle" }),
        );
      }),
      disconnect: vi.fn(() => {
        for (const fn of disconnects) fn();
      }),
      reply: (reply: VideoHostReply) => {
        for (const fn of messages) fn(reply);
      },
    };
    return port;
  }
  const ports: ReturnType<typeof connect>[] = [];
  const offscreen = {
    hasDocument: vi.fn(async () => false),
    createDocument: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    Reason: { WORKERS: "WORKERS", BLOBS: "BLOBS" },
  };
  const runtime = {
    connect: vi.fn(() => {
      const port = connect();
      ports.push(port);
      return port;
    }),
    sendMessage: vi.fn(),
  };
  vi.stubGlobal("chrome", { offscreen, runtime });
  return { host: new BrowserVideoHost(), offscreen, runtime, ports };
}

afterEach(() => vi.unstubAllGlobals());

it("reuses a Port and never checks the offscreen document for each frame", async () => {
  const { host, offscreen, runtime, ports } = setup();
  await Promise.all(
    Array.from({ length: 50 }, (_, elapsed_ms) =>
      host.request({
        action: "frame",
        recording_id: "test",
        image: "frame",
        elapsed_ms,
      }),
    ),
  );
  expect(offscreen.hasDocument).toHaveBeenCalledOnce();
  expect(offscreen.createDocument).toHaveBeenCalledOnce();
  expect(runtime.connect).toHaveBeenCalledOnce();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(ports[0].postMessage).toHaveBeenCalledTimes(50);
  await host.closeWhenIdle();
  expect(offscreen.closeDocument).toHaveBeenCalledOnce();
});

it("correlates replies, preserves error details and ignores late replies", async () => {
  const { host, ports } = setup();
  await host.request({ action: "idle" });
  ports[0].postMessage.mockImplementation(() => {});
  const a = host.request({ action: "idle" });
  const b = host.request({ action: "idle" });
  const failed = expect(b).rejects.toMatchObject({
    code: "unsupported",
    message: "codec",
    data: { codec: "avc" },
  });
  await vi.waitFor(() => expect(ports[0].postMessage).toHaveBeenCalledTimes(3));
  const [first, second] = ports[0].postMessage.mock.calls.slice(1).map(([message]) => message.id);
  ports[0].reply({
    id: second,
    error: { code: "unsupported", message: "codec", data: { codec: "avc" } },
  });
  ports[0].reply({ id: first, result: "first" });
  ports[0].reply({ id: second, result: "late" });
  expect(await a).toBe("first");
  await failed;
});

it("rejects in-flight requests on disconnect and reconnects for recovery", async () => {
  const { host, ports, runtime } = setup();
  await host.request({ action: "idle" });
  ports[0].postMessage.mockImplementation(() => {});
  const pending = host.request({
    action: "frame",
    recording_id: "test",
    image: "frame",
    elapsed_ms: 0,
  });
  const failed = expect(pending).rejects.toThrow("disconnected");
  await vi.waitFor(() => expect(ports[0].postMessage).toHaveBeenCalledTimes(2));
  ports[0].disconnect();
  await failed;
  await host.request({ action: "idle" });
  expect(runtime.connect).toHaveBeenCalledTimes(2);
  // A stale disconnect must not invalidate the replacement connection.
  ports[0].disconnect();
  await host.request({ action: "idle" });
  expect(runtime.connect).toHaveBeenCalledTimes(2);
});

it("does not close a host with a pending frame or a live download URL", async () => {
  const { host, ports, offscreen } = setup();
  await host.request({ action: "idle" });
  ports[0].postMessage.mockImplementation(() => {});
  const frame = host.request({
    action: "frame",
    recording_id: "test",
    image: "frame",
    elapsed_ms: 0,
  });
  await vi.waitFor(() => expect(ports[0].postMessage).toHaveBeenCalledTimes(2));
  await host.closeWhenIdle();
  expect(offscreen.closeDocument).not.toHaveBeenCalled();
  ports[0].reply({ id: ports[0].postMessage.mock.calls[1][0].id });
  await frame;
  ports[0].postMessage.mockImplementation(({ id }) =>
    queueMicrotask(() => ports[0].reply({ id, result: false })),
  );
  await host.closeWhenIdle();
  expect(offscreen.closeDocument).not.toHaveBeenCalled();
});

it("closes an idle document left by a previous background worker without creating one", async () => {
  const { host, offscreen } = setup();
  await host.closeWhenIdle();
  expect(offscreen.createDocument).not.toHaveBeenCalled();
  offscreen.hasDocument.mockResolvedValue(true);
  await host.closeWhenIdle();
  expect(offscreen.createDocument).not.toHaveBeenCalled();
  expect(offscreen.closeDocument).toHaveBeenCalledOnce();
});
