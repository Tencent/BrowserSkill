import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import {
  type FrameDocumentGraph,
  type FrameDocumentHandle,
  type FrameNodeHandle,
  toRootFrameHandle,
} from "@/browser-driver/frame-handles";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { RpcError, WheelParams, WheelResult } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError, rpcError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import { clipPolygon, polygonArea, polygonCentroid, rectPolygon } from "./geometry";
import { type InputWindowsApi, waitForInputPaint, withInputReady } from "./input-readiness";
import { modifiersBitfield, resolveBackendNode } from "./interaction";
import { scrollVisibleBounds } from "./scroll-visibility";
import {
  type CdpRunner,
  type ChromeTabsApi,
  delegateCdpRunner,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToFrameHandle,
} from "./shared";

export interface WheelDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  windowsApi?: InputWindowsApi;
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

export async function handleWheel(
  manager: SessionManager,
  params: WheelParams,
  deps: WheelDeps,
): Promise<WheelResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "wheel");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const deltaX = params.delta_x === undefined ? 0 : params.delta_x;
  const deltaY = params.delta_y === undefined ? 0 : params.delta_y;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return { code: "invalid_params", message: "wheel deltas must be finite numbers" };
  }
  if (deltaX === 0 && deltaY === 0) {
    return { code: "invalid_params", message: "at least one wheel delta must be non-zero" };
  }
  const timeout = params.timeout_ms === undefined ? 30_000 : params.timeout_ms;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return { code: "invalid_params", message: "timeout_ms must be a positive integer" };
  }
  if (
    [params.ref, params.selector].some(
      (value) => value !== undefined && (typeof value !== "string" || !value.trim()),
    ) ||
    (params.ref !== undefined && params.selector !== undefined)
  ) {
    return { code: "invalid_params", message: "pass at most one nonempty ref or selector" };
  }
  if (
    params.modifiers !== undefined &&
    (!Array.isArray(params.modifiers) ||
      params.modifiers.some((value) => !["alt", "ctrl", "meta", "shift"].includes(value)))
  ) {
    return { code: "invalid_params", message: "invalid wheel modifiers" };
  }

  const deadline = Date.now() + timeout;
  const checkActive = () => {
    if (deps.signal?.aborted) throw new DOMException("wheel aborted", "AbortError");
    if (Date.now() >= deadline) throw new DOMException("wheel timed out", "TimeoutError");
  };
  // Guard the shared target/geometry helpers without changing other tools.
  // Own fallback scrolling and visibility objects, even if allocation is cancelled.
  const objectGroup = `bsk-wheel-${crypto.randomUUID()}`;
  const objectHandles = new Map<string, FrameDocumentHandle>();
  const sendFrame = async <T>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    args?: object,
    guard?: CdpDispatchGuard,
  ): Promise<T> => {
    checkActive();
    if (method === "DOM.resolveNode") {
      objectHandles.set(`${handle.tabId}:${handle.frameId}:${handle.loaderId}`, {
        tabId: handle.tabId,
        frameId: handle.frameId,
        loaderId: handle.loaderId,
        ...(handle.documentElementBackendNodeId !== undefined
          ? { documentElementBackendNodeId: handle.documentElementBackendNodeId }
          : {}),
      });
    }
    const result = await sendToFrameHandle<T>(
      deps.cdp,
      handle,
      method,
      method === "DOM.resolveNode" ? { ...args, objectGroup } : args,
      guard,
    );
    checkActive();
    return result;
  };
  let graph: Promise<FrameDocumentGraph> | undefined;
  const cdp: CdpRunner = delegateCdpRunner(deps.cdp, {
    resourceCleanup: deps.cdp.resourceCleanup ?? deps.cdp,
    send: <T>(tabId: number, method: string, args?: object, sig?: AbortSignal) =>
      sendFrame<T>(toRootFrameHandle(tabId), method, args, sig ? { signal: sig } : undefined),
    sendToFrame: sendFrame,
    ensureAttachedToUrl: async (tabId, expectedUrl) => {
      checkActive();
      await deps.cdp.ensureAttachedToUrl(tabId, expectedUrl);
      checkActive();
    },
    getMainFrameHandle: async (tabId, sig) => {
      checkActive();
      const result = await deps.cdp.getMainFrameHandle(tabId, sig);
      checkActive();
      return result;
    },
    getFrameDocuments: async (tabId, sig) => {
      checkActive();
      graph ??= deps.cdp.getFrameDocuments(tabId, sig);
      const result = await graph;
      checkActive();
      return result;
    },
  });
  let bypassTab: number | undefined;

  try {
    checkActive();
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    checkActive();
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "wheel");
    if (denied) return denied;
    // Reject stale refs before changing hidden-page focus or rendering state.
    if (params.ref) {
      const node = await resolveBackendNode(cdp, ctx, target, { ref: params.ref }, "wheel");
      if (isRpcError(node)) return node;
    }
    return await withInputReady(ctx, target.tabId, { ...deps, deadline }, async (input) => {
      const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
      cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
      const point = await resolveWheelPoint(cdp, ctx, target, params, deadline);
      checkActive();
      if (isRpcError(point)) return point;

      if (deps.bypassOverlay) {
        bypassTab = target.tabId;
        await deps.bypassOverlay(target.tabId, true);
      }
      const modifiers = modifiersBitfield(params.modifiers);
      await cdp.send(target.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        modifiers,
      });
      // markSent checks cancellation/deadline. Dispatch directly so a second
      // guard cannot reject between recording the attempt and sending the wheel.
      input.markSent();
      await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
        modifiers,
      });
      // Wheel acknowledgement precedes compositor scrolling. Keep the hidden renderer
      // awake until its resulting frame is available, then restore focus.
      if (input.hidden) await waitForInputPaint(cdp, target.tabId, deps.signal, deadline);
      checkActive();
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        used_ref: point.usedRef,
        used_selector: point.usedSelector,
        x: point.x,
        y: point.y,
        delta_x: deltaX,
        delta_y: deltaY,
      });
    });
  } catch (error) {
    if (deps.signal?.aborted) return { code: "cancelled", message: "wheel aborted" };
    if (Date.now() >= deadline) return { code: "timeout", message: "wheel timed out" };
    return cdpError(error);
  } finally {
    if (bypassTab !== undefined && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(bypassTab, false);
      } catch (error) {
        console.debug("[bsk wheel] overlay bypass disable failed", error);
      }
    }
    const cleanup = deps.cdp.resourceCleanup ?? deps.cdp;
    for (const handle of objectHandles.values()) {
      await sendToFrameHandle(
        cleanup,
        handle,
        "Runtime.releaseObjectGroup",
        { objectGroup },
        { allowReattach: false },
      ).catch(() => {});
    }
  }
}

