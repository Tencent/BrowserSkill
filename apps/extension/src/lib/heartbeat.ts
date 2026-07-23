/**
 * Application-level WebSocket heartbeat.
 *
 * Since Chrome 116, sending or receiving a message over a WebSocket
 * resets the MV3 service-worker idle timer (see
 * https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).
 * By emitting a tiny `system.heartbeat` event every 20s — comfortably
 * inside the 30s idle window — we keep the worker (and therefore the
 * daemon link) alive for as long as the connection is up, instead of
 * relying solely on the 30s keepalive alarm that sits right on the
 * eviction boundary.
 *
 * The daemon also treats the heartbeat as a liveness signal, so a
 * silently-dead browser can be reaped on its side.
 *
 * The heartbeat only runs while the *post-handshake* link is live: the
 * daemon rejects any first frame that is not `system.handshake`, so
 * beating before the handshake completes would get the connection
 * kicked. Callers wire {@link HeartbeatOptions.onActiveChange} to the
 * connection controller, which only reports `connected` / `version_skew`
 * after the handshake has landed.
 */

import type { ProtocolFrame } from "@/transport/types";

export const HEARTBEAT_EVENT = "system.heartbeat";
/** 20s: the interval Chrome's own WebSocket keepalive sample recommends. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** Subset of the timer API we use; lets tests inject fakes. */
export interface HeartbeatTimers {
  setInterval(cb: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export interface HeartbeatOptions {
  /** Send a frame over the live transport. */
  send: (frame: ProtocolFrame) => void;
  /**
   * Subscribe to "is the post-handshake link live" changes. Must invoke
   * the callback with the current value immediately and again on every
   * transition, and return an unsubscribe function.
   */
  onActiveChange: (cb: (active: boolean) => void) => () => void;
  /** Override the beat interval (tests). */
  intervalMs?: number;
  /** Inject fake timers (tests). */
  timers?: HeartbeatTimers;
}

export interface HeartbeatHandle {
  /** Stop beating and detach the active-state listener. */
  dispose(): void;
  /** Test hook: emit one heartbeat frame right now. */
  beatForTest(): void;
}

function defaultTimers(): HeartbeatTimers {
  return {
    setInterval: (cb, ms) => setInterval(cb, ms) as unknown as number,
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * Start a heartbeat that beats every `intervalMs` while the link is
 * active and pauses entirely while it is not.
 */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timers = options.timers ?? defaultTimers();
  let timer: number | null = null;

  const beat = () => {
    try {
      options.send({ event: HEARTBEAT_EVENT, payload: {} });
    } catch (err) {
      // The socket raced a close between the state change and this
      // tick. The transport's own reconnect path recovers; swallow so
      // the interval keeps running (it is cleared on the disconnect
      // notification anyway).
      console.debug("[bsk heartbeat] send failed", err);
    }
  };

  const stop = () => {
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };

  const start = () => {
    if (timer !== null) return;
    timer = timers.setInterval(beat, intervalMs);
  };

  const unsubscribe = options.onActiveChange((active) => {
    if (active) start();
    else stop();
  });

  return {
    dispose: () => {
      unsubscribe();
      stop();
    },
    beatForTest: beat,
  };
}
