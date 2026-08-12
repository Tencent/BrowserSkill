import type { Transport } from "@/transport/transport";
import type { EventFrame } from "@/transport/types";
import type { SessionManager } from "./manager";

/**
 * Listener interface that mirrors `chrome.windows.onRemoved` so vitest
 * can drive the handler without a real Chrome runtime.
 */
export interface WindowRemovedListener {
  addListener(cb: (windowId: number) => void): void;
  removeListener(cb: (windowId: number) => void): void;
}

export interface SessionEventHandlerOptions {
  manager: SessionManager;
  transport: Transport;
  windowEvents?: WindowRemovedListener;
  cdp?: {
    detachSession(sessionId: string): Promise<void>;
  };
  /**
   * Invoked after a user-closed Agent Window has been removed from the
   * SessionManager. Lets the caller refresh side caches such as the
   * `chrome.storage.session` "sessions live" flag (review M4/M5 I3).
   */
  onSessionsChanged?: () => void;
}

function chromeWindowEvents(): WindowRemovedListener {
  return {
    addListener: (cb) => chrome.windows.onRemoved.addListener(cb),
    removeListener: (cb) => chrome.windows.onRemoved.removeListener(cb),
  };
}

/**
 * Watch for the user closing an Agent Window. When that happens we:
 *  1. Drop the local SessionContext (without trying to close the window
 *     again — it's already gone).
 *  2. Emit a `session.window_closed` event to the daemon so it can
 *     remove the session from its registry too.
 *
 * Returns a disposer that detaches the listener (used in tests).
 */
export function attachSessionEventHandler(options: SessionEventHandlerOptions): {
  dispose: () => void;
} {
  const { manager, transport, onSessionsChanged } = options;
  const events = options.windowEvents ?? chromeWindowEvents();

  const onRemoved = (windowId: number): void => {
    const ctx = manager.findByWindowId(windowId);
    if (!ctx) return;
    const returnFailures = Array.from(ctx.borrowedTabs.keys()).map((tabId) => ({
      tab_id: tabId,
      code: "cdp_failed",
      message: "Agent Window was closed before borrowed tab could be returned",
    }));
    if (returnFailures.length > 0) {
      console.warn(
        `[bh] Agent Window ${windowId} closed with borrowed tabs that could not be returned`,
        returnFailures,
      );
    }
    const detach = options.cdp
      ? options.cdp.detachSession(ctx.sessionId).catch((err) => {
          console.debug("[bh] session-event cdp detach failed", err);
        })
      : Promise.resolve();
    void detach
      .then(() => manager.stop(ctx.sessionId, { dropOnly: true }))
      .then(() => {
        onSessionsChanged?.();
        const event: EventFrame = {
          event: "session.window_closed",
          payload: {
            session_id: ctx.sessionId,
            reason: "user_closed_window",
            ...(returnFailures.length > 0 ? { return_failures: returnFailures } : {}),
          },
        };
        try {
          transport.send(event);
        } catch (err) {
          console.warn("[bh] could not push session.window_closed event", err);
        }
      })
      .catch((err) => {
        console.warn("[bh] session-event handler failed", err);
      });
  };

  events.addListener(onRemoved);
  return {
    dispose: () => events.removeListener(onRemoved),
  };
}
