import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION } from "../../transport/handshake";
import type { ConnectionStateHandler, FrameHandler, Transport } from "../../transport/transport";
import type {
  ConnectionState,
  HandshakeResult,
  ProtocolFrame,
  RpcError,
} from "../../transport/types";
import { __testing__, ConnectionController } from "../connection-controller";
import { getLabel } from "../instance-id";

vi.mock("../instance-id", () => ({
  getOrCreateInstanceId: vi.fn(async () => "a1b2c3d4"),
  getLabel: vi.fn(async () => "test-label"),
}));

const { computeConnectedState } = __testing__;
const [protocolMajor, protocolMinor] = PROTOCOL_VERSION.split(".");
const newerProtocol = `${protocolMajor}.${Number(protocolMinor) + 1}`;

function handshake(
  daemonProtocol: string,
  minCompatibleProtocol?: string,
  daemonAppVersion = "0.1.0",
): HandshakeResult {
  return {
    server: "browser-skill-daemon",
    version: daemonAppVersion,
    protocol_version: daemonProtocol,
    min_compatible_peer: "0.0.0",
    min_compatible_protocol: minCompatibleProtocol,
  };
}

describe("computeConnectedState (protocol-based compat)", () => {
  it("returns connected when daemon protocol equals extension protocol", () => {
    expect(
      computeConnectedState(handshake(PROTOCOL_VERSION, PROTOCOL_VERSION), MIN_COMPATIBLE_PROTOCOL),
    ).toEqual({
      kind: "connected",
    });
  });

  it("returns version_skew when daemon protocol minor is newer", () => {
    expect(computeConnectedState(handshake(newerProtocol, PROTOCOL_VERSION))).toEqual({
      kind: "version_skew",
    });
  });

  it("returns version_skew when daemon protocol string differs but floor is satisfied", () => {
    expect(computeConnectedState(handshake(`${PROTOCOL_VERSION}.0`, PROTOCOL_VERSION))).toEqual({
      kind: "version_skew",
    });
  });

  it("rejects when protocol major differs", () => {
    const result = computeConnectedState(handshake("2.0", "1.0"));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("protocol-major mismatch");
    }
  });

  it("rejects when extension is below daemon min_compatible_protocol", () => {
    const result = computeConnectedState(handshake(PROTOCOL_VERSION, newerProtocol));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("min_compatible_protocol");
      expect(result.reason).toContain(newerProtocol);
    }
  });

  it("does not reject when min_compatible_protocol is missing (legacy daemon)", () => {
    const result = computeConnectedState({
      server: "browser-skill-daemon",
      version: "0.1.0",
      protocol_version: PROTOCOL_VERSION,
      min_compatible_peer: "0.1.0",
    });
    expect(result).toEqual({ kind: "connected" });
  });

  it.each([
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
  ])("rejects a daemon %s without terminal session events", (protocol) => {
    for (const floor of [undefined, "1.0"]) {
      expect(computeConnectedState(handshake(protocol, floor))).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining("extension min_compatible_protocol 1.6"),
      });
    }
  });

  it("rejects malformed daemon min_compatible_protocol with a daemon-floor reason", () => {
    const result = computeConnectedState(handshake(PROTOCOL_VERSION, "not-a-protocol"));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("daemon min_compatible_protocol");
      expect(result.reason).toContain("not-a-protocol");
    }
  });

  it("rejects unparseable daemon protocol", () => {
    const result = computeConnectedState(handshake("oops", "1.0"));
    expect(result.kind).toBe("rejected");
  });
});

function makeMockTransport(initialState: ConnectionState = "disconnected") {
  let state = initialState;
  const stateHandlers = new Set<ConnectionStateHandler>();
  const messageHandlers = new Set<FrameHandler>();
  const transport = {
    get state() {
      return state;
    },
    connect: vi.fn(async () => {
      state = "connected";
      for (const h of stateHandlers) h("connected");
    }),
    disconnect: vi.fn(async () => {
      state = "disconnected";
      for (const h of stateHandlers) h("disconnected");
    }),
    send: vi.fn(),
    onMessage: vi.fn((handler: FrameHandler) => {
      messageHandlers.add(handler);
      return { dispose: () => messageHandlers.delete(handler) };
    }),
    onConnectionStateChange: vi.fn((handler: ConnectionStateHandler) => {
      stateHandlers.add(handler);
      return { dispose: () => stateHandlers.delete(handler) };
    }),
    emitState(next: ConnectionState) {
      state = next;
      for (const h of stateHandlers) h(next);
    },
    emitMessage(frame: ProtocolFrame) {
      for (const handler of messageHandlers) handler(frame);
    },
  };
  return transport as typeof transport & Transport;
}

