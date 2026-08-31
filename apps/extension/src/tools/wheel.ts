import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { RpcError, WheelParams, WheelResult } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { resolveNodeGeometry } from "./frame-geometry";
import { modifiersBitfield, resolveBackendNode } from "./interaction";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface WheelDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
  /** Temporarily disable the Agent Window overlay's input blocker. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
}

interface WheelPoint {
  x: number;
  y: number;
  usedRef?: string;
  usedSelector?: string;
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  return defaultDeps;
}

export async function handleWheel(
  manager: SessionManager,
  params: WheelParams,
  deps: WheelDeps = getDefaultDeps(),
): Promise<WheelResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "wheel");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const deltaX = params.delta_x ?? 0;
  const deltaY = params.delta_y;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return { code: "invalid_params", message: "wheel deltas must be finite numbers" };
  }
  if (deltaX === 0 && deltaY === 0) {
    return { code: "invalid_params", message: "at least one wheel delta must be non-zero" };
  }
  if (deps.signal?.aborted) return cancelled();

  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "wheel");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
  deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);

  const point = await resolveWheelPoint(deps.cdp, ctx, target, params);
  if (isRpcError(point)) return point;
  if (deps.signal?.aborted) return cancelled();

  let bypassEnabled = false;
  if (deps.bypassOverlay) {
    try {
      await deps.bypassOverlay(target.tabId, true);
      bypassEnabled = true;
    } catch (error) {
      console.debug("[bsk wheel] overlay bypass enable failed", error);
    }
  }

  try {
    if (deps.signal?.aborted) return cancelled();
    const modifiers = modifiersBitfield(params.modifiers);
    await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      modifiers,
    });
    if (deps.signal?.aborted) return cancelled();
    await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
      modifiers,
    });
  } catch (error) {
    return {
      code: "cdp_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (bypassEnabled && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(target.tabId, false);
      } catch (error) {
        console.debug("[bsk wheel] overlay bypass disable failed", error);
      }
    }
  }

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    used_ref: point.usedRef,
    used_selector: point.usedSelector,
    x: point.x,
    y: point.y,
    delta_x: deltaX,
    delta_y: deltaY,
  });
}

async function resolveWheelPoint(
  cdp: CdpRunner,
  ctx: SessionContext,
  target: { tabId: number },
  params: WheelParams,
): Promise<WheelPoint | RpcError> {
  const hasRef = typeof params.ref === "string" && params.ref.length > 0;
  const hasSelector = typeof params.selector === "string" && params.selector.length > 0;
  if (hasRef || hasSelector) {
    const node = await resolveBackendNode(cdp, ctx, target, params, "wheel");
    if (isRpcError(node)) return node;
    const geometry = await resolveNodeGeometry(
      cdp,
      target.tabId,
      {
        target: node.cdpTarget,
        backendNodeId: node.backendNodeId,
        ...(node.frameId ? { frameId: node.frameId } : {}),
      },
      { scrollIntoView: true },
    );
    if (isRpcError(geometry)) return geometry;
    return {
      x: geometry.actionPoint.x,
      y: geometry.actionPoint.y,
      usedRef: node.usedRef,
      usedSelector: node.usedSelector,
    };
  }

  try {
    const metrics = await cdp.send<{
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(target.tabId, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return { code: "cdp_failed", message: "Page.getLayoutMetrics returned no viewport size" };
    }
    return { x: width / 2, y: height / 2 };
  } catch (error) {
    return {
      code: "cdp_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function cancelled(): RpcError {
  return { code: "cancelled", message: "wheel aborted" };
}
