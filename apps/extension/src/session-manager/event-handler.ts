import { type AgentOverlayResetApi, chromeAgentOverlayResetApi } from "@/tools/tabs";
import type { Transport } from "@/transport/transport";
import type { EventFrame } from "@/transport/types";
import { isAgentControlledTab, type SessionContext, type SessionManager } from "./manager";
import { expectedTabMoves } from "./tab-moves";

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
  transport: Pick<Transport, "send">;
  windowEvents?: WindowRemovedListener;
  tabEvents?: {
    [K in "onDetached" | "onAttached" | "onRemoved"]: Pick<
      (typeof chrome.tabs)[K],
      "addListener" | "removeListener"
    >;
  };
  agentOverlayReset?: AgentOverlayResetApi;
  /** Runs synchronously after ownership is removed, before renderer/CDP cleanup. */
  onSessionReleased?: (session: SessionContext) => void;
  cdp?: {
    detachSession(sessionId: string): Promise<void>;
    releaseSessionTab?(sessionId: string, tabId: number): Promise<void>;
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
  const tabs = options.tabEvents ?? globalThis.chrome?.tabs;

  const onDetached = (tabId: number, info: chrome.tabs.TabDetachInfo): void => {
    const expected = expectedTabMoves.onDetached(tabId, info.oldWindowId);
    const ctx = manager.findByWindowId(info.oldWindowId);
    if (!ctx || !isAgentControlledTab(ctx, tabId)) return;
    // Capture before cooperation's detach handler can release this page's claim.
    const ownedTabs = new Set([
      ...ctx.agentCreatedTabs,
      ...ctx.borrowedTabs.keys(),
      ...(ctx.observedTabs ?? []),
    ]);
    const end = () => {
      if (manager.get(ctx.sessionId) !== ctx) return;
      manager.release(ctx.sessionId);
      ctx.refStore.clear();
      // Publish the reason before cancellation replies can overtake it.
      try {
        transport.send({
          event: "session.ended",
          payload: { session_id: ctx.sessionId, reason: "user_moved_tab", tab_id: tabId },
        });
      } catch (error) {
        console.debug("[bsk] could not report moved task tab", error);
      }
      try {
        options.onSessionReleased?.(ctx);
      } catch (error) {
        console.debug("[bsk] session release callback failed", error);
      }
      try {
        onSessionsChanged?.();
      } catch (error) {
        console.debug("[bsk] released session display refresh failed", error);
      }
      // A user move releases the entire task. Never close or return any of its
      // pages: more tabs from the same group may still be crossing windows.
      const reset = options.agentOverlayReset ?? chromeAgentOverlayResetApi;
      for (const id of ownedTabs) {
        void reset.resetAgentOverlays(id, ctx.sessionId).catch((error) => {
          console.debug("[bsk] released tab overlay reset failed", error);
        });
        // A first reader can still be attaching before it records its CDP
        // owner. Release the known task pages too, using the driver's pending
        // attachment fence and its protection for another session's owner.
        void options.cdp?.releaseSessionTab?.(ctx.sessionId, id).catch((error) => {
          console.debug("[bsk] released tab CDP cleanup failed", error);
        });
      }
      void options.cdp?.detachSession(ctx.sessionId).catch((error) => {
        console.debug("[bsk] released session CDP cleanup failed", error);
      });
    };
    if (typeof expected === "boolean") {
      if (!expected) end();
    } else {
      void expected.then((movedByUs) => {
        if (!movedByUs) end();
      });
    }
  };
  const onAttached = (tabId: number, info: chrome.tabs.TabAttachInfo) =>
    expectedTabMoves.onAttached(tabId, info.newWindowId);
  const onTabRemoved = (tabId: number) => expectedTabMoves.forget(tabId);

  const onRemoved = (windowId: number): void => {
    const ctx = manager.findByWindowId(windowId);
    if (!ctx) return;
    // Chrome also emits onRemoved when session.stop removes the last tab or
    // the window itself. Capture the cause before asynchronous cleanup so the
    // normal stop response, rather than a user-close event, ends the audit.
    const expectedClose = manager.isWindowCloseExpected(ctx);
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
        if (expectedClose) return;
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
  tabs?.onDetached.addListener(onDetached);
  tabs?.onAttached.addListener(onAttached);
  tabs?.onRemoved.addListener(onTabRemoved);
  return {
    dispose: () => {
      events.removeListener(onRemoved);
      tabs?.onDetached.removeListener(onDetached);
      tabs?.onAttached.removeListener(onAttached);
      tabs?.onRemoved.removeListener(onTabRemoved);
    },
  };
}