describe("ConnectionController connectionEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
  ])("disconnects a daemon %s that cannot handle terminal session events", async (protocol) => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    const onDisconnected = vi.fn();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true, {
      onDisconnected,
    });
    const request = transport.send.mock.calls[0]?.[0] as { id: string };
    transport.emitMessage({ id: request.id, result: handshake(protocol, "1.0") });
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
    expect(controller.snapshot().state).toBe("disconnected");
    expect(controller.snapshot().handshake).toBeNull();
    expect(controller.snapshot().lastError).toContain("version_too_old");
    expect(controller.snapshot().daemonUpgradeRequired).toEqual({
      daemonVersion: "0.1.0",
      daemonProtocolVersion: protocol,
      requiredProtocolVersion: MIN_COMPATIBLE_PROTOCOL,
    });
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("does not connect on attach when connection is disabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, false);

    expect(transport.connect).not.toHaveBeenCalled();
    expect(controller.snapshot().connectionEnabled).toBe(false);
    expect(controller.snapshot().state).toBe("disconnected");
  });

  it("disconnects when connection is disabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    expect(transport.connect).toHaveBeenCalled();

    await controller.setConnectionEnabled(false);

    expect(transport.disconnect).toHaveBeenCalled();
    expect(controller.snapshot().connectionEnabled).toBe(false);
    expect(controller.snapshot().handshake).toBeNull();
    expect(controller.snapshot().lastError).toBeNull();
  });

  it("runs safe session cleanup before an intentional disconnect", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    const order: string[] = [];
    transport.disconnect.mockImplementation(async () => {
      order.push("disconnect");
    });
    await controller.attach(transport, { name: "Chrome", version: "120" }, true, {
      beforeDisconnect: async () => {
        order.push("cleanup");
      },
    });

    await controller.setConnectionEnabled(false);

    expect(order).toEqual(["cleanup", "disconnect"]);
  });

  it("runs session cleanup when the transport disconnects unexpectedly", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    const onDisconnected = vi.fn(async () => {});
    await controller.attach(transport, { name: "Chrome", version: "120" }, true, {
      onDisconnected,
    });

    transport.emitState("disconnected");
    await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1));
  });

  it("reconnects when connection is re-enabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, false);
    await controller.setConnectionEnabled(true);

    expect(transport.connect).toHaveBeenCalled();
    expect(controller.snapshot().connectionEnabled).toBe(true);
  });

  it("reconnects after a saved label changes so the daemon receives it", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    const onDisconnected = vi.fn(async () => {});
    await controller.attach(transport, { name: "Chrome", version: "120" }, true, {
      onDisconnected,
    });
    const first = transport.send.mock.calls[0]?.[0] as { id: string };
    transport.emitMessage({ id: first.id, result: handshake(PROTOCOL_VERSION, PROTOCOL_VERSION) });
    await vi.waitFor(() => expect(controller.snapshot().state).toBe("connected"));

    vi.mocked(getLabel).mockResolvedValueOnce("Work profile");
    await controller.refreshLabel();
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));

    const second = transport.send.mock.calls[1]?.[0] as {
      params: { label: string };
    };
    expect(second.params.label).toBe("Work profile");
    expect(controller.snapshot().label).toBe("Work profile");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when the saved label is unchanged", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);

    await controller.refreshLabel();

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it("ignores transport state changes while disabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, false);

    transport.emitState("connected");

    expect(controller.snapshot().state).toBe("disconnected");
  });

  it("disconnects and retries when handshake fails while the socket is still open", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    const request = transport.send.mock.calls[0]?.[0] as { id: string };

    transport.emitMessage({
      id: request.id,
      error: { code: "protocol_error", message: "bad handshake" },
    });
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledTimes(1));
    expect(controller.snapshot().state).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connect).toHaveBeenCalledTimes(2);
  });

  const oldDaemonError: RpcError = {
    code: "version_too_old",
    message: "local protocol 1.3 is below peer min_compatible_protocol 1.6",
    data: {
      daemon_version: "0.3.3",
      daemon_protocol_version: "1.3",
      // This is the daemon's extension floor, not the daemon version we require.
      min_compatible_protocol: "1.0",
    },
  };
  const expectedUpgrade = {
    daemonVersion: "0.3.3",
    daemonProtocolVersion: "1.3",
    requiredProtocolVersion: "1.6",
  };

  function rejectHandshake(
    transport: ReturnType<typeof makeMockTransport>,
    error = oldDaemonError,
  ) {
    const request = transport.send.mock.calls.at(-1)?.[0] as { id: string };
    transport.emitMessage({ id: request.id, error });
  }

  it("retains daemon upgrade guidance when a rejection is immediately followed by socket close", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    const onDisconnected = vi.fn();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true, {
      onDisconnected,
    });

    rejectHandshake(transport);
    transport.emitState("disconnected");
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));

    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);
    expect(controller.snapshot().lastError).toContain("local protocol 1.3");
    expect(controller.snapshot().handshake).toBeNull();
    await controller.setConnectionEnabled(false);
  });

  it("keeps guidance through retries and network errors, then clears it after daemon upgrade", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);

    rejectHandshake(transport);
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connect).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);

    transport.connect.mockRejectedValueOnce(new Error("connection refused"));
    transport.emitState("disconnected");
    await vi.waitFor(() => expect(controller.snapshot().lastError).toBe("connection refused"));
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);

    controller.requestConnect();
    const request = transport.send.mock.calls.at(-1)?.[0] as { id: string };
    transport.emitMessage({ id: request.id, result: handshake(PROTOCOL_VERSION, "1.0", "0.4.0") });
    await vi.waitFor(() => expect(controller.snapshot().state).toBe("connected"));
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toBeNull();
    await controller.setConnectionEnabled(false);
  });

  it.each([
    {
      code: "version_too_old",
      message: "extension protocol is below the daemon's minimum",
      data: { daemon_protocol_version: "1.6" },
    },
    {
      code: "version_too_old",
      message: "protocol major mismatch",
      data: { daemon_protocol_version: "2.0" },
    },
    {
      code: "version_too_old",
      message: "protocol version unparseable",
      data: { daemon_protocol_version: "invalid" },
    },
    { code: "protocol_error", message: "bad handshake" },
  ] satisfies RpcError[])("replaces old daemon guidance with a fresh rejection: %j", async (error) => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    rejectHandshake(transport);
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);

    await vi.advanceTimersByTimeAsync(1_000);
    rejectHandshake(transport, error);
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toContain(error.message);
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledTimes(2));
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toContain(error.message);
    await controller.setConnectionEnabled(false);
  });

  it("clears daemon upgrade guidance when the user disables the connection", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    rejectHandshake(transport);
    expect(controller.snapshot().daemonUpgradeRequired).toEqual(expectedUpgrade);

    await controller.setConnectionEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toBeNull();
    expect(transport.connect).toHaveBeenCalledOnce();
  });

  it("does not carry a rejected daemon's guidance into a different endpoint", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.reconfigureTransport("local:10999", () => {});
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    const oldRequest = transport.send.mock.calls[0]?.[0] as { id: string };
    rejectHandshake(transport);

    await controller.reconfigureTransport("local:11000", () => {});
    transport.emitMessage({ id: oldRequest.id, error: oldDaemonError });
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toBeNull();
    expect(transport.connect).toHaveBeenCalledTimes(2);
    await controller.setConnectionEnabled(false);
  });

  it("recognizes an old daemon even when its application version is missing", async () => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    rejectHandshake(transport, {
      ...oldDaemonError,
      data: { daemon_protocol_version: "1.3" },
    });
    expect(controller.snapshot().daemonUpgradeRequired).toEqual({
      ...expectedUpgrade,
      daemonVersion: null,
    });
    await controller.setConnectionEnabled(false);
  });

  it.each([
    { code: "protocol_error", message: "bad handshake", data: oldDaemonError.data },
    { code: "version_too_old", message: "upgrade", data: undefined },
    { code: "version_too_old", message: "upgrade", data: { daemon_protocol_version: "invalid" } },
    { code: "version_too_old", message: "upgrade", data: { daemon_protocol_version: 1.3 } },
    {
      code: "version_too_old",
      message: "extension too old",
      data: { daemon_protocol_version: "1.6" },
    },
    {
      code: "version_too_old",
      message: "extension too old",
      data: { daemon_protocol_version: "2.0" },
    },
  ] satisfies RpcError[])("does not misidentify other failures as an old daemon: %j", async (error) => {
    vi.useFakeTimers();
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    rejectHandshake(transport, error);
    await vi.waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
    expect(controller.snapshot().daemonUpgradeRequired).toBeNull();
    expect(controller.snapshot().lastError).toContain(error.message);
    await controller.setConnectionEnabled(false);
  });

  it("binds each handshake to the connection that initiated it", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, true);
    const first = transport.send.mock.calls[0]?.[0] as { id: string };

    transport.emitState("disconnected");
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2));
    const second = transport.send.mock.calls[1]?.[0] as { id: string };
    expect(second.id).not.toBe(first.id);

    transport.emitMessage({ id: first.id, result: handshake(PROTOCOL_VERSION, PROTOCOL_VERSION) });
    await Promise.resolve();
    expect(controller.snapshot().state).not.toBe("connected");

    transport.emitMessage({ id: second.id, result: handshake(PROTOCOL_VERSION, PROTOCOL_VERSION) });
    await vi.waitFor(() => expect(controller.snapshot().state).toBe("connected"));
  });
});
