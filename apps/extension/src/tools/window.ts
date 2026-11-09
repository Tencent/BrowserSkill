// Window-tool handlers: `tool.window_resize` resizes the session's Agent Window.

import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import type { LayoutMetrics } from "./geometry/frame-context";
import { validateWindowSize } from "./session";
import {
  type CdpRunner,
  type ChromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

/** The cooperation controller binds the current observation's tab to the request. */
export interface WindowResizeParams {
  session_id: string;
  tab_id?: number;
  width: number;
  height: number;
}

export interface WindowResizeResult {
  window_id: number;
  width: number;
  height: number;
}

type Size = { width: number; height: number };
type WindowBounds = { width?: number; height?: number };
type Viewport = { size: Size; zoom: number };

// A retry at the same window size cannot prove that a previously stale viewport
// caught up. Remember that failure until the viewport or window actually changes.
const unconfirmed = new WeakMap<SessionContext, Map<number, { window: Size; viewport: Size }>>();

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

function clearUnconfirmed(ctx: SessionContext, tabId: number): void {
  unconfirmed.get(ctx)?.delete(tabId);
}

/** The browser can accept an update but constrain its resulting bounds. */
export interface WindowResizeApi {
  get(windowId: number): Promise<WindowBounds>;
  update(windowId: number, updateInfo: Size): Promise<unknown>;
}

export const chromeWindowResizeApi: WindowResizeApi = {
  get: (windowId) => chrome.windows.get(windowId),
  update: (windowId, updateInfo) => chrome.windows.update(windowId, updateInfo),
};

export interface WindowResizeDeps {
  windows: WindowResizeApi;
  tabs: ChromeTabsApi;
  cdp?: CdpRunner;
  /** Injectable so tests need not wait for the bounded settling interval. */
  wait?: (ms: number) => Promise<void>;
}

function size(bounds: WindowBounds): Size | undefined {
  const { width, height } = bounds;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? { width, height }
    : undefined;
}

async function viewport(cdp: CdpRunner, tabId: number): Promise<Viewport> {
  const metrics = await cdp.send<LayoutMetrics>(tabId, "Page.getLayoutMetrics", {});
  const measured = size({
    width: metrics.cssLayoutViewport?.clientWidth,
    height: metrics.cssLayoutViewport?.clientHeight,
  });
  if (!measured) throw new Error("the browser did not return a usable layout viewport");
  const zoom = metrics.cssVisualViewport?.zoom ?? metrics.visualViewport?.zoom;
  return {
    size: measured,
    zoom: typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
  };
}

function viewportFollowed(
  before: Viewport,
  after: Viewport,
  oldWindow: Size,
  newWindow: Size,
): boolean {
  // Window bounds use DIP; integer layout dimensions use zoomed CSS pixels.
  const roundingTolerance = Math.max(2, before.zoom, after.zoom);
  return (
    (Math.abs(newWindow.width - oldWindow.width) <= roundingTolerance ||
      before.size.width !== after.size.width) &&
    (Math.abs(newWindow.height - oldWindow.height) <= roundingTolerance ||
      before.size.height !== after.size.height)
  );
}

/**
 * Resize the outer window and verify both the resulting bounds and the target
 * tab's layout viewport. A background tab can retain an old viewport even
 * after Chrome accepts the window update; never activate it implicitly.
 */
export async function handleWindowResize(
  manager: SessionManager,
  params: WindowResizeParams,
  deps: WindowResizeDeps,
  signal?: AbortSignal,
): Promise<WindowResizeResult | RpcError> {
  if (signal?.aborted) return { code: "cancelled", message: "window_resize aborted" };
  const ctx = lookupSession(manager, params, "window_resize");
  if (isRpcError(ctx)) return ctx;
  const requested = validateWindowSize(params.width, params.height);
  if (isRpcError(requested)) return requested;
  if (!requested)
    return { code: "invalid_params", message: "window_resize requires width and height" };

  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabs);
  if (isRpcError(target)) return target;
  if (target.windowId !== ctx.agentWindowId || !isAgentControlledTab(ctx, target.tabId))
    return {
      code: "permission_denied",
      message: "window_resize requires a task tab in the session's Agent Window",
      data: { reason: "agent_window_scope", effect_state: "none" },
    };
  if (!target.active)
    return {
      code: "invalid_params",
      message: `Tab ${target.tabId} is inactive; its viewport may not follow a window resize.`,
      data: {
        reason: "window_resize_inactive_tab",
        effect_state: "none",
        tab_id: target.tabId,
        recovery: `Select tab ${target.tabId} in the Agent Window, synchronize, and retry the resize.`,
      },
    };
  if (!deps.cdp)
    return {
      code: "cdp_failed",
      message: "Cannot verify the target tab's viewport without a browser debugger.",
      data: { reason: "window_resize_unconfirmed", effect_state: "none" },
    };

  let beforeWindow: Size;
  let beforeViewport: Viewport;
  try {
    const bounds = size(await deps.windows.get(ctx.agentWindowId));
    if (!bounds) throw new Error("the browser did not return usable window bounds");
    beforeWindow = bounds;
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    beforeViewport = await viewport(deps.cdp, target.tabId);
  } catch (error) {
    if (signal?.aborted) return { code: "cancelled", message: "window_resize aborted" };
    return {
      code: "cdp_failed",
      message: `Cannot verify window resize: ${error instanceof Error ? error.message : String(error)}`,
      data: { reason: "window_resize_unconfirmed", effect_state: "none" },
    };
  }
  if (signal?.aborted) return { code: "cancelled", message: "window_resize aborted" };

  const previousFailure = unconfirmed.get(ctx)?.get(target.tabId);
  if (
    previousFailure &&
    sameSize(beforeWindow, requested) &&
    sameSize(previousFailure.window, beforeWindow) &&
    sameSize(previousFailure.viewport, beforeViewport.size)
  )
    return {
      code: "cdp_failed",
      message: `Tab ${target.tabId}'s viewport is still unchanged after the previous window resize.`,
      data: {
        reason: "window_resize_viewport_unchanged",
        effect_state: "none",
        tab_id: target.tabId,
        actual_window: beforeWindow,
        actual_viewport: beforeViewport.size,
        recovery:
          "Inspect the tab's visibility and viewport emulation before trying another resize.",
      },
    };

  let dispatched = false;
  try {
    const resize = () => {
      // If the browser applies the update but the reply or a later read fails,
      // a same-size retry must not mistake an unchanged viewport for success.
      if (!viewportFollowed(beforeViewport, beforeViewport, beforeWindow, requested)) {
        const tabs = unconfirmed.get(ctx) ?? new Map();
        tabs.set(target.tabId, { window: requested, viewport: beforeViewport.size });
        unconfirmed.set(ctx, tabs);
      } else {
        // Idempotent and rounding-only updates do not require a viewport change.
        clearUnconfirmed(ctx, target.tabId);
      }
      dispatched = true;
      return deps.windows.update(ctx.agentWindowId, requested);
    };
    await (deps.cdp.runBrowserMutation ? deps.cdp.runBrowserMutation(resize) : resize());
  } catch (error) {
    if (signal?.aborted)
      return {
        code: "cancelled",
        message: dispatched
          ? "window_resize aborted after the window update"
          : "window_resize aborted",
        data: { effect_state: dispatched ? "unknown" : "none" },
      };
    return {
      code: "protocol_error",
      message: error instanceof Error ? error.message : String(error),
      data: { effect_state: dispatched ? "unknown" : "none" },
    };
  }

  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let actualWindow: Size | undefined;
  let actualViewport: Viewport | undefined;
  try {
    // Chrome can acknowledge the window update before the renderer processes it.
    for (let attempt = 0; attempt <= 20; attempt++) {
      if (signal?.aborted)
        return {
          code: "cancelled",
          message: "window_resize aborted after the window update",
          data: { effect_state: "unknown" },
        };
      const tab = await deps.tabs.get(target.tabId);
      if (manager.get(ctx.sessionId) !== ctx || tab.windowId !== ctx.agentWindowId || !tab.active)
        return {
          code: "cdp_failed",
          message: `Window update was sent, but tab ${target.tabId} is no longer active in the Agent Window.`,
          data: {
            reason: "window_resize_inactive_tab",
            effect_state: "unknown",
            tab_id: target.tabId,
            recovery:
              "Inspect the window and target tab, then synchronize before deciding what to do next.",
          },
        };
      actualWindow = size(await deps.windows.get(ctx.agentWindowId));
      if (!actualWindow) throw new Error("the browser did not return usable window bounds");
      actualViewport = await viewport(deps.cdp, target.tabId);
      if (
        actualWindow.width === requested.width &&
        actualWindow.height === requested.height &&
        viewportFollowed(beforeViewport, actualViewport, beforeWindow, actualWindow)
      ) {
        clearUnconfirmed(ctx, target.tabId);
        return { window_id: ctx.agentWindowId, ...actualWindow };
      }
      if (attempt < 20) await wait(50);
    }
  } catch (error) {
    if (signal?.aborted)
      return {
        code: "cancelled",
        message: "window_resize aborted after the window update",
        data: { effect_state: "unknown" },
      };
    return {
      code: "cdp_failed",
      message: `Window update was sent, but its result could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      data: {
        reason: "window_resize_unconfirmed",
        effect_state: "unknown",
        recovery:
          "Inspect the window and viewport, then synchronize before deciding what to do next.",
      },
    };
  }

  if (
    actualWindow &&
    actualViewport &&
    !viewportFollowed(beforeViewport, actualViewport, beforeWindow, actualWindow)
  ) {
    const tabs = unconfirmed.get(ctx) ?? new Map();
    tabs.set(target.tabId, { window: actualWindow, viewport: actualViewport.size });
    unconfirmed.set(ctx, tabs);
  }
  if (actualWindow?.width !== requested.width || actualWindow?.height !== requested.height)
    return {
      code: "protocol_error",
      message: `Window resize requested ${requested.width}x${requested.height}, but the browser reports ${actualWindow?.width ?? "?"}x${actualWindow?.height ?? "?"}.`,
      data: {
        reason: "window_resize_constrained",
        effect_state: "committed",
        requested,
        actual_window: actualWindow,
        actual_viewport: actualViewport?.size,
        recovery:
          "Inspect the actual window size; the browser or window manager may have constrained it.",
      },
    };
  return {
    code: "cdp_failed",
    message: `Window resized to ${actualWindow.width}x${actualWindow.height}, but tab ${target.tabId}'s viewport did not follow the change.`,
    data: {
      reason: "window_resize_viewport_unchanged",
      effect_state: "committed",
      tab_id: target.tabId,
      before_viewport: beforeViewport.size,
      actual_viewport: actualViewport?.size,
      actual_window: actualWindow,
      recovery:
        "Inspect the tab's visibility and viewport emulation, then synchronize before deciding what to do next.",
    },
  };
}
