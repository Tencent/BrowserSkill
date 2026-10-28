import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { RpcError, WheelParams, WheelResult } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError, rpcError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import { clipPolygon, polygonArea, polygonCentroid, rectPolygon } from "./geometry";
import { waitForInputPaint, withInputReady } from "./input-readiness";
import { modifiersBitfield, resolveBackendNode } from "./interaction";
import { scrollVisibleBounds } from "./scroll-visibility";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";
import { waitWithinInterval, wheelSchedule } from "./wheel-schedule";

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
  const events = params.events === undefined ? 1 : params.events;
  if (!Number.isInteger(events) || events < 1 || events > 200) {
    return { code: "invalid_params", message: "events must be an integer between 1 and 200" };
  }
  const intervalMs = params.interval_ms === undefined ? 0 : params.interval_ms;
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) {
    return { code: "invalid_params", message: "interval_ms must be an integer between 0 and 5000" };
  }
  const easing = params.easing === undefined ? "linear" : params.easing;
  if (easing !== "linear" && easing !== "ease_out") {
    return { code: "invalid_params", message: "easing must be linear or ease_out" };
  }

  const deadline = Date.now() + timeout;
  const checkActive = () => {
    if (deps.signal?.aborted) throw new DOMException("wheel aborted", "AbortError");
    if (Date.now() >= deadline) throw new DOMException("wheel timed out", "TimeoutError");
  };
  // Guard the shared target/geometry helpers without changing other tools.
  // Own fallback scrolling and visibility objects, even if allocation is cancelled.
  const objectGroup = `bsk-wheel-${crypto.randomUUID()}`;
  const objectTargets = new Map<string, CdpTarget>();
  const send = async <T>(target: CdpTarget, method: string, args?: object): Promise<T> => {
    checkActive();
    if (method === "DOM.resolveNode") objectTargets.set(cdpTargetKey(target), target);
    const result = await sendToCdpTarget<T>(
      deps.cdp,
      target,
      method,
      method === "DOM.resolveNode" ? { ...args, objectGroup } : args,
    );
    checkActive();
    return result;
  };
  let graph: ReturnType<NonNullable<CdpRunner["getFrameGraph"]>> | undefined;
  const cdp: CdpRunner = {
    send: (tabId, method, args) => send({ tabId }, method, args),
    sendToTarget: send,
    trackSessionTab: deps.cdp.trackSessionTab?.bind(deps.cdp),
    getFrameGraph: deps.cdp.getFrameGraph
      ? async (tabId) => {
          checkActive();
          graph ??= deps.cdp.getFrameGraph!(tabId);
          const result = await graph;
          checkActive();
          return result;
        }
      : undefined,
  };
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
      const schedule = wheelSchedule(deltaX, deltaY, events, easing);
      // markSent checks cancellation/deadline. Dispatch directly so a second
      // guard cannot reject between recording the attempt and sending the wheel.
      input.markSent();
      let dispatched = 0;
      let totalX = 0;
      let totalY = 0;
      let stopped: string | undefined;
      let stopError: { code: string; message: string } | undefined;
      for (let index = 0; index < schedule.length; index += 1) {
        if (index > 0 && intervalMs > 0) {
          const elapsed = await waitWithinInterval(intervalMs, deadline, deps.signal);
          if (!elapsed) {
            stopped = deps.signal?.aborted ? "cancelled" : "timeout";
            break;
          }
        }
        const [stepX, stepY] = schedule[index];
        try {
          checkActive();
          await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: point.x,
            y: point.y,
            deltaX: stepX,
            deltaY: stepY,
            modifiers,
          });
        } catch (error) {
          // Nothing reached the page yet: report the underlying cause instead of a
          // partial success that claims zero events.
          if (dispatched === 0) throw error;
          stopped = deps.signal?.aborted
            ? "cancelled"
            : Date.now() >= deadline
              ? "timeout"
              : "error";
          // Keep the cause beside the progress so a caller never mistakes this
          // event's failure for the outcome of the whole operation.
          if (stopped === "error") {
            const detail = isRpcError(error) ? error : cdpError(error);
            stopError = { code: detail.code, message: detail.message };
          }
          break;
        }
        dispatched += 1;
        totalX += stepX;
        totalY += stepY;
        // Wheel acknowledgement precedes compositor scrolling. Keep the hidden renderer
        // awake until its resulting frame is available, then restore focus. A paint that
        // cannot be confirmed propagates: the event was sent, so its outcome is unknown
        // and the operation must not continue as if it were complete.
        if (input.hidden) await waitForInputPaint(cdp, target.tabId, deps.signal, deadline);
      }
      // A stopped operation reports its progress instead of a late abort error;
      // only a fully dispatched operation re-checks cancellation here.
      if (stopped === undefined) checkActive();
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        used_ref: point.usedRef,
        used_selector: point.usedSelector,
        x: point.x,
        y: point.y,
        delta_x: deltaX,
        delta_y: deltaY,
        events: dispatched,
        total_delta_x: totalX,
        total_delta_y: totalY,
        ...(stopped === undefined ? {} : { stopped }),
        ...(stopError === undefined ? {} : { stop_error: stopError }),
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
    for (const target of objectTargets.values()) {
      await sendToCdpTarget(deps.cdp, target, "Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => {},
      );
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
    const bounds = await scrollVisibleBounds(
      cdp,
      target.tabId,
      { target: node.cdpTarget, backendNodeId: node.backendNodeId, frameId: node.frameId },
      deadline,
    );
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
