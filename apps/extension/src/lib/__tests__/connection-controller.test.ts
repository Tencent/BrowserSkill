import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_COMPATIBLE_PROTOCOL } from "../../transport/handshake";
import type { ConnectionStateHandler, Transport } from "../../transport/transport";
import type { ConnectionState, HandshakeResult } from "../../transport/types";
import { __testing__, ConnectionController } from "../connection-controller";

vi.mock("../instance-id", () => ({
  getOrCreateInstanceId: vi.fn(async () => "a1b2c3d4"),
  getLabel: vi.fn(async () => "test-label"),
}));

const { computeConnectedState } = __testing__;

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
  it("returns connected when protocol strings match", () => {
    expect(computeConnectedState(handshake("1.0", "1.0"), MIN_COMPATIBLE_PROTOCOL)).toEqual({
      kind: "connected",
    });
  });

  it("returns version_skew when daemon protocol minor is newer", () => {
    expect(computeConnectedState(handshake("1.1", "1.0"))).toEqual({
      kind: "version_skew",
    });
  });

  it("returns version_skew when daemon protocol string differs but floor is satisfied", () => {
    expect(computeConnectedState(handshake("1", "1.0"))).toEqual({
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
    const result = computeConnectedState(handshake("1.0", "1.5"));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("min_compatible_protocol");
      expect(result.reason).toContain("1.5");
    }
  });

  it("does not reject when min_compatible_protocol is missing (legacy daemon)", () => {
    const result = computeConnectedState({
      server: "browser-skill-daemon",
      version: "0.1.0",
      protocol_version: "1.0",
      min_compatible_peer: "0.1.0",
    });
    expect(result).toEqual({ kind: "connected" });
  });

  it("rejects when daemon protocol is below extension floor", () => {
    const result = computeConnectedState(handshake("1.0", "1.0"), "1.1");
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("below extension min_compatible_protocol");
    }
  });

  it("rejects malformed daemon min_compatible_protocol with a daemon-floor reason", () => {
    const result = computeConnectedState(handshake("1.0", "not-a-protocol"));
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
    onMessage: vi.fn(() => ({ dispose: () => {} })),
    onConnectionStateChange: vi.fn((handler: ConnectionStateHandler) => {
      stateHandlers.add(handler);
      return { dispose: () => stateHandlers.delete(handler) };
    }),
    emitState(next: ConnectionState) {
      state = next;
      for (const h of stateHandlers) h(next);
    },
  };
  return transport as typeof transport & Transport;
}

describe("ConnectionController connectionEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("reconnects when connection is re-enabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, false);
    await controller.setConnectionEnabled(true);

    expect(transport.connect).toHaveBeenCalled();
    expect(controller.snapshot().connectionEnabled).toBe(true);
  });

  it("ignores transport state changes while disabled", async () => {
    const controller = new ConnectionController();
    const transport = makeMockTransport();
    await controller.attach(transport, { name: "Chrome", version: "120" }, false);

    transport.emitState("connected");

    expect(controller.snapshot().state).toBe("disconnected");
  });
});
