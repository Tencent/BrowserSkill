import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WSTransport } from "../../transport/ws-transport";
import { ConnectionController } from "../connection-controller";
import { createDiagnosticRecorder, setDiagnosticRecorder } from "../connection-diagnostics";
import { KEEPALIVE_ALARM_NAME, startKeepalive } from "../keepalive";

vi.mock("../instance-id", () => ({
  getOrCreateInstanceId: vi.fn(async () => "private-instance"),
  getLabel: vi.fn(async () => "PRIVATE"),
}));
class Socket {
  readyState = 0;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, callback: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: unknown = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000, wasClean: true, reason: "PRIVATE" });
  }
  serverClose() {
    this.readyState = 3;
    this.emit("close", { code: 1006, wasClean: false, reason: "PRIVATE" });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    if (frame.method === "system.handshake")
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            id: frame.id,
            result: {
              server: "browser-skill-daemon",
              version: "0.3.2",
              protocol_version: "1.3",
              min_compatible_protocol: "1.0",
            },
          }),
        }),
      );
  }
}
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function setup() {
  const recorder = createDiagnosticRecorder(
    { read: async () => undefined, write: async () => {} },
    { bootId: "test-boot", build: "issue395.1" },
  );
  setDiagnosticRecorder(recorder);
  const sockets: Socket[] = [];
  const transport = new WSTransport({
    url: "ws://127.0.0.1:52800/?token=PRIVATE",
    webSocketFactory() {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { recorder, sockets, transport };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setDiagnosticRecorder(null);
  vi.useRealTimers();
});

it("records the actual keepalive callback and the controller gate for a pending physical connection", async () => {
  const { recorder, transport } = setup();
  const controller = new ConnectionController();
  controller.requestConnect();
  await controller.attach(transport, { name: "edge", version: "155" });
  let alarmCallback!: (alarm: { name: string }) => void;
  const keepalive = startKeepalive({
    transport,
    requestConnect: () => controller.requestConnect(),
    alarms: {
      create() {},
      clear() {},
      onAlarm: {
        addListener(callback) {
          alarmCallback = callback;
        },
        removeListener() {},
      },
    },
  });
  alarmCallback({ name: KEEPALIVE_ALARM_NAME });
  await drain();
  const events = recorder.snapshot().events;
  expect(
    events.some((e) => e.type === "controller.request" && e.details.gate === "not-ready"),
  ).toBe(true);
  expect(
    events.some(
      (e) =>
        e.type === "controller.request" &&
        e.details.gate === "transport-state" &&
        e.details.state === "connecting",
    ),
  ).toBe(true);
  expect(events.some((e) => e.type === "alarm.tick")).toBe(true);
  keepalive.dispose();
  await controller.setConnectionEnabled(false);
});

it("distinguishes an unfinished cleanup from a pending socket without releasing the gate", async () => {
  const { recorder, sockets, transport } = setup();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new ConnectionController();
  await controller.attach(transport, { name: "edge", version: "155" }, true, {
    onDisconnected: () => pending,
  });
  sockets[0].open();
  await drain();
  expect(controller.snapshot().state).toBe("connected");
  sockets[0].serverClose();
  await drain();
  controller.requestConnect();
  try {
    const events = recorder.snapshot().events;
    expect(events.some((e) => e.type === "cleanup.begin")).toBe(true);
    expect(events.some((e) => e.type === "cleanup.complete")).toBe(false);
    expect(
      events.some((e) => e.type === "controller.request" && e.details.gate === "transition"),
    ).toBe(true);
  } finally {
    release();
    await drain();
    await controller.setConnectionEnabled(false);
  }
});

it("records a native close code and generation without socket URL, close text or handshake data", async () => {
  const { recorder, sockets, transport } = setup();
  const pending = transport.connect();
  sockets[0].open();
  await pending;
  sockets[0].serverClose();
  expect(recorder.snapshot().events.find((e) => e.type === "socket.close")?.details).toMatchObject({
    code: 1006,
    generation: 1,
    current: true,
  });
  expect(JSON.stringify(recorder.snapshot())).not.toContain("PRIVATE");
  await transport.disconnect();
});

it("preserves transport behavior even when the observation sink throws", async () => {
  const { sockets, transport } = setup();
  setDiagnosticRecorder({
    record() {
      throw new Error("observer failed");
    },
  });
  const pending = transport.connect();
  sockets[0].open();
  await expect(pending).resolves.toBeUndefined();
  expect(transport.state).toBe("connected");
  await expect(transport.disconnect()).resolves.toBeUndefined();
});
