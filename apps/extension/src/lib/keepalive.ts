/**
 * MV3 service-worker keepalive + transport supervisor.
 *
 * Address review M4/M5 C3 + C4: an MV3 service worker is evicted after
 * ~30s of no events. WebSocket I/O on its own does not keep the SW
 * alive, so an idle daemon connection eventually loses the SW, drops
 * the underlying socket, and the daemon then purges every session
 * bound to this browser. `WSTransport.scheduleReconnect` uses
 * `setTimeout` which also does not survive eviction.
 *
 * This module owns both halves of the mitigation:
 *  - A 30s `chrome.alarms` heartbeat that keeps the SW awake whenever
 *    we want the daemon link to stay live.
 *  - On each tick, if the transport is not connected, kick a fresh
 *    `connect()` so we never sit on a stale `disconnected` state just
 *    because the only `setTimeout` reconnect timer was lost.
 *
 * The alarm period is the minimum allowed by Chrome stable
 * (`periodInMinutes: 0.5` → 30s), which lines up with the documented
 * SW idle threshold.
 */

import type { Transport } from "@/transport/transport";

export const KEEPALIVE_ALARM_NAME = "bh-keepalive";
export const KEEPALIVE_PERIOD_MIN = 0.5; // 30s, the smallest Chrome accepts.

/** Subset of `chrome.alarms` we actually use; lets vitest inject a fake. */
export interface AlarmsApi {
  create(name: string, info: { periodInMinutes: number }): void;
  clear(name: string, cb?: (wasCleared: boolean) => void): void;
  onAlarm: {
    addListener(cb: (alarm: { name: string }) => void): void;
    removeListener(cb: (alarm: { name: string }) => void): void;
  };
}

function defaultAlarms(): AlarmsApi | null {
  if (typeof chrome === "undefined") return null;
  if (!chrome.alarms?.create || !chrome.alarms?.onAlarm) return null;
  return {
    create: (name, info) => chrome.alarms.create(name, info),
    clear: (name, cb) => {
      void chrome.alarms.clear(name).then((wasCleared) => cb?.(wasCleared));
    },
    onAlarm: {
      addListener: (cb) => chrome.alarms.onAlarm.addListener(cb),
      removeListener: (cb) => chrome.alarms.onAlarm.removeListener(cb),
    },
  };
}

export interface KeepaliveOptions {
  transport: Transport;
  /** When provided and returns false, skip reconnect attempts on alarm ticks. */
  shouldConnect?: () => boolean;
  alarms?: AlarmsApi;
  /** Override the alarm name (tests). */
  alarmName?: string;
  /** Override the alarm period (tests). */
  periodMin?: number;
}

export interface KeepaliveHandle {
  /** Detach the alarm listener and clear the alarm. */
  dispose(): void;
  /** Exposed for tests; simulates one alarm tick. */
  tickForTest(): Promise<void>;
}

/**
 * Install a SW-revival heartbeat that also forces an idle reconnect on
 * every tick. The heartbeat itself is the alarm callback firing —
 * which counts as activity and keeps the SW alive.
 */
export function startKeepalive(options: KeepaliveOptions): KeepaliveHandle {
  const alarms = options.alarms ?? defaultAlarms();
  const name = options.alarmName ?? KEEPALIVE_ALARM_NAME;
  const period = options.periodMin ?? KEEPALIVE_PERIOD_MIN;

  const tick = async () => {
    if (options.shouldConnect && !options.shouldConnect()) return;
    if (options.transport.state === "connected") return;
    try {
      await options.transport.connect();
    } catch (err) {
      console.debug("[bsk keepalive] connect attempt failed", err);
    }
  };

  if (!alarms) {
    // No chrome.alarms in this environment (e.g. unit tests that didn't
    // provide a fake). Disposing is a no-op.
    return {
      dispose: () => {},
      tickForTest: tick,
    };
  }

  const handler = (alarm: { name: string }) => {
    if (alarm.name !== name) return;
    void tick();
  };
  alarms.onAlarm.addListener(handler);
  alarms.create(name, { periodInMinutes: period });

  return {
    dispose: () => {
      alarms.onAlarm.removeListener(handler);
      alarms.clear(name);
    },
    tickForTest: tick,
  };
}
