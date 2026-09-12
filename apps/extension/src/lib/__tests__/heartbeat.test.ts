import { describe, expect, it, vi } from "vitest";
import type { ProtocolFrame } from "@/transport/types";
import { HEARTBEAT_EVENT, HEARTBEAT_INTERVAL_MS, startHeartbeat } from "../heartbeat";

function makeTimers() {
  let nextId = 1;
  const intervals = new Map<number, { cb: () => void; ms: number }>();
  return {
    intervals,
    api: {
      setInterval: (cb: () => void, ms: number) => {
        const id = nextId++;
        intervals.set(id, { cb, ms });
        return id;
      },
      clearInterval: (id: number) => {
        intervals.delete(id);
      },
    },
    tick: (id: number) => intervals.get(id)?.cb(),
  };
}

/** Drives `onActiveChange` subscribers so a test can flip the link state. */
function makeActiveSource() {
  const listeners = new Set<(active: boolean) => void>();
  return {
    subscribe: (cb: (active: boolean) => void) => {
      // Mirror the controller contract: fire immediately with the current
      // value (starts inactive), then on every change.
      cb(false);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set: (active: boolean) => {
      for (const cb of listeners) cb(active);
    },
    listenerCount: () => listeners.size,
  };
}

describe("startHeartbeat", () => {
  it("does not beat while the link is inactive", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    const send = vi.fn();
    startHeartbeat({ send, onActiveChange: active.subscribe, timers: timers.api });

    expect(timers.intervals.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("starts a 20s interval on activation and sends heartbeat events", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    const send = vi.fn();
    startHeartbeat({ send, onActiveChange: active.subscribe, timers: timers.api });

    active.set(true);
    expect(timers.intervals.size).toBe(1);
    const [id, info] = [...timers.intervals.entries()][0];
    expect(info.ms).toBe(HEARTBEAT_INTERVAL_MS);

    timers.tick(id);
    expect(send).toHaveBeenCalledWith({ event: HEARTBEAT_EVENT, payload: {} });
  });

  it("stops beating when the link goes inactive", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    const send = vi.fn();
    startHeartbeat({ send, onActiveChange: active.subscribe, timers: timers.api });

    active.set(true);
    expect(timers.intervals.size).toBe(1);
    active.set(false);
    expect(timers.intervals.size).toBe(0);
  });

  it("does not stack intervals on repeated activation", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    startHeartbeat({ send: vi.fn(), onActiveChange: active.subscribe, timers: timers.api });

    active.set(true);
    active.set(true);
    expect(timers.intervals.size).toBe(1);
  });

  it("swallows send errors so the interval keeps running", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    const send = vi.fn(() => {
      throw new Error("socket closed");
    });
    const handle = startHeartbeat({ send, onActiveChange: active.subscribe, timers: timers.api });
    expect(() => handle.beatForTest()).not.toThrow();
  });

  it("dispose clears the interval and unsubscribes", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    const handle = startHeartbeat({
      send: vi.fn(),
      onActiveChange: active.subscribe,
      timers: timers.api,
    });
    active.set(true);
    expect(timers.intervals.size).toBe(1);

    handle.dispose();
    expect(timers.intervals.size).toBe(0);
    expect(active.listenerCount()).toBe(0);
  });

  it("sends a well-formed protocol frame", () => {
    const timers = makeTimers();
    const active = makeActiveSource();
    let captured: ProtocolFrame | null = null;
    const handle = startHeartbeat({
      send: (f) => {
        captured = f;
      },
      onActiveChange: active.subscribe,
      timers: timers.api,
    });
    handle.beatForTest();
    expect(captured).toEqual({ event: HEARTBEAT_EVENT, payload: {} });
  });
});
