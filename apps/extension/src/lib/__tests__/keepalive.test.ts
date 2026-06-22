import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@/transport/transport";
import type { ConnectionState } from "@/transport/types";
import { type AlarmsApi, KEEPALIVE_ALARM_NAME, startKeepalive } from "../keepalive";

function makeAlarms(): AlarmsApi & {
  triggers: Array<(alarm: { name: string }) => void>;
  created: Array<{ name: string; info: { periodInMinutes: number } }>;
  cleared: string[];
} {
  const triggers: Array<(alarm: { name: string }) => void> = [];
  const created: Array<{ name: string; info: { periodInMinutes: number } }> = [];
  const cleared: string[] = [];
  return {
    triggers,
    created,
    cleared,
    create: (name, info) => {
      created.push({ name, info });
    },
    clear: (name) => {
      cleared.push(name);
    },
    onAlarm: {
      addListener: (cb) => triggers.push(cb),
      removeListener: (cb) => {
        const idx = triggers.indexOf(cb);
        if (idx >= 0) triggers.splice(idx, 1);
      },
    },
  };
}

function makeTransport(initialState: ConnectionState = "disconnected"): Transport & {
  connectCalls: number;
} {
  let state = initialState;
  const transport = {
    connectCalls: 0,
    get state() {
      return state;
    },
    connect: vi.fn(async () => {
      state = "connected";
      transport.connectCalls += 1;
    }),
    disconnect: vi.fn(async () => {
      state = "disconnected";
    }),
    send: vi.fn(),
    onMessage: vi.fn(() => ({ dispose: () => {} })),
    onConnectionStateChange: vi.fn(() => ({ dispose: () => {} })),
  } as unknown as Transport & { connectCalls: number };
  return transport;
}

describe("startKeepalive", () => {
  it("registers a 30s alarm and a listener on creation", () => {
    const alarms = makeAlarms();
    const transport = makeTransport();
    const handle = startKeepalive({ transport, alarms });

    expect(alarms.created).toEqual([
      { name: KEEPALIVE_ALARM_NAME, info: { periodInMinutes: 0.5 } },
    ]);
    expect(alarms.triggers).toHaveLength(1);

    handle.dispose();
    expect(alarms.cleared).toEqual([KEEPALIVE_ALARM_NAME]);
    expect(alarms.triggers).toHaveLength(0);
  });

  it("kicks transport.connect() when the alarm fires and we are disconnected", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("disconnected");
    startKeepalive({ transport, alarms });

    await Promise.resolve();
    expect(transport.connectCalls).toBe(0);

    // Fire the alarm; allow microtasks to drain.
    alarms.triggers[0]({ name: KEEPALIVE_ALARM_NAME });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
  });

  it("does not call transport.connect() while connected", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("connected");
    startKeepalive({ transport, alarms });

    alarms.triggers[0]({ name: KEEPALIVE_ALARM_NAME });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(0);
  });

  it("ignores alarms for other names", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("disconnected");
    startKeepalive({ transport, alarms });
    alarms.triggers[0]({ name: "someone-else" });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(0);
  });

  it("swallows connect rejections so the alarm loop keeps running", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("disconnected");
    const mockedConnect = transport.connect as unknown as {
      mockImplementation: (fn: () => Promise<void>) => void;
    };
    mockedConnect.mockImplementation(async () => {
      throw new Error("boom");
    });
    const handle = startKeepalive({ transport, alarms });
    await expect(handle.tickForTest()).resolves.toBeUndefined();
  });

  it("does not reconnect when shouldConnect returns false", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("disconnected");
    startKeepalive({ transport, alarms, shouldConnect: () => false });

    alarms.triggers[0]({ name: KEEPALIVE_ALARM_NAME });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(0);
  });

  it("reconnects when shouldConnect returns true", async () => {
    const alarms = makeAlarms();
    const transport = makeTransport("disconnected");
    let enabled = false;
    startKeepalive({ transport, alarms, shouldConnect: () => enabled });

    alarms.triggers[0]({ name: KEEPALIVE_ALARM_NAME });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(0);

    enabled = true;
    alarms.triggers[0]({ name: KEEPALIVE_ALARM_NAME });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
  });
});