async function resolveWheelPoint(
  cdp: CdpRunner,
  ctx: SessionContext,
  target: { tabId: number },
  params: WheelParams,
  deadline: number,
): Promise<WheelPoint | RpcError> {
  const hasRef = typeof params.ref === "string" && params.ref.length > 0;
  const hasSelector = typeof params.selector === "string" && params.selector.length > 0;
  if (hasRef || hasSelector) {
    const node = await resolveBackendNode(cdp, ctx, target, params, "wheel");
    if (isRpcError(node)) return node;
    const geometry = await resolveNodeGeometry(cdp, target.tabId, node.handle, {
      scrollIntoView: true,
    });
    if (isRpcError(geometry)) return geometry;
    const bounds = await scrollVisibleBounds(cdp, target.tabId, node.handle, deadline);
    const clip =
      bounds && rectPolygon({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height });
    const regions = clip
      ? geometry.topVisibleRegions.map((region) => clipPolygon(region, clip))
      : [];
    const visible = regions.sort((a, b) => polygonArea(b) - polygonArea(a))[0];
    const point = visible && polygonArea(visible) > 0 ? polygonCentroid(visible) : null;
    if (!point)
      return rpcError(
        "permission_denied",
        "element_not_visible",
        "wheel target has no visible area",
      );
    return {
      x: point.x,
      y: point.y,
      usedRef: node.usedRef,
      usedSelector: node.usedSelector,
    };
  }

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
}
